import type {
	Fetch,
	Questions,
	SystemOneRequest,
	SystemOneResult,
} from "@typesafe-ai/sdk";
import type { JevCredentials } from "./credentials.ts";

/**
 * The decision surface the Jev loop consumes. TypeSafeClient satisfies it, the
 * OpenRouter client below satisfies it, and tests stub it, so the policy layer
 * never knows which provider answered.
 */
export interface JevClient {
	systemOne<Q extends Questions>(
		request: SystemOneRequest<Q>,
		options?: { signal?: AbortSignal },
	): Promise<SystemOneResult<Q>>;
}

/**
 * OpenRouter serves Jev (TypeSafe System One) on a dedicated decisions
 * endpoint, not chat completions. It is a passthrough for TypeSafe's native
 * schema: same `{ model, state, questions }` body in, same typed `answers` out.
 */
const DECISIONS_PATH = "/alpha/decisions";
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 5_000;

function backoffMs(attempt: number, retryAfterSeconds: number | undefined) {
	if (retryAfterSeconds !== undefined && retryAfterSeconds > 0)
		return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
	return Math.min(2 ** attempt * 250, MAX_BACKOFF_MS);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new Error("Request aborted."));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new Error("Request aborted."));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function retryAfterSeconds(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function responseMessage(response: Response): Promise<string> {
	try {
		const json = (await response.json()) as { error?: { message?: unknown } };
		if (typeof json.error?.message === "string" && json.error.message)
			return `${response.status}: ${json.error.message}`;
	} catch {
		// Not JSON; fall through to the body text.
	}
	const text = await response.text().catch(() => "");
	return text
		? `${response.status}: ${text.slice(0, 200)}`
		: String(response.status);
}

/**
 * A thin transport for OpenRouter's decisions endpoint, shaped like the
 * TypeSafe SDK's systemOne so the policy layer can call either provider.
 * Timeout and retry policy match the TypeSafe client: one decision in one
 * round trip, two retries on transport/5xx/429, backoff capped at 5s.
 */
export function createOpenRouterClient(
	credentials: JevCredentials,
	options: { fetch?: Fetch; headers?: Record<string, string> } = {},
): JevClient {
	const fetchImpl: Fetch = options.fetch ?? (globalThis.fetch as Fetch);
	const baseUrl = credentials.baseUrl.replace(/\/+$/, "");
	return {
		async systemOne<Q extends Questions>(
			request: SystemOneRequest<Q>,
			callOptions?: { signal?: AbortSignal },
		) {
			const body = {
				model: request.model ?? credentials.model,
				state: request.state,
				questions: request.questions,
			};
			let lastError: unknown;
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				const controller = new AbortController();
				const abortFromCaller = () => controller.abort();
				callOptions?.signal?.addEventListener("abort", abortFromCaller, {
					once: true,
				});
				const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
				let response: Response | undefined;
				let error: unknown;
				try {
					response = await fetchImpl(`${baseUrl}${DECISIONS_PATH}`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${credentials.apiKey}`,
							"Content-Type": "application/json",
							...options.headers,
						},
						body: JSON.stringify(body),
						signal: controller.signal,
					});
				} catch (caused) {
					error = caused;
				} finally {
					clearTimeout(timer);
					callOptions?.signal?.removeEventListener("abort", abortFromCaller);
				}
				if (error !== undefined) {
					// The caller cancelled, not a transport failure: propagate as-is.
					if (callOptions?.signal?.aborted) throw error;
					lastError = error;
					if (attempt < MAX_RETRIES) {
						await delay(backoffMs(attempt, undefined), callOptions?.signal);
						continue;
					}
					throw error instanceof Error ? error : new Error(String(error));
				}
				if (response!.ok) {
					const json = (await response!.json()) as {
						answers?: unknown;
						model?: unknown;
						usage?: unknown;
					};
					if (typeof json.answers !== "object" || json.answers === null)
						throw new Error("OpenRouter decisions returned no answers.");
					// OpenRouter answers match TypeSafe's typed responses; the
					// policy layer validates shape and offered choices downstream.
					return {
						model: typeof json.model === "string" ? json.model : body.model,
						answers: json.answers,
						usage:
							typeof json.usage === "object" && json.usage !== null
								? json.usage
								: { input_tokens: 0, output_tokens: 0 },
					} as unknown as SystemOneResult<Q>;
				}
				const retryable =
					response!.status === 429 || response!.status >= 500;
				lastError = new Error(
					`OpenRouter decisions request failed (${await responseMessage(response!)}).`,
				);
				if (retryable && attempt < MAX_RETRIES) {
					await delay(
						backoffMs(attempt, retryAfterSeconds(response!)),
						callOptions?.signal,
					);
					continue;
				}
				throw lastError;
			}
			throw lastError instanceof Error ? lastError : new Error(String(lastError));
		},
	};
}