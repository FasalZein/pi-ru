/**
 * pi-ru extension entry.
 *
 * Input side — `/ru <english>`: translates English to Russian and sends the
 * Russian text to the agent as your request.
 *
 * Output side — `/ru-en` (or the keyboard shortcut): toggles a display-only
 * English translation block shown beneath each Russian assistant answer, after
 * streaming finishes. The block is never sent to the model, so the model's
 * context stays 100% Russian (intended for alignment-testing models in Russian).
 *
 * Configuration (environment, all optional):
 * - `PI_RU_PROVIDER` — force a single provider: `google` | `mymemory`
 * - `PI_RU_MYMEMORY_EMAIL` — raise MyMemory's no-key daily limit
 * - `PI_RU_TIMEOUT_MS` — per-provider request timeout (default 4000)
 * - `PI_RU_EN_SHORTCUT` — keyboard shortcut for the output toggle (default "alt+t")
 *
 * @module pi-ru
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	RU_EN_MESSAGE_TYPE,
	extractAssistantText,
	isTranslatableAssistantMessage,
} from "./output.ts";
import { translateToEnglish, translateToRussian } from "./translate.ts";

/** Read PI_RU_TIMEOUT_MS, returning undefined when unset or invalid. */
function resolveTimeoutMs(): number | undefined {
	const parsed = Number.parseInt(process.env.PI_RU_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export default function (pi: ExtensionAPI) {
	// --- input: /ru <english> -> Russian -> agent ---------------------------
	pi.registerCommand("ru", {
		description: "Translate English to Russian, then send it to the agent",
		handler: async (args, ctx) => {
			const english = args.trim();
			if (!english) {
				ctx.ui.notify("Usage: /ru <english text>", "warning");
				return;
			}

			ctx.ui.setStatus("pi-ru", "translating…");
			try {
				const { text: translated, provider } = await translateToRussian(english, {
					signal: ctx.signal,
					timeoutMs: resolveTimeoutMs(),
				});
				ctx.ui.setStatus("pi-ru", undefined);
				ctx.ui.notify(`ru → (${provider}) ${translated}`, "info");
				pi.sendUserMessage(translated, ctx.isIdle() ? undefined : { deliverAs: "steer" });
			} catch (err) {
				ctx.ui.setStatus("pi-ru", undefined);
				ctx.ui.notify(`Translation failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// --- output: Russian answer -> display-only English block ---------------
	let outputOn = false;
	let lastAssistantText = "";

	// Render the English block beneath the Russian answer.
	pi.registerMessageRenderer(RU_EN_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as { provider?: string } | undefined;
		const label = theme.fg("dim", `EN${details?.provider ? ` (${details.provider})` : ""}: `);
		const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(label + message.content, 0, 0));
		return box;
	});

	// Keep injected English blocks OUT of the model's context (display-only).
	pi.on("context", async (event) => {
		const messages = event.messages.filter(
			(m) => (m as { customType?: string }).customType !== RU_EN_MESSAGE_TYPE,
		);
		return { messages };
	});

	async function showEnglishFor(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		try {
			const { text: english, provider } = await translateToEnglish(trimmed, {
				timeoutMs: resolveTimeoutMs(),
			});
			pi.sendMessage({
				customType: RU_EN_MESSAGE_TYPE,
				content: english,
				display: true,
				details: { provider },
			});
		} catch (err) {
			pi.sendMessage({
				customType: RU_EN_MESSAGE_TYPE,
				content: `translation failed: ${(err as Error).message}`,
				display: true,
				details: {},
			});
		}
	}

	// After each prompt finishes, remember the last Russian answer and, when the
	// toggle is on, show its English translation below.
	pi.on("agent_end", async (event) => {
		const assistantTexts = (event.messages ?? [])
			.filter(isTranslatableAssistantMessage)
			.map(extractAssistantText);
		const latest = assistantTexts[assistantTexts.length - 1];
		if (latest) lastAssistantText = latest;
		if (outputOn && latest) await showEnglishFor(latest);
	});

	async function toggleOutput(ctx: ExtensionContext): Promise<void> {
		outputOn = !outputOn;
		ctx.ui.setStatus("pi-ru-en", outputOn ? "EN on" : undefined);
		ctx.ui.notify(`English output translation: ${outputOn ? "ON" : "OFF"}`, "info");
		// Give instant feedback by translating the most recent answer.
		if (outputOn && lastAssistantText) await showEnglishFor(lastAssistantText);
	}

	pi.registerCommand("ru-en", {
		description: "Toggle a display-only English translation under each Russian answer",
		handler: async (_args, ctx) => toggleOutput(ctx),
	});

	const shortcut = process.env.PI_RU_EN_SHORTCUT?.trim() || "alt+t";
	pi.registerShortcut(shortcut, {
		description: "Toggle pi-ru English output translation",
		handler: async (ctx) => toggleOutput(ctx),
	});
}
