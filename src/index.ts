/**
 * pi-ru — type `/ru <english>` and your message is translated to Russian
 * in place before it reaches the agent.
 *
 * Architecture: translation lives at pi's **input seam** (`pi.on("input")`).
 * When you send `/ru <english>`, the handler translates the text and returns
 * `{ action: "transform", text: <russian> }`, so your own message becomes the
 * Russian version — a single message in history, not a command plus an injected
 * one. The provider chain (Google → MyMemory, optional DeepL) is hidden behind
 * `translateToRussian` in ./translate.ts.
 *
 * Note: because pi checks extension commands before the input event, `/ru` is
 * intentionally NOT registered as a command — that is what lets us rewrite the
 * request in place at the input seam.
 *
 * Config (all optional, via environment):
 *   PI_RU_PROVIDER=google|mymemory|deepl   force a single provider
 *   PI_RU_DEEPL_API_KEY=...                 enable DeepL (preferred when set)
 *   DEEPL_API_KEY=...                       same as above
 *   PI_RU_MYMEMORY_EMAIL=you@example.com    raise MyMemory's no-key daily limit
 *   PI_RU_TIMEOUT_MS=4000                   per-provider request timeout
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { translateToRussian } from "./translate.ts";

/** Matches `/ru`, optionally followed by whitespace and the text to translate. */
const RU_PREFIX = /^\/ru(?:\s+([\s\S]*))?$/;

function resolveTimeoutMs(): number | undefined {
	const parsed = Number.parseInt(process.env.PI_RU_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		// Never touch messages injected by extensions (avoids loops).
		if (event.source === "extension") return { action: "continue" };

		const match = event.text.match(RU_PREFIX);
		if (!match) return { action: "continue" };

		const english = (match[1] ?? "").trim();
		if (!english) {
			ctx.ui.notify("Usage: /ru <english text>", "warning");
			return { action: "handled" };
		}

		ctx.ui.setStatus("pi-ru", "translating…");
		try {
			const { text: translated, provider } = await translateToRussian(english, {
				signal: ctx.signal,
				timeoutMs: resolveTimeoutMs(),
			});
			ctx.ui.setStatus("pi-ru", undefined);
			ctx.ui.notify(`ru → (${provider})`, "info");
			// Rewrite the user's request in place: the Russian text is sent to the agent.
			return { action: "transform", text: translated };
		} catch (err) {
			ctx.ui.setStatus("pi-ru", undefined);
			ctx.ui.notify(`Translation failed: ${(err as Error).message}`, "error");
			// Don't forward the untranslated "/ru ..." text to the agent.
			return { action: "handled" };
		}
	});
}
