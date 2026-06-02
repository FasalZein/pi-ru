/**
 * Behavior tests for the extension wiring (`src/index.ts`).
 *
 * Loads the real extension entry with a fake ExtensionAPI that records every
 * registration, then exercises the observable behavior:
 *  - /ru translates English and sends Russian to the agent
 *  - /ru-en + shortcut toggle a display-only English block
 *  - agent_end injects the English block (only while the toggle is on)
 *  - the context hook strips English blocks so they never reach the model
 *
 * `fetch` is mocked so the tests are deterministic.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import extension from "../src/index.ts";
import { RU_EN_MESSAGE_TYPE } from "../src/output.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.PI_RU_PROVIDER;
	delete process.env.PI_RU_EN_SHORTCUT;
});

function loadExtension() {
	const commands = {};
	const handlers = {};
	const shortcuts = {};
	let renderer;
	const sent = []; // sendUserMessage
	const injected = []; // sendMessage (custom blocks)
	const notes = [];

	const pi = {
		registerCommand: (name, opts) => {
			commands[name] = opts;
		},
		registerShortcut: (key, opts) => {
			shortcuts[key] = opts;
		},
		registerMessageRenderer: (type, fn) => {
			renderer = { type, fn };
		},
		on: (event, fn) => {
			handlers[event] = fn;
		},
		sendUserMessage: (text, opts) => {
			sent.push({ text, opts });
		},
		sendMessage: (msg) => {
			injected.push(msg);
		},
	};
	extension(pi);

	const ctx = {
		ui: {
			notify: (message, level) => notes.push({ message, level }),
			setStatus: () => {},
		},
		isIdle: () => true,
		signal: undefined,
	};
	return { commands, handlers, shortcuts, renderer, sent, injected, notes, ctx };
}

function mockGoogle(translated) {
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => [[[translated, "src"]]],
	});
}

// --- input side: /ru ---------------------------------------------------------

test("registers a /ru command (so it appears in the slash menu)", () => {
	const { commands } = loadExtension();
	assert.ok(commands.ru, "expected a 'ru' command to be registered");
	assert.equal(typeof commands.ru.handler, "function");
	assert.match(commands.ru.description ?? "", /Russian/i);
});

test("translates the argument and sends the Russian text to the agent", async () => {
	mockGoogle("какие файлы здесь?");
	const { commands, sent, ctx } = loadExtension();
	await commands.ru.handler("what files are here?", ctx);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].text, "какие файлы здесь?");
});

test("shows a warning and sends nothing when /ru has no text", async () => {
	const { commands, sent, notes, ctx } = loadExtension();
	await commands.ru.handler("   ", ctx);
	assert.equal(sent.length, 0);
	assert.ok(notes.some((n) => n.level === "warning"));
});

test("reports an error (and sends nothing) when /ru translation fails", async () => {
	process.env.PI_RU_PROVIDER = "google";
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
	const { commands, sent, notes, ctx } = loadExtension();
	await commands.ru.handler("hello", ctx);
	assert.equal(sent.length, 0);
	assert.ok(notes.some((n) => n.level === "error"));
});

// --- output side: /ru-en toggle + shortcut + agent_end -----------------------

test("registers /ru-en command, a shortcut, a renderer, and context+agent_end hooks", () => {
	const { commands, shortcuts, renderer, handlers } = loadExtension();
	assert.ok(commands["ru-en"], "expected a 'ru-en' command");
	assert.ok(shortcuts["alt+t"], "expected default alt+t shortcut");
	assert.equal(renderer?.type, RU_EN_MESSAGE_TYPE);
	assert.equal(typeof handlers.context, "function");
	assert.equal(typeof handlers.agent_end, "function");
});

test("honors PI_RU_EN_SHORTCUT override", () => {
	process.env.PI_RU_EN_SHORTCUT = "alt+r";
	const { shortcuts } = loadExtension();
	assert.ok(shortcuts["alt+r"], "expected overridden shortcut");
	assert.ok(!shortcuts["alt+t"], "default should not be registered when overridden");
});

test("agent_end does NOT inject an English block while output is off", async () => {
	mockGoogle("hello world");
	const { handlers, injected } = loadExtension();
	await handlers.agent_end({
		messages: [{ role: "assistant", content: "привет мир" }],
	});
	assert.equal(injected.length, 0);
});

test("toggling /ru-en on injects an English block for the last answer", async () => {
	mockGoogle("hello world");
	const { commands, handlers, injected, ctx } = loadExtension();
	// Produce an answer first so there's a "last assistant text".
	await handlers.agent_end({
		messages: [{ role: "assistant", content: "привет мир" }],
	});
	assert.equal(injected.length, 0, "off by default");

	await commands["ru-en"].handler("", ctx);
	assert.equal(injected.length, 1, "toggling on translates the latest answer");
	assert.equal(injected[0].customType, RU_EN_MESSAGE_TYPE);
	assert.equal(injected[0].content, "hello world");
	assert.equal(injected[0].display, true);
});

test("while on, each finished answer gets an English block", async () => {
	mockGoogle("translated");
	const { shortcuts, handlers, injected, ctx } = loadExtension();
	await shortcuts["alt+t"].handler(ctx); // toggle on (no prior answer yet)
	assert.equal(injected.length, 0);

	await handlers.agent_end({
		messages: [
			{ role: "user", content: "вопрос" },
			{ role: "assistant", content: "ответ" },
		],
	});
	assert.equal(injected.length, 1);
	assert.equal(injected[0].content, "translated");
});

test("a failed output translation still surfaces a block (not silent)", async () => {
	process.env.PI_RU_PROVIDER = "google";
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
	const { commands, handlers, injected, ctx } = loadExtension();
	await handlers.agent_end({ messages: [{ role: "assistant", content: "привет" }] });
	await commands["ru-en"].handler("", ctx);
	assert.equal(injected.length, 1);
	assert.match(injected[0].content, /translation failed/i);
});

test("context hook strips English blocks so the model never sees them", async () => {
	const { handlers } = loadExtension();
	const result = await handlers.context({
		messages: [
			{ role: "user", content: "привет" },
			{ role: "assistant", content: "ответ" },
			{ customType: RU_EN_MESSAGE_TYPE, content: "answer" },
		],
	});
	assert.equal(result.messages.length, 2);
	assert.ok(!result.messages.some((m) => m.customType === RU_EN_MESSAGE_TYPE));
});
