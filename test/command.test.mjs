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
	const events = {};
	let renderer;
	const sent = []; // sendUserMessage
	const injected = []; // sendMessage (custom blocks)
	const notes = [];
	const statuses = [];
	let sessionEntries = []; // what ctx.sessionManager.getBranch() returns

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
		events: {
			on: (name, fn) => {
				events[name] = fn;
			},
			emit: () => {},
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
			setStatus: (_key, value) => statuses.push(value),
		},
		sessionManager: { getBranch: () => sessionEntries },
		isIdle: () => true,
		signal: undefined,
	};
	return {
		commands,
		handlers,
		shortcuts,
		events,
		renderer,
		sent,
		injected,
		notes,
		statuses,
		ctx,
		setSessionEntries: (entries) => {
			sessionEntries = entries;
		},
	};
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

test("shows usage and sends nothing when /ru has no text", async () => {
	const { commands, sent, notes, ctx } = loadExtension();
	await commands.ru.handler("   ", ctx);
	assert.equal(sent.length, 0);
	assert.ok(notes.some((n) => /usage/i.test(n.message)));
});

test("reports an error (and sends nothing) when /ru translation fails", async () => {
	process.env.PI_RU_PROVIDER = "google";
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
	const { commands, sent, notes, ctx } = loadExtension();
	await commands.ru.handler("hello", ctx);
	assert.equal(sent.length, 0);
	assert.ok(notes.some((n) => n.level === "error"));
});

// --- persistent input mode: /ru on|off + input transform --------------------

test("/ru on enables auto mode; the input handler translates plain English", async () => {
	mockGoogle("привет мир");
	const { commands, handlers, ctx } = loadExtension();
	// Off by default: input passes through.
	let result = await handlers.input({ text: "hello world", source: "interactive" }, ctx);
	assert.equal(result.action, "continue");

	await commands.ru.handler("on", ctx);
	result = await handlers.input({ text: "hello world", source: "interactive" }, ctx);
	assert.equal(result.action, "transform");
	assert.equal(result.text, "привет мир");
});

test("auto mode leaves slash commands and bash lines untouched", async () => {
	mockGoogle("не должно использоваться");
	const { commands, handlers, ctx } = loadExtension();
	await commands.ru.handler("on", ctx);
	for (const text of ["/model", "!ls -la", "   "]) {
		const result = await handlers.input({ text, source: "interactive" }, ctx);
		assert.equal(result.action, "continue", `should pass through: ${JSON.stringify(text)}`);
	}
});

test("/ru off disables auto mode again", async () => {
	mockGoogle("привет");
	const { commands, handlers, ctx } = loadExtension();
	await commands.ru.handler("on", ctx);
	await commands.ru.handler("off", ctx);
	const result = await handlers.input({ text: "hello", source: "interactive" }, ctx);
	assert.equal(result.action, "continue");
});

test("auto mode ignores extension-sourced input (loop guard)", async () => {
	mockGoogle("привет");
	const { commands, handlers, ctx } = loadExtension();
	await commands.ru.handler("on", ctx);
	const result = await handlers.input({ text: "hello", source: "extension" }, ctx);
	assert.equal(result.action, "continue");
});

// --- footer widget ----------------------------------------------------------

test("contributes a fancy-footer widget that reflects the active mode", async () => {
	const { commands, events, ctx } = loadExtension();
	let registered;
	assert.equal(typeof events["pi-fancy-footer:discover-widgets"], "function");
	events["pi-fancy-footer:discover-widgets"]({ registerWidget: (w) => (registered = w) });
	assert.equal(registered.id, "pi-ru.mode");

	// Hidden when no mode is active.
	assert.equal(registered.visible(), false);

	// Turning auto input on makes it visible and render the input arrow.
	await commands.ru.handler("on", ctx);
	assert.equal(registered.visible(), true);
	assert.equal(registered.render(), "RU→");
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

	await handlers.agent_end(
		{
			messages: [
				{ role: "user", content: "вопрос" },
				{ role: "assistant", content: "ответ" },
			],
		},
		ctx,
	);
	assert.equal(injected.length, 1);
	assert.equal(injected[0].content, "translated");
});

test("toggling on falls back to session history when no answer was captured yet", async () => {
	mockGoogle("from history");
	const { shortcuts, injected, ctx, setSessionEntries } = loadExtension();
	// Simulate a reload: nothing captured in-memory, but the session has an answer.
	setSessionEntries([
		{ type: "message", message: { role: "user", content: "вопрос" } },
		{ type: "message", message: { role: "assistant", content: "русский ответ" } },
	]);
	await shortcuts["alt+t"].handler(ctx);
	assert.equal(injected.length, 1, "should translate the latest answer from history");
	assert.equal(injected[0].content, "from history");
});

test("a failed output translation still surfaces a block (not silent)", async () => {
	process.env.PI_RU_PROVIDER = "google";
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
	const { commands, handlers, injected, ctx } = loadExtension();
	await handlers.agent_end({ messages: [{ role: "assistant", content: "привет" }] }, ctx);
	await commands["ru-en"].handler("", ctx);
	assert.equal(injected.length, 1);
	assert.match(injected[0].content, /translation failed/i);
});

test("a translation that resolves after toggle-off does NOT inject a stale block", async () => {
	// Gate the fetch so we can toggle off while the translation is in flight.
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	globalThis.fetch = async (url) => {
		await gate;
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const { commands, handlers, injected, ctx } = loadExtension();
	await handlers.agent_end({ messages: [{ role: "assistant", content: "ответ" }] }, ctx);

	const onPromise = commands["ru-en"].handler("", ctx); // toggle ON -> starts translating (blocked on gate)
	await commands["ru-en"].handler("", ctx); // toggle OFF while in flight (bumps generation)
	release(); // let the stale translation resolve
	await onPromise;

	assert.equal(injected.length, 0, "stale translation must be dropped after toggle-off");
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
