/**
 * Translation with graceful provider fallback, in either direction.
 *
 * Auto provider order: Google → MyMemory. Set `PI_RU_PROVIDER` to force a
 * single provider. Google is the default because it is fast, high quality, and
 * needs no API key; MyMemory is the no-key safety net.
 *
 * `translateToRussian` (EN→RU) drives the `/ru` command; `translateToEnglish`
 * (RU→EN) drives the output-translation block.
 *
 * @module pi-ru/translate
 */

export type TranslationProvider = "google" | "mymemory";

export interface TranslationResult {
	text: string;
	provider: TranslationProvider;
}

export interface TranslateOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const VALID_PROVIDERS: TranslationProvider[] = ["google", "mymemory"];

/**
 * Derive a child AbortSignal that fires on either an external abort or a timeout.
 *
 * @param external - caller-provided signal, if any
 * @param timeoutMs - milliseconds before the derived signal aborts
 * @returns the derived signal plus a `cleanup` that must always be called
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

async function translateGoogle(
	text: string,
	from: string,
	to: string,
	signal: AbortSignal,
): Promise<string> {
	const url =
		"https://translate.googleapis.com/translate_a/single" +
		`?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
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

async function translateMyMemory(
	text: string,
	from: string,
	to: string,
	signal: AbortSignal,
): Promise<string> {
	const email = process.env.PI_RU_MYMEMORY_EMAIL?.trim();
	const de = email ? `&de=${encodeURIComponent(email)}` : "";
	const url =
		"https://api.mymemory.translated.net/get" +
		`?q=${encodeURIComponent(text)}&langpair=${from}|${to}${de}`;
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

function resolveProviderOrder(): TranslationProvider[] {
	const forced = process.env.PI_RU_PROVIDER?.trim().toLowerCase();
	if (forced && (VALID_PROVIDERS as string[]).includes(forced)) {
		return [forced as TranslationProvider];
	}
	return ["google", "mymemory"];
}

/**
 * Translate `text` from one language to another, trying providers in order
 * until one succeeds.
 *
 * @param text - source text
 * @param from - source language code (e.g. "en")
 * @param to - target language code (e.g. "ru")
 * @param options.signal - optional external AbortSignal
 * @param options.timeoutMs - per-provider timeout (default {@link DEFAULT_TIMEOUT_MS})
 * @returns the translated text and the provider that produced it
 * @throws if `text` is empty, or if every provider fails
 */
export async function translate(
	text: string,
	from: string,
	to: string,
	options?: TranslateOptions,
): Promise<TranslationResult> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("nothing to translate");

	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const providers = resolveProviderOrder();

	const errors: string[] = [];
	for (const provider of providers) {
		const { signal, cleanup } = withTimeout(options?.signal, timeoutMs);
		try {
			const out =
				provider === "google"
					? await translateGoogle(trimmed, from, to, signal)
					: await translateMyMemory(trimmed, from, to, signal);
			return { text: out, provider };
		} catch (err) {
			errors.push(`${provider}: ${(err as Error).message}`);
		} finally {
			cleanup();
		}
	}
	throw new Error(`all translation providers failed — ${errors.join("; ")}`);
}

/** Translate English → Russian. */
export function translateToRussian(
	text: string,
	options?: TranslateOptions,
): Promise<TranslationResult> {
	return translate(text, "en", "ru", options);
}

/** Translate Russian → English. */
export function translateToEnglish(
	text: string,
	options?: TranslateOptions,
): Promise<TranslationResult> {
	return translate(text, "ru", "en", options);
}
