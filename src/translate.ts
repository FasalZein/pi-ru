/**
 * pi-ru translation providers.
 *
 * Free, near-instant English -> Russian translation with graceful fallback.
 *
 * Provider order (auto):
 *   1. DeepL   - only if PI_RU_DEEPL_API_KEY / DEEPL_API_KEY is set (official, highest quality)
 *   2. Google  - unofficial translate.googleapis.com endpoint (no key, fastest, excellent EN->RU)
 *   3. MyMemory - no-key public endpoint (slower, good quality, last resort)
 *
 * Force a single provider with PI_RU_PROVIDER=google|mymemory|deepl.
 *
 * The Google endpoint is unofficial. It has been stable for years and needs no
 * API key, which is why it is the default. MyMemory is a no-key safety net.
 */

export type TranslationProvider = "google" | "mymemory" | "deepl";

export interface TranslationResult {
	text: string;
	provider: TranslationProvider;
}

const DEFAULT_TIMEOUT_MS = 4000;
const VALID_PROVIDERS: TranslationProvider[] = ["google", "mymemory", "deepl"];

/**
 * Build a child AbortSignal that aborts on either an external signal or a timeout.
 * Returns a cleanup function that must always be called to clear the timer and
 * detach the listener.
 */
function withTimeout(
	external: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	const onAbort = () => controller.abort(external?.reason);
	if (external) {
		if (external.aborted) controller.abort(external.reason);
		else external.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
		},
	};
}

async function translateGoogle(text: string, signal: AbortSignal): Promise<string> {
	const url =
		"https://translate.googleapis.com/translate_a/single" +
		`?client=gtx&sl=en&tl=ru&dt=t&q=${encodeURIComponent(text)}`;
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	// Response shape: [ [ ["translated","original",...], ... ], ... ]
	const data = (await res.json()) as unknown;
	const segments = Array.isArray(data) ? (data[0] as unknown) : undefined;
	if (!Array.isArray(segments)) throw new Error("unexpected response shape");
	const out = segments
		.map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
		.join("");
	if (!out.trim()) throw new Error("empty result");
	return out;
}

async function translateMyMemory(text: string, signal: AbortSignal): Promise<string> {
	const email = process.env.PI_RU_MYMEMORY_EMAIL?.trim();
	const de = email ? `&de=${encodeURIComponent(email)}` : "";
	const url =
		"https://api.mymemory.translated.net/get" +
		`?q=${encodeURIComponent(text)}&langpair=en|ru${de}`;
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as {
		responseStatus?: number;
		responseData?: { translatedText?: string };
	};
	const out = data?.responseData?.translatedText;
	if (!out || !out.trim()) throw new Error("empty result");
	return out;
}

async function translateDeepL(
	text: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<string> {
	// Free keys end with ":fx" and use the api-free host.
	const endpoint = apiKey.endsWith(":fx")
		? "https://api-free.deepl.com/v2/translate"
		: "https://api.deepl.com/v2/translate";
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `DeepL-Auth-Key ${apiKey}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ text, source_lang: "EN", target_lang: "RU" }),
		signal,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { translations?: Array<{ text?: string }> };
	const out = data?.translations?.[0]?.text;
	if (!out || !out.trim()) throw new Error("empty result");
	return out;
}

function resolveProviderOrder(deeplKey: string | undefined): TranslationProvider[] {
	const forced = process.env.PI_RU_PROVIDER?.trim().toLowerCase();
	if (forced && (VALID_PROVIDERS as string[]).includes(forced)) {
		return [forced as TranslationProvider];
	}
	const order: TranslationProvider[] = [];
	if (deeplKey) order.push("deepl");
	order.push("google", "mymemory");
	return [...new Set(order)];
}

/**
 * Translate English text to Russian, trying providers in order until one
 * succeeds. Throws only if every provider fails.
 */
export async function translateToRussian(
	text: string,
	options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<TranslationResult> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("nothing to translate");

	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deeplKey = (process.env.PI_RU_DEEPL_API_KEY ?? process.env.DEEPL_API_KEY)?.trim();
	const providers = resolveProviderOrder(deeplKey);

	const errors: string[] = [];
	for (const provider of providers) {
		if (provider === "deepl" && !deeplKey) {
			errors.push("deepl: no API key configured");
			continue;
		}
		const { signal, cleanup } = withTimeout(options?.signal, timeoutMs);
		try {
			let out: string;
			if (provider === "google") out = await translateGoogle(trimmed, signal);
			else if (provider === "mymemory") out = await translateMyMemory(trimmed, signal);
			else out = await translateDeepL(trimmed, deeplKey as string, signal);
			return { text: out, provider };
		} catch (err) {
			errors.push(`${provider}: ${(err as Error).message}`);
		} finally {
			cleanup();
		}
	}
	throw new Error(`all translation providers failed — ${errors.join("; ")}`);
}
