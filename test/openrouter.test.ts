import assert from "node:assert/strict";
import test from "node:test";
import type { Questions } from "@typesafe-ai/sdk";
import { createOpenRouterClient } from "../src/openrouter.ts";

const credentials = {
	apiKey: "or-test-key",
	baseUrl: "https://openrouter.example.test/api",
	model: "typesafe/jev-1.13",
};

const questions = {
	action: {
		type: "choice" as const,
		instructions: "Choose one.",
		criteria: {
			WAIT: "Wait for loading.",
			DONE: "Current evidence proves the goal.",
		},
	},
} satisfies Questions;

test("OpenRouter client posts the native systemOne payload to /alpha/decisions and parses answers", async () => {
	let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
	const client = createOpenRouterClient(credentials, {
		fetch: async (input, init) => {
			captured = {
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			};
			return Response.json({
				model: "typesafe/jev-1.13-20260917",
				answers: {
					action: {
						type: "choice",
						choice: "WAIT",
						confidence: 0.9,
						probabilities: { WAIT: 0.9, DONE: 0.1 },
					},
				},
				usage: { input_tokens: 123, output_tokens: 4, cost: 5.2e-6 },
				provider: "TypeSafe",
			});
		},
	});
	const result = await client.systemOne({
		state: "current page",
		questions,
	});
	assert.equal(captured?.url, "https://openrouter.example.test/api/alpha/decisions");
	assert.equal(captured?.headers.get("authorization"), "Bearer or-test-key");
	assert.equal(captured?.headers.get("content-type"), "application/json");
	assert.deepEqual(captured?.body, {
		model: "typesafe/jev-1.13",
		state: "current page",
		questions,
	});
	assert.equal(result.model, "typesafe/jev-1.13-20260917");
	assert.equal(result.answers.action.choice, "WAIT");
	assert.equal(result.answers.action.confidence, 0.9);
	assert.deepEqual(result.usage, {
		input_tokens: 123,
		output_tokens: 4,
		cost: 5.2e-6,
	});
});

test("a per-call model override wins over the configured model", async () => {
	let body: Record<string, unknown> | undefined;
	const client = createOpenRouterClient(credentials, {
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({
				model: "typesafe/jev-1.12",
				answers: { action: { type: "choice", choice: "DONE", confidence: 1, probabilities: { DONE: 1 } } },
			});
		},
	});
	await client.systemOne({ state: "s", model: "typesafe/jev-1.12", questions });
	assert.equal(body?.model, "typesafe/jev-1.12");
});

test("transient failures are retried, and a 4xx is thrown with the upstream message", async () => {
	let calls = 0;
	const client = createOpenRouterClient(credentials, {
		fetch: async (_input, init) => {
			calls++;
			if (calls === 1)
				return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
			return Response.json({
				model: "typesafe/jev-1.13",
				answers: { action: { type: "choice", choice: "DONE", confidence: 1, probabilities: { DONE: 1 } } },
			});
		},
	});
	const result = await client.systemOne({ state: "s", questions });
	assert.equal(calls, 2, "one retry after the 429");
	assert.equal(result.answers.action.choice, "DONE");

	const rejected = createOpenRouterClient(credentials, {
		fetch: async () =>
			Response.json(
				{
					error: {
						message:
							"typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint.",
					},
				},
				{ status: 400 },
			),
	});
	await assert.rejects(
		rejected.systemOne({ state: "s", questions }),
		/400: is a decisions model and cannot be used with the chat\/completions endpoint/,
	);
});

test("a 5xx exhausts retries and surfaces the status", async () => {
	const client = createOpenRouterClient(credentials, {
		fetch: async () => new Response("upstream exploded", { status: 503 }),
	});
	await assert.rejects(
		client.systemOne({ state: "s", questions }),
		/503: upstream exploded/,
	);
});

test("caller abort propagates and a missing answers object fails loudly", async () => {
	const controller = new AbortController();
	const aborted = createOpenRouterClient(credentials, {
		fetch: async () => {
			controller.abort();
			throw new Error("fetch aborted");
		},
	});
	await assert.rejects(
		aborted.systemOne({ state: "s", questions }, { signal: controller.signal }),
		/fetch aborted/,
	);

	const empty = createOpenRouterClient(credentials, {
		fetch: async () => Response.json({ model: "typesafe/jev-1.13" }),
	});
	await assert.rejects(
		empty.systemOne({ state: "s", questions }),
		/returned no answers/,
	);
});