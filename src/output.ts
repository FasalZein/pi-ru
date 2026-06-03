/**
 * Pure helpers for the output-translation feature.
 *
 * Kept separate from the pi wiring so the message-shape logic is testable
 * without an ExtensionAPI.
 *
 * @module pi-ru/output
 */

/** customType used for the display-only English translation block. */
export const RU_EN_MESSAGE_TYPE = "pi-ru-en";

/**
 * Extract the plain assistant prose from a message's content, ignoring tool
 * calls and non-text parts. Returns the trimmed text, or "" when there is
 * nothing worth translating.
 *
 * Handles both shapes pi may use:
 * - `content: string`
 * - `content: Array<{ type: "text", text: string } | { type: "toolCall", ... }>`
 */
export function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;

	if (typeof content === "string") return content.trim();

	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && (part as { type?: string }).type === "text"
					? String((part as { text?: unknown }).text ?? "")
					: "",
			)
			.join("")
			.trim();
	}

	return "";
}

/** True when this message is an assistant message with translatable prose. */
export function isTranslatableAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	if ((message as { role?: string }).role !== "assistant") return false;
	return extractAssistantText(message).length > 0;
}

/**
 * Walk session entries (as returned by `sessionManager.getBranch()`, root→leaf
 * order) and return the prose of the most recent translatable assistant
 * message, or "" when there is none.
 *
 * Used so the output toggle can translate the latest answer even right after a
 * reload, when the in-memory `lastAssistantText` cache is empty.
 */
export function latestAssistantTextFromEntries(entries: unknown): string {
	if (!Array.isArray(entries)) return "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = (entry as { message?: unknown } | null)?.message;
		if (isTranslatableAssistantMessage(message)) {
			return extractAssistantText(message);
		}
	}
	return "";
}
