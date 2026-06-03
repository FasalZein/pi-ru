/**
 * Behavior tests for the extension wiring (`src/index.ts`).
 *
 * Loads the real extension entry with a fake ExtensionAPI that records every
 * registration, then exercises the observable behavior:
 *  - /ru translates English and sends Russian to the agent
 *  - /ru-en + shortcut toggle a display-only English widget (belowEditor)
 *  - agent_end shows the English widget (only while the toggle is on)
 *  - new user input invalidates pending output translations
 *
 * `fetch` is mocked so the tests are deterministic.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import extension from "../src/index.ts";

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
	const sent = []; // sendUserMessage
	const notes = [];
	const statuses = [];
	const widgets = []; // setWidget calls: { key, content, options }
	let sessionEntries = [];

	const pi = {
		registerCommand: (name, opts) => {
			commands[name] = opts;
		},
		registerShortcut: (key, opts) => {
			shortcuts[key] = opts;
		},
		registerMessageRenderer: () => {},
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
		sendMessage: () => {},
	};
	extension(pi);

	const ctx = {
		ui: {
			notify: (message, level) => notes.push({ message, level }),
			setStatus: (_key, value) => statuses.push(value),
			setWidget: (key, content, options) => widgets.push({ key, content, options }),
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
		sent,
		notes,
		statuses,
		widgets,
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

// --- output side: /ru-en toggle + shortcut + agent_end (widget) --------------

test("registers /ru-en command, a shortcut, and agent_end + input hooks", () => {
	const { commands, shortcuts, handlers } = loadExtension();
	assert.ok(commands["ru-en"], "expected a 'ru-en' command");
	assert.ok(shortcuts["alt+t"], "expected default alt+t shortcut");
	assert.equal(typeof handlers.agent_end, "function");
	assert.equal(typeof handlers.input, "function");
});

test("honors PI_RU_EN_SHORTCUT override", () => {
	process.env.PI_RU_EN_SHORTCUT = "alt+r";
	const { shortcuts } = loadExtension();
	assert.ok(shortcuts["alt+r"], "expected overridden shortcut");
	assert.ok(!shortcuts["alt+t"], "default should not be registered when overridden");
});

test("agent_end does NOT show English widget while output is off", async () => {
	mockGoogle("hello world");
	const { handlers, widgets, ctx } = loadExtension();
	await handlers.agent_end({
		messages: [{ role: "assistant", content: "привет мир" }],
	}, ctx);
	const enWidgets = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function");
	assert.equal(enWidgets.length, 0);
});

test("toggling /ru-en on shows English widget for the last answer", async () => {
	mockGoogle("hello world");
	const { commands, handlers, widgets, ctx } = loadExtension();
	await handlers.agent_end({
		messages: [{ role: "assistant", content: "привет мир" }],
	}, ctx);
	const before = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function").length;
	assert.equal(before, 0, "off by default");

	await commands["ru-en"].handler("", ctx);
	const after = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function");
	assert.ok(after.length >= 1, "toggling on sets the translation widget");
});

test("while on, each finished answer shows an English widget", async () => {
	mockGoogle("translated");
	const { shortcuts, handlers, widgets, ctx } = loadExtension();
	await shortcuts["alt+t"].handler(ctx); // toggle on (no prior answer yet)
	const before = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function").length;

	await handlers.agent_end(
		{
			messages: [
				{ role: "user", content: "вопрос" },
				{ role: "assistant", content: "ответ" },
			],
		},
		ctx,
	);
	// agent_end fires-and-forgets the translation; give it a tick to resolve.
	await new Promise((r) => setTimeout(r, 10));
	const after = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function");
	assert.ok(after.length > before, "should set widget after answer");
});

test("toggling on falls back to session history when no answer was captured yet", async () => {
	mockGoogle("from history");
	const { shortcuts, widgets, ctx, setSessionEntries } = loadExtension();
	setSessionEntries([
		{ type: "message", message: { role: "user", content: "вопрос" } },
		{ type: "message", message: { role: "assistant", content: "русский ответ" } },
	]);
	await shortcuts["alt+t"].handler(ctx);
	const enWidgets = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function");
	assert.ok(enWidgets.length >= 1, "should set widget from history");
});

test("a failed output translation still shows a widget (not silent)", async () => {
	process.env.PI_RU_PROVIDER = "google";
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
	const { commands, handlers, widgets, ctx } = loadExtension();
	await handlers.agent_end({ messages: [{ role: "assistant", content: "привет" }] }, ctx);
	await commands["ru-en"].handler("", ctx);
	const enWidgets = widgets.filter((w) => w.key === "pi-ru-en" && typeof w.content === "function");
	assert.ok(enWidgets.length >= 1, "should show failure in widget");
});

test("a translation that resolves after toggle-off does NOT show a stale widget", async () => {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	globalThis.fetch = async (url) => {
		await gate;
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const { commands, handlers, widgets, ctx } = loadExtension();
	await handlers.agent_end({ messages: [{ role: "assistant", content: "ответ" }] }, ctx);

	const onPromise = commands["ru-en"].handler("", ctx); // toggle ON -> starts translating
	await commands["ru-en"].handler("", ctx); // toggle OFF while in flight
	release();
	await onPromise;

	const lastWidget = widgets.filter((w) => w.key === "pi-ru-en").pop();
	assert.equal(lastWidget?.content, undefined, "stale translation must not show after toggle-off");
});

test("new user input invalidates the pending output translation widget", async () => {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	globalThis.fetch = async (url) => {
		await gate;
		const q = decodeURIComponent(String(url).split("&q=")[1] ?? "");
		return { ok: true, status: 200, json: async () => [[[q, q]]] };
	};
	const { shortcuts, handlers, widgets, ctx } = loadExtension();
	await shortcuts["alt+t"].handler(ctx); // toggle on
	await handlers.agent_end({ messages: [{ role: "assistant", content: "ответ" }] }, ctx);
	// agent_end queued a translation (blocked on gate).
	// User types new input:
	await handlers.input({ text: "new question", source: "interactive" }, ctx);
	release();
	await new Promise((r) => setTimeout(r, 10));
	// The widget should have been cleared by the input invalidation.
	const lastWidget = widgets.filter((w) => w.key === "pi-ru-en").pop();
	assert.equal(lastWidget?.content, undefined, "widget cleared on new user input");
});
