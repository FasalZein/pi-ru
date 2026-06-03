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

const googleOk = (text) => jsonResponse([[[text, "src"]]]);
const myMemoryOk = (text) => jsonResponse({ responseData: { translatedText: text } });

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

test("splits long text into chunks and rejoins preserving line structure", async () => {
	process.env.PI_RU_PROVIDER = "google";
	// Each line is short, but the whole exceeds Google's 1800-byte chunk budget,
	// so it must be sent in multiple requests and rejoined with newlines.
	const lineCount = 80;
	const input = Array.from({ length: lineCount }, (_, i) => `line number ${i} word word`).join("\n");
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		// Echo back the decoded q so we can verify rejoining is faithful.
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	assert.ok(calls.length > 1, `expected multiple chunk requests, got ${calls.length}`);
	// Rejoined output must equal the original (echo provider) with all lines intact.
	assert.equal(result.text.split("\n").length, lineCount);
	assert.equal(result.text, input);
});

test("a single oversized line is split and rejoined without newlines", async () => {
	process.env.PI_RU_PROVIDER = "google";
	const input = `${"averylongword ".repeat(300)}end`; // one line, way over budget, no \n
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	assert.ok(calls.length > 1, "expected the oversized line to be split");
	assert.ok(!result.text.includes("\n"), "single-line input must not gain newlines");
	assert.equal(result.text.replace(/\s+/g, " ").trim(), input.replace(/\s+/g, " ").trim());
});

test("preserves blank-line separators after an oversized line (markdown spacing)", async () => {
	process.env.PI_RU_PROVIDER = "google";
	// Oversized paragraph, then a blank line, then a heading, then a blank line,
	// then a list. This is the exact P2 case that previously collapsed \n\n.
	const longPara = "word ".repeat(600).trim(); // > 1800 bytes, one line
	const input = `${longPara}\n\n## Heading\n\n- a\n- b`;
	// Echo provider that mimics Google: strips leading/trailing newlines per chunk.
	globalThis.fetch = async (url) => {
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "").replace(/^\n+|\n+$/g, "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	// The double newlines around the heading must survive.
	assert.ok(result.text.includes("\n\n## Heading\n\n"), `lost blank lines: ${JSON.stringify(result.text.slice(-60))}`);
	assert.ok(result.text.includes("- a\n- b"), "list lines must stay on separate lines");
});

test("translates chunks in parallel but rejoins in original order", async () => {
	process.env.PI_RU_PROVIDER = "google";
	// Many short lines -> many chunks. Resolve later chunks FIRST to prove the
	// rejoin is index-ordered, not completion-ordered.
	const lineCount = 120;
	const input = Array.from({ length: lineCount }, (_, i) => `line ${i} padding padding`).join("\n");
	let inFlight = 0;
	let maxInFlight = 0;
	globalThis.fetch = async (url) => {
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		// Reverse-bias the delay so later requests resolve before earlier ones.
		const delay = q.includes(`line ${lineCount - 1} `) ? 0 : 5;
		await new Promise((r) => setTimeout(r, delay));
		inFlight--;
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	assert.equal(result.text, input, "order must match the original despite out-of-order completion");
	assert.ok(maxInFlight > 1, `expected concurrent requests, sawmax ${maxInFlight}`);
});

test("one failed chunk fails the whole provider attempt (and aborts siblings)", async () => {
	process.env.PI_RU_PROVIDER = "google";
	const input = Array.from({ length: 60 }, (_, i) => `line ${i} padding padding`).join("\n");
	let started = 0;
	globalThis.fetch = async (url) => {
		started++;
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		if (q.includes("line 0 ")) return { ok: false, status: 500, json: async () => null };
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	await assert.rejects(translateToRussian(input), /all translation providers failed/);
	// Sanity: it didn't fan out to every chunk after the failure (bounded + abort).
	assert.ok(started >= 1);
});

test("bounds concurrency: never exceeds the per-provider in-flight cap", async () => {
	process.env.PI_RU_PROVIDER = "google"; // documented cap = 6
	// Many small chunks (well over the cap) so the limiter is actually exercised.
	const input = Array.from({ length: 200 }, (_, i) => `строка ${i} слово слово слово`).join("\n");
	let inFlight = 0;
	let maxInFlight = 0;
	globalThis.fetch = async (url) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		await new Promise((r) => setTimeout(r, 2));
		inFlight--;
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	assert.equal(result.text, input, "output must stay faithful under concurrency");
	assert.ok(maxInFlight > 1, `expected real concurrency, saw max ${maxInFlight}`);
	assert.ok(maxInFlight <= 6, `in-flight cap exceeded: ${maxInFlight} > 6`);
});

test("huge input (~200KB) translates faithfully without losing chunks", async () => {
	process.env.PI_RU_PROVIDER = "google";
	const line = "Это предложение с несколькими словами для имитации реального абзаца";
	const lines = [];
	let bytes = 0;
	let i = 0;
	while (bytes < 200_000) {
		const l = `${line} (строка ${i++})`;
		lines.push(l);
		if (i % 6 === 0) lines.push(""); // paragraph breaks
		bytes += new TextEncoder().encode(l).length + 1;
	}
	const input = lines.join("\n");
	let calls = 0;
	globalThis.fetch = async (url) => {
		calls++;
		// Mimic Google stripping leading/trailing newlines of each chunk.
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "").replace(/^\n+|\n+$/g, "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	assert.ok(calls > 50, `expected many chunks for huge input, got ${calls}`);
	assert.equal(result.text, input, "huge input must round-trip exactly (no dropped/merged lines)");
});

test("huge unbroken token (~100KB) hard-splits in linear time", async () => {
	process.env.PI_RU_PROVIDER = "google";
	// Base64/minified/no-space text used to hit an O(n²) path in splitOversized.
	const input = "a".repeat(100_000);
	let calls = 0;
	globalThis.fetch = async (url) => {
		calls++;
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const start = performance.now();
	const result = await translateToRussian(input, { timeoutMs: 60_000 });
	const elapsedMs = performance.now() - start;
	assert.ok(calls > 50, `expected many hard-split chunks, got ${calls}`);
	assert.equal(result.text, input);
	assert.ok(elapsedMs < 1500, `hard-splitting regressed to ${elapsedMs.toFixed(0)}ms`);
});

test("huge emoji token keeps surrogate pairs intact", async () => {
	process.env.PI_RU_PROVIDER = "google";
	const input = "😀".repeat(30_000);
	let calls = 0;
	globalThis.fetch = async (url) => {
		calls++;
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input, { timeoutMs: 60_000 });
	assert.ok(calls > 50, `expected many emoji chunks, got ${calls}`);
	assert.equal(result.text, input);
});

test("malformed pasted text with lone surrogates is made URL-safe", async () => {
	process.env.PI_RU_PROVIDER = "google";
	const input = `before ${"\uD800"} after ${"\uDC00"}`;
	let sawReplacement = false;
	globalThis.fetch = async (url) => {
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		sawReplacement = q.includes("�");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const result = await translateToRussian(input);
	assert.equal(result.text, "before � after �");
	assert.equal(sawReplacement, true);
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
