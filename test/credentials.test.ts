import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readDecisionCredentials,
	readJevCredentials,
	readOpenRouterCredentials,
	readTextHelperModel,
} from "../src/credentials.ts";

test("credential file handles JSON syntax, precedence, reloads and missing keys", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-credentials-"));
	const path = join(directory, "config.json");
	try {
		assert.throws(() => readJevCredentials({ path, env: {} }), /TYPESAFE_API_KEY/);
		writeFileSync(
			path,
			JSON.stringify({
				typesafe: {
					apiKey: "file-test-key",
					baseUrl: "https://typesafe.example.test",
					model: "jev-preview",
				},
				textHelper: { model: "anthropic/claude-haiku-4" },
			}),
			{ mode: 0o600 },
		);
		assert.deepEqual(readJevCredentials({ path, env: {} }), {
			apiKey: "file-test-key",
			baseUrl: "https://typesafe.example.test",
			model: "jev-preview",
		});
		assert.equal(readTextHelperModel({ path, env: {} }), "anthropic/claude-haiku-4");
		assert.deepEqual(
			readJevCredentials({
				path,
				env: {
					TYPESAFE_API_KEY: "env-test-key",
					TYPESAFE_BASE_URL: "https://env.example.test",
					TYPESAFE_DEFAULT_MODEL: "jev-1.13.0",
				},
			}),
			{
				apiKey: "env-test-key",
				baseUrl: "https://env.example.test",
				model: "jev-1.13.0",
			},
		);
		assert.equal(
			readJevCredentials({ path, env: { TYPESAFE_API_KEY: "  " } }).apiKey,
			"file-test-key",
		);
		assert.equal(
			readTextHelperModel({ path, env: { PI_JEV_BROWSER_TEXT_MODEL: "openai/gpt-5" } }),
			"openai/gpt-5",
		);
		writeFileSync(
			path,
			JSON.stringify({ typesafe: { apiKey: "changed-test-key" } }),
		);
		assert.equal(
			readJevCredentials({ path, env: {} }).apiKey,
			"changed-test-key",
		);
		assert.deepEqual(readJevCredentials({ path, env: {} }), {
			apiKey: "changed-test-key",
			baseUrl: "https://api.typesafe.ai",
			model: "jev-latest",
		});
		assert.equal(readTextHelperModel({ path, env: {} }), undefined);
		writeFileSync(path, "{}");
		assert.throws(() => readJevCredentials({ path, env: {} }), /TYPESAFE_API_KEY/);
		writeFileSync(path, "{invalid");
		assert.throws(() => readJevCredentials({ path, env: {} }), /is not valid JSON/);
		assert.throws(
			() => readJevCredentials({ path: directory, env: {} }),
			/Cannot read/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("OpenRouter credentials read from config and environment, and win when both providers are configured", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-openrouter-"));
	const path = join(directory, "config.json");
	try {
		assert.throws(
			() => readOpenRouterCredentials({ path, env: {} }),
			/OPENROUTER_API_KEY/,
		);
		writeFileSync(
			path,
			JSON.stringify({
				openrouter: {
					apiKey: "or-file-key",
					model: "typesafe/jev-1.13",
				},
				typesafe: { apiKey: "ts-file-key", model: "jev-latest" },
			}),
			{ mode: 0o600 },
		);
		assert.deepEqual(readOpenRouterCredentials({ path, env: {} }), {
			provider: "openrouter",
			apiKey: "or-file-key",
			baseUrl: "https://openrouter.ai/api",
			model: "typesafe/jev-1.13",
		});
		assert.deepEqual(readDecisionCredentials({ path, env: {} }), {
			provider: "openrouter",
			apiKey: "or-file-key",
			baseUrl: "https://openrouter.ai/api",
			model: "typesafe/jev-1.13",
		});
		assert.deepEqual(
			readDecisionCredentials({
				path,
				env: {
					OPENROUTER_API_KEY: "env-or",
					OPENROUTER_BASE_URL: "https://or.example.test",
					OPENROUTER_DEFAULT_MODEL: "typesafe/jev-1.12",
				},
			}),
			{
				provider: "openrouter",
				apiKey: "env-or",
				baseUrl: "https://or.example.test",
				model: "typesafe/jev-1.12",
			},
		);
		// Without an OpenRouter key anywhere, the TypeSafe path wins and its error
		// message names both providers.
		writeFileSync(path, JSON.stringify({ typesafe: { apiKey: "ts-only" } }));
		assert.deepEqual(readDecisionCredentials({ path, env: {} }), {
			provider: "typesafe",
			apiKey: "ts-only",
			baseUrl: "https://api.typesafe.ai",
			model: "jev-latest",
		});
		// Neither provider configured: the failure names TYPESAFE_API_KEY.
		writeFileSync(path, "{}");
		assert.throws(
			() => readDecisionCredentials({ path, env: {} }),
			/TYPESAFE_API_KEY/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
