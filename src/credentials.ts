import { CONFIG_PATH, readConfigFile } from "./config.ts";
import { configurationError } from "./errors.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api";
const OPENROUTER_DEFAULT_MODEL = "typesafe/jev-1.13";

export interface JevCredentials {
	apiKey: string;
	baseUrl: string;
	model: string;
}

/**
 * Credentials plus the provider they address. `readDecisionCredentials`
 * always sets `provider`; plain `JevCredentials` from the legacy TypeSafe
 * reader are treated as `"typesafe"` by the policy layer.
 */
export interface DecisionCredentials extends JevCredentials {
	provider: "typesafe" | "openrouter";
}

/**
 * Read per run without mutating process.env or exposing credentials to Chromium.
 * Precedence: environment, then the JSON configuration file.
 */
export function readJevCredentials(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): JevCredentials {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const typesafe = raw.typesafe as
		| { apiKey?: unknown; baseUrl?: unknown; model?: unknown }
		| undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";

	const apiKey = value(env.TYPESAFE_API_KEY) || value(typesafe?.apiKey);
	if (!apiKey)
		throw configurationError(
			`The jev_run Jev loop requires TYPESAFE_API_KEY (or OPENROUTER_API_KEY) in the pi process environment, or typesafe.apiKey (or openrouter.apiKey) in ${path}.`,
		);

	return {
		apiKey,
		baseUrl:
			value(env.TYPESAFE_BASE_URL) || value(typesafe?.baseUrl) || DEFAULT_BASE_URL,
		model:
			value(env.TYPESAFE_DEFAULT_MODEL) ||
			value(typesafe?.model) ||
			DEFAULT_MODEL,
	};
}

/**
 * OpenRouter serves Jev (TypeSafe System One) on its own decisions endpoint,
 * not chat completions: `POST {baseUrl}/alpha/decisions` with TypeSafe's
 * native `{ model, state, questions }` payload. Reads `OPENROUTER_API_KEY`,
 * `OPENROUTER_BASE_URL` and `OPENROUTER_DEFAULT_MODEL`, or the `openrouter`
 * config block; precedence is environment, then config, then defaults.
 */
export function readOpenRouterCredentials(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): DecisionCredentials {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const openrouter = raw.openrouter as
		| { apiKey?: unknown; baseUrl?: unknown; model?: unknown }
		| undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";

	const apiKey = value(env.OPENROUTER_API_KEY) || value(openrouter?.apiKey);
	if (!apiKey)
		throw configurationError(
			`The jev_run Jev loop requires OPENROUTER_API_KEY in the pi process environment or openrouter.apiKey in ${path}.`,
		);

	return {
		provider: "openrouter",
		apiKey,
		baseUrl:
			value(env.OPENROUTER_BASE_URL) ||
			value(openrouter?.baseUrl) ||
			OPENROUTER_DEFAULT_BASE_URL,
		model:
			value(env.OPENROUTER_DEFAULT_MODEL) ||
			value(openrouter?.model) ||
			OPENROUTER_DEFAULT_MODEL,
	};
}

/**
 * Pick the decision provider for a run: OpenRouter when it is configured
 * (environment or config), otherwise TypeSafe. OpenRouter wins when both are
 * present; the TypeSafe path stays for existing installs that never set an
 * OpenRouter key.
 */
export function readDecisionCredentials(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): DecisionCredentials {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";
	const openrouter = raw.openrouter as { apiKey?: unknown } | undefined;
	if (value(env.OPENROUTER_API_KEY) || value(openrouter?.apiKey))
		return readOpenRouterCredentials({ path, env });
	return { provider: "typesafe", ...readJevCredentials({ path, env }) };
}

/** Optional override for the pi model that generates field text. */
export function readTextHelperModel(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const textHelper = raw.textHelper as { model?: unknown } | undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";
	return value(env.PI_JEV_BROWSER_TEXT_MODEL) || value(textHelper?.model) || undefined;
}