/**
 * Behavior tests for the output-translation helpers and direction.
 *
 * Pure-helper tests (extractAssistantText / isTranslatableAssistantMessage)
 * need no network. The direction test mocks `fetch` to confirm RU→EN uses the
 * correct language pair.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
	RU_EN_MESSAGE_TYPE,
	extractAssistantText,
	isTranslatableAssistantMessage,
	latestAssistantTextFromEntries,
} from "../src/output.ts";
import { translateToEnglish } from "../src/translate.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.PI_RU_PROVIDER;
});

test("RU_EN_MESSAGE_TYPE is a stable custom type", () => {
	assert.equal(RU_EN_MESSAGE_TYPE, "pi-ru-en");
});

test("extractAssistantText reads a plain string content", () => {
	assert.equal(extractAssistantText({ role: "assistant", content: "Привет " }), "Привет");
});

test("extractAssistantText joins text parts and ignores tool calls", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: "Привет. " },
			{ type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } },
			{ type: "text", text: "Как дела?" },
		],
	};
	assert.equal(extractAssistantText(message), "Привет. Как дела?");
});

test("extractAssistantText returns empty for tool-only or empty messages", () => {
	assert.equal(extractAssistantText({ role: "assistant", content: [] }), "");
	assert.equal(
		extractAssistantText({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }],
		}),
		"",
	);
	assert.equal(extractAssistantText(null), "");
});

test("isTranslatableAssistantMessage requires assistant role + prose", () => {
	assert.equal(isTranslatableAssistantMessage({ role: "assistant", content: "Привет" }), true);
	assert.equal(isTranslatableAssistantMessage({ role: "user", content: "Привет" }), false);
	assert.equal(isTranslatableAssistantMessage({ role: "assistant", content: "" }), false);
	assert.equal(isTranslatableAssistantMessage({ role: "assistant", content: [] }), false);
});

test("latestAssistantTextFromEntries returns the most recent assistant prose", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "Translate this" } },
		{ type: "message", message: { role: "assistant", content: "Первый ответ" } },
		{ type: "message", message: { role: "user", content: "Ещё" } },
		{ type: "message", message: { role: "assistant", content: "Последний ответ" } },
		// Display-only EN block + a tool-only assistant turn must be skipped.
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] } },
	];
	assert.equal(latestAssistantTextFromEntries(entries), "Последний ответ");
});

test("latestAssistantTextFromEntries returns empty when no assistant prose exists", () => {
	assert.equal(latestAssistantTextFromEntries([]), "");
	assert.equal(latestAssistantTextFromEntries(undefined), "");
	assert.equal(
		latestAssistantTextFromEntries([
			{ type: "message", message: { role: "user", content: "hi" } },
		]),
		"",
	);
});

test("translateToEnglish requests the ru|en language pair", async () => {
	process.env.PI_RU_PROVIDER = "google";
	let requestedUrl = "";
	globalThis.fetch = async (url) => {
		requestedUrl = String(url);
		return { ok: true, status: 200, json: async () => [[["hello", "привет"]]] };
	};
	const result = await translateToEnglish("привет");
	assert.equal(result.text, "hello");
	assert.match(requestedUrl, /sl=ru&tl=en/);
});
