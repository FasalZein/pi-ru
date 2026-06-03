/**
 * pi-ru extension entry.
 *
 * Input side:
 * - `/ru <english>` — translate one message to Russian and send it to the agent.
 * - `/ru on` / `/ru off` — toggle persistent mode: every plain English message
 *   you type is auto-translated to Russian before reaching the agent (slash
 *   commands and `!bash` lines pass through untouched).
 *
 * Output side:
 * - `/ru-en` or the keyboard shortcut (default Option+T / `alt+t`) toggles a
 *   display-only English translation block beneath each Russian answer, after
 *   streaming finishes. The block is never sent to the model, so the model's
 *   context stays 100% Russian (intended for alignment-testing models in Russian).
 *
 * Footer: when `pi-fancy-footer` is installed, a "RU" widget shows which modes
 * are active. Falls back to `ctx.ui.setStatus` otherwise.
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
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import {
	RU_EN_MESSAGE_TYPE,
	extractAssistantText,
	isTranslatableAssistantMessage,
	latestAssistantTextFromEntries,
} from "./output.ts";
import { translateToEnglish, translateToRussian } from "./translate.ts";

// pi-fancy-footer event names (see pi-fancy-footer/api). Used directly so this
// extension has no hard dependency on the footer package.
const FF_DISCOVER = "pi-fancy-footer:discover-widgets";
const FF_REFRESH = "pi-fancy-footer:request-widget-refresh";

/** Read PI_RU_TIMEOUT_MS, returning undefined when unset or invalid. */
function resolveTimeoutMs(): number | undefined {
	const parsed = Number.parseInt(process.env.PI_RU_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export default function (pi: ExtensionAPI) {
	let inputOn = false; // persistent EN->RU on typed input
	let outputOn = false; // display-only RU->EN under answers
	let lastAssistantText = "";
	// Bumped on every output toggle. A translation captures the gen it started
	// under and is discarded if the gen changes before it finishes — so a slow
	// translation that resolves after Option+T is turned off never injects a
	// block. Also keeps the loader status generation-scoped.
	let outputGen = 0;
	// Serializes output translations so blocks land in answer order, never
	// interleaved when one answer finishes while another is still translating.
	let outputChain: Promise<void> = Promise.resolve();

	// --- footer / status indicator ------------------------------------------
	function modeLabel(): string | undefined {
		if (inputOn && outputOn) return "RU⇄EN";
		if (inputOn) return "RU→";
		if (outputOn) return "→EN";
		return undefined;
	}

	function refreshStatus(ctx?: ExtensionContext): void {
		const label = modeLabel();
		// Fallback footer status (works with or without pi-fancy-footer).
		ctx?.ui.setStatus("pi-ru", label);
		// Ask pi-fancy-footer to re-render its contributed widget, if present.
		pi.events.emit(FF_REFRESH, {});
	}

	// Contribute a fancy-footer widget (no-op if the footer isn't installed).
	pi.events.on(FF_DISCOVER, (payload) => {
		const request = payload as
			| { registerWidget?: (w: unknown) => void }
			| undefined;
		if (!request || typeof request.registerWidget !== "function") return;
		request.registerWidget({
			id: "pi-ru.mode",
			label: "Russian translation",
			description: "pi-ru input/output translation mode",
			row: 1,
			order: 9,
			align: "right",
			icon: { nerd: "󰗊", emoji: "🌐", unicode: "RU", ascii: "RU" },
			visible: () => modeLabel() !== undefined,
			render: () => modeLabel() ?? "",
		});
	});

	// --- input: /ru <english> | /ru on|off ----------------------------------
	pi.registerCommand("ru", {
		description: "Translate English to Russian (/ru <text>), or /ru on|off for auto mode",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const lower = arg.toLowerCase();

			if (lower === "on" || lower === "off") {
				inputOn = lower === "on";
				refreshStatus(ctx);
				ctx.ui.notify(`Auto English→Russian input: ${inputOn ? "ON" : "OFF"}`, "info");
				return;
			}

			if (!arg) {
				ctx.ui.notify(
					`Usage: /ru <english text>  |  /ru on|off  (auto mode is ${inputOn ? "ON" : "OFF"})`,
					"info",
				);
				return;
			}

			ctx.ui.setStatus("pi-ru", "translating…");
			try {
				const { text: translated } = await translateToRussian(arg, {
					signal: ctx.signal,
					timeoutMs: resolveTimeoutMs(),
				});
				refreshStatus(ctx);
				pi.sendUserMessage(translated, ctx.isIdle() ? undefined : { deliverAs: "steer" });
			} catch (err) {
				refreshStatus(ctx);
				ctx.ui.notify(`Translation failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// Persistent mode: rewrite typed English to Russian at the input seam.
	pi.on("input", async (event, ctx) => {
		if (!inputOn) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		const text = event.text;
		// Leave commands and bash lines alone.
		if (!text.trim() || text.startsWith("/") || text.startsWith("!")) {
			return { action: "continue" };
		}
		try {
			const { text: translated } = await translateToRussian(text, {
				signal: ctx.signal,
				timeoutMs: resolveTimeoutMs(),
			});
			return { action: "transform", text: translated };
		} catch (err) {
			ctx.ui.notify(`Translation failed: ${(err as Error).message}`, "error");
			return { action: "handled" };
		}
	});

	// --- output: Russian answer -> display-only English block ---------------
	// Render the English block beneath the Russian answer. Honors `expanded`
	// (Ctrl+O) just like tool output: collapsed shows a one-line preview.
	pi.registerMessageRenderer(RU_EN_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { provider?: string } | undefined;
		const header = `EN${details?.provider ? ` (${details.provider})` : ""}`;
		const full = String(message.content ?? "");
		const multiline = full.includes("\n");
		const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
		// Collapsed multi-line block: show a one-line plain preview + expand hint.
		if (!expanded && multiline) {
			const firstLine = full.split("\n", 1)[0] ?? "";
			box.addChild(
				new Text(
					theme.fg("dim", `${header}: `) +
						firstLine +
						theme.fg("dim", "  … (ctrl+o to expand)"),
					0,
					0,
				),
			);
			return box;
		}
		// Expanded (or single-line): render the English as real markdown so
		// headings, lists, tables and code blocks keep their formatting.
		box.addChild(new Text(theme.fg("dim", `${header}:`), 0, 0));
		box.addChild(new Markdown(full, 0, 0, getMarkdownTheme()));
		return box;
	});

	// Keep injected English blocks OUT of the model's context (display-only).
	pi.on("context", async (event) => {
		const messages = event.messages.filter(
			(m) => (m as { customType?: string }).customType !== RU_EN_MESSAGE_TYPE,
		);
		return { messages };
	});

	async function showEnglishFor(text: string, ctx: ExtensionContext | undefined, gen: number): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Loader: long answers take a few seconds to translate (chunked). Show a
		// footer indicator under its own key so the mode label is left intact.
		ctx?.ui.setStatus("pi-ru-en", "EN: translating…");
		try {
			const { text: english, provider } = await translateToEnglish(trimmed, {
				timeoutMs: resolveTimeoutMs(),
			});
			// Toggled off (or toggled again) while translating: drop this result so
			// no stale block appears and ordering stays correct.
			if (gen !== outputGen) return;
			pi.sendMessage({
				customType: RU_EN_MESSAGE_TYPE,
				content: english,
				display: true,
				details: { provider },
			});
		} catch (err) {
			if (gen !== outputGen) return;
			pi.sendMessage({
				customType: RU_EN_MESSAGE_TYPE,
				content: `translation failed: ${(err as Error).message}`,
				display: true,
				details: {},
			});
		} finally {
			// Only the active generation owns the loader; a stale translation must
			// not clear a loader that a newer translation is showing.
			if (gen === outputGen) ctx?.ui.setStatus("pi-ru-en", undefined);
		}
	}

	// Queue an output translation behind any in-flight one, tagged with the
	// current generation so it is skipped if the toggle state changes meanwhile.
	function queueEnglish(text: string, ctx: ExtensionContext | undefined): Promise<void> {
		const gen = outputGen;
		outputChain = outputChain.then(() => {
			if (gen !== outputGen) return;
			return showEnglishFor(text, ctx, gen);
		});
		return outputChain;
	}

	// After each prompt finishes, remember the last Russian answer and, when the
	// toggle is on, show its English translation below.
	pi.on("agent_end", async (event, ctx) => {
		const assistantTexts = (event.messages ?? [])
			.filter(isTranslatableAssistantMessage)
			.map(extractAssistantText);
		const latest = assistantTexts[assistantTexts.length - 1];
		if (latest) lastAssistantText = latest;
		if (outputOn && latest) await queueEnglish(latest, ctx);
	});

	async function toggleOutput(ctx: ExtensionContext): Promise<void> {
		outputOn = !outputOn;
		outputGen++; // invalidate any in-flight translation from the previous state
		refreshStatus(ctx);
		if (!outputOn) {
			ctx.ui.setStatus("pi-ru-en", undefined); // clear any lingering loader
			ctx.ui.notify(
				"English output translation: OFF (new answers won't be translated; existing blocks stay — collapse with ctrl+o)",
				"info",
			);
			return;
		}
		// Turning on: translate the latest Russian answer right away. Fall back to
		// the session history when the in-memory cache is empty (e.g. after reload).
		let text = lastAssistantText;
		if (!text) {
			text = latestAssistantTextFromEntries(ctx.sessionManager.getBranch());
			if (text) lastAssistantText = text;
		}
		if (text) {
			// No "ON" toast: the footer mode indicator (→EN) plus the
			// "EN: translating…" loader from showEnglishFor are the feedback.
			await queueEnglish(text, ctx);
		} else {
			ctx.ui.notify(
				"English output translation: ON — no Russian answer yet; the next one will be translated",
				"info",
			);
		}
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
