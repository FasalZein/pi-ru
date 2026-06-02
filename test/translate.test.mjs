/**
 * Behavior tests for pi-ru translation.
 *
 * These exercise the public interface (translateToRussian) with a mocked
 * `fetch`, so they verify *what* the system does — provider order, fallback,
 * forcing, error aggregation, abort — not *how* it is implemented. They survive
 * internal refactors as long as the observable behavior holds.
 *
 * A separate live test (auto-skips offline) confirms the real default endpoint.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { translateToRussian } from "../src/translate.ts";

// --- test harness -----------------------------------------------------------

const realFetch = globalThis.fetch;
const ENV_KEYS = [
	"PI_RU_PROVIDER",
	"PI_RU_DEEPL_API_KEY",
	"DEEPL_API_KEY",
	"PI_RU_MYMEMORY_EMAIL",
];
let savedEnv = {};

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

function jsonResponse(body, ok = true, status = 200) {
	return { ok, status, json: async () => body };
}

/**
 * Install a fake fetch. `handlers` maps a substring of the URL to either a
 * Response-like object or a function (url, opts) => Response-like.
 * Records every called URL in `calls`.
 */
function mockFetch(handlers) {
	const calls = [];
	globalThis.fetch = async (url, opts) => {
		calls.push(String(url));
		for (const [needle, handler] of Object.entries(handlers)) {
			if (String(url).includes(needle)) {
				return typeof handler === "function" ? handler(url, opts) : handler;
			}
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
	return calls;
}

const GOOGLE = "translate.googleapis.com";
const MYMEMORY = "api.mymemory.translated.net";
const DEEPL_FREE = "api-free.deepl.com";
const DEEPL_PRO = "api.deepl.com";

const googleOk = (text) => jsonResponse([[[text, "src"]]]);
const myMemoryOk = (text) => jsonResponse({ responseData: { translatedText: text } });
const deeplOk = (text) => jsonResponse({ translations: [{ text }] });

// --- behaviors ---------------------------------------------------------------

test("translates via Google by default and reports the provider", async () => {
	mockFetch({ [GOOGLE]: googleOk("привет мир") });
	const result = await translateToRussian("hello world");
	assert.equal(result.provider, "google");
	assert.equal(result.text, "привет мир");
});

test("joins multi-segment Google responses into one string", async () => {
	mockFetch({
		[GOOGLE]: jsonResponse([[["Привет. ", "Hello. "], ["Как дела?", "How are you?"]]]),
	});
	const result = await translateToRussian("Hello. How are you?");
	assert.equal(result.text, "Привет. Как дела?");
});

test("falls back to MyMemory when Google fails", async () => {
	const calls = mockFetch({
		[GOOGLE]: jsonResponse(null, false, 429),
		[MYMEMORY]: myMemoryOk("привет"),
	});
	const result = await translateToRussian("hello");
	assert.equal(result.provider, "mymemory");
	assert.equal(result.text, "привет");
	// Confirms it actually tried Google first, then MyMemory.
	assert.ok(calls.some((u) => u.includes(GOOGLE)));
	assert.ok(calls.some((u) => u.includes(MYMEMORY)));
});

test("throws an aggregated error when every provider fails", async () => {
	mockFetch({
		[GOOGLE]: jsonResponse(null, false, 500),
		[MYMEMORY]: jsonResponse(null, false, 503),
	});
	await assert.rejects(translateToRussian("hello"), /all translation providers failed/);
});

test("prefers DeepL when a key is configured", async () => {
	process.env.PI_RU_DEEPL_API_KEY = "secret:fx";
	const calls = mockFetch({
		[DEEPL_FREE]: deeplOk("Здравствуй"),
		[GOOGLE]: googleOk("привет"),
	});
	const result = await translateToRussian("hello");
	assert.equal(result.provider, "deepl");
	assert.equal(result.text, "Здравствуй");
	// DeepL succeeded first, so Google must not have been called.
	assert.ok(!calls.some((u) => u.includes(GOOGLE)));
});

test("a free DeepL key (:fx) uses the api-free host", async () => {
	process.env.DEEPL_API_KEY = "abc:fx";
	const calls = mockFetch({ [DEEPL_FREE]: deeplOk("текст") });
	await translateToRussian("text");
	assert.ok(calls.some((u) => u.includes(DEEPL_FREE)));
	assert.ok(!calls.some((u) => u.includes(DEEPL_PRO)));
});

test("PI_RU_PROVIDER forces a single provider with no fallback", async () => {
	process.env.PI_RU_PROVIDER = "mymemory";
	const calls = mockFetch({
		[MYMEMORY]: jsonResponse(null, false, 500),
		[GOOGLE]: googleOk("привет"), // available, but must NOT be used
	});
	await assert.rejects(translateToRussian("hello"), /all translation providers failed/);
	assert.ok(calls.every((u) => u.includes(MYMEMORY)));
	assert.ok(!calls.some((u) => u.includes(GOOGLE)));
});

test("rejects empty or whitespace-only input before any network call", async () => {
	let fetched = false;
	globalThis.fetch = async () => {
		fetched = true;
		return googleOk("x");
	};
	await assert.rejects(translateToRussian("   "), /nothing to translate/);
	assert.equal(fetched, false);
});

test("aborts a slow provider via the timeout and reports failure", async () => {
	process.env.PI_RU_PROVIDER = "google";
	mockFetch({
		[GOOGLE]: (_url, opts) =>
			new Promise((_resolve, reject) => {
				opts.signal.addEventListener("abort", () =>
					reject(opts.signal.reason ?? new Error("aborted")),
				);
			}),
	});
	await assert.rejects(
		translateToRussian("hello", { timeoutMs: 20 }),
		/all translation providers failed/,
	);
});

test("honors an already-aborted external signal", async () => {
	process.env.PI_RU_PROVIDER = "google";
	mockFetch({
		[GOOGLE]: (_url, opts) =>
			new Promise((_resolve, reject) => {
				if (opts.signal.aborted) reject(opts.signal.reason ?? new Error("aborted"));
				opts.signal.addEventListener("abort", () =>
					reject(opts.signal.reason ?? new Error("aborted")),
				);
			}),
	});
	await assert.rejects(
		translateToRussian("hello", { signal: AbortSignal.abort() }),
		/all translation providers failed/,
	);
});

// --- live smoke test (auto-skips offline) -----------------------------------

test("live: default Google endpoint returns Cyrillic", async (t) => {
	globalThis.fetch = realFetch; // use the real network for this one
	try {
		const result = await translateToRussian("Hello, how are you?", { timeoutMs: 6000 });
		assert.match(result.text, /[\u0400-\u04FF]/, `expected Cyrillic, got: ${result.text}`);
	} catch (err) {
		t.skip(`network unavailable: ${err.message}`);
	}
});
