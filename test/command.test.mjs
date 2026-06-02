/**
 * Behavior tests for the /ru input transform.
 *
 * Loads the real extension entry with a fake ExtensionAPI, captures the
 * registered `input` handler, and exercises it. `fetch` is mocked so the test
 * is deterministic. Verifies observable behavior: `/ru <text>` is translated
 * and rewritten in place, non-/ru input passes through untouched, empty input
 * is rejected, and translation failure does not forward the raw command.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import extension from "../src/index.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.PI_RU_PROVIDER;
});

function loadExtension() {
	let inputHandler;
	const notes = [];
	const pi = {
		on: (eventName, handler) => {
			if (eventName === "input") inputHandler = handler;
		},
	};
	extension(pi);
	const ctx = {
		ui: {
			notify: (message, level) => notes.push({ message, level }),
			setStatus: () => {},
		},
		signal: undefined,
	};
	const run = (text, source = "interactive") =>
		inputHandler({ text, source }, ctx);
	return { run, notes, hasHandler: typeof inputHandler === "function" };
}

function mockGoogle(translated) {
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => [[[translated, "src"]]],
	});
}

test("registers an input handler", () => {
	const { hasHandler } = loadExtension();
	assert.equal(hasHandler, true);
});

test("translates `/ru <text>` and rewrites the message in place", async () => {
	mockGoogle("какие файлы здесь?");
	const { run } = loadExtension();
	const result = await run("/ru what files are here?");
	assert.equal(result.action, "transform");
	assert.equal(result.text, "какие файлы здесь?");
});

test("passes non-/ru input through untouched", async () => {
	let fetched = false;
	globalThis.fetch = async () => {
		fetched = true;
		return { ok: true, status: 200, json: async () => [[["x", "y"]]] };
	};
	const { run } = loadExtension();
	const result = await run("just a normal message");
	assert.equal(result.action, "continue");
	assert.equal(fetched, false, "should not translate non-/ru input");
});

test("does not translate extension-sourced input (loop guard)", async () => {
	const { run } = loadExtension();
	const result = await run("/ru hello", "extension");
	assert.equal(result.action, "continue");
});

test("warns and handles `/ru` with no text (sends nothing)", async () => {
	const { run, notes } = loadExtension();
	const result = await run("/ru   ");
	assert.equal(result.action, "handled");
	assert.ok(notes.some((n) => n.level === "warning"));
});

test("on translation failure, handles input instead of forwarding raw /ru", async () => {
	process.env.PI_RU_PROVIDER = "google";
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
	const { run, notes } = loadExtension();
	const result = await run("/ru hello");
	assert.equal(result.action, "handled");
	assert.ok(notes.some((n) => n.level === "error"));
});

test("requires the exact /ru token (does not hijack /russian etc.)", async () => {
	const { run } = loadExtension();
	const result = await run("/russian please");
	assert.equal(result.action, "continue");
});
