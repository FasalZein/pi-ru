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
 * Max source bytes per request, per provider. Long text is split into chunks
 * below this budget to avoid provider length limits (Google 400s on very long
 * `q`; MyMemory 414s past ~500 bytes). Google gets a generous budget for speed;
 * MyMemory stays small to respect its documented limit.
 */
const PROVIDER_MAX_BYTES: Record<TranslationProvider, number> = {
	google: 1800,
	mymemory: 450,
};

/**
 * Max concurrent in-flight requests per provider. Long input is split into many
 * chunks; translating them in parallel (bounded) keeps big pastes fast without
 * hammering the provider. Google tolerates more parallelism than MyMemory's
 * no-key endpoint, which is rate-limited.
 */
const PROVIDER_CONCURRENCY: Record<TranslationProvider, number> = {
	google: 6,
	mymemory: 2,
};

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * `encodeURIComponent` throws on malformed JS strings (lone surrogate code
 * units). Pasted/minified/binary-ish text can contain those, so normalize to a
 * well-formed Unicode string before putting text in provider URLs. Valid
 * surrogate pairs (emoji, etc.) are preserved; only invalid lone surrogates are
 * replaced with U+FFFD.
 */
function toWellFormedText(s: string): string {
	if (typeof (s as { toWellFormed?: () => string }).toWellFormed === "function") {
		return (s as { toWellFormed: () => string }).toWellFormed();
	}
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += s[i] + s[i + 1];
				i++;
			} else {
				out += "\uFFFD";
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			out += "\uFFFD";
		} else {
			out += s[i];
		}
	}
	return out;
}

const encodeQuery = (s: string): string => encodeURIComponent(toWellFormedText(s));

/**
 * Derive a child AbortSignal that fires on a timeout or on any of the given
 * external signals. Returns the derived signal plus a `cleanup` that must always
 * be called to clear the timer and detach listeners.
 *
 * @param externals - caller/attempt signals to chain (undefined entries ignored)
 * @param timeoutMs - milliseconds before the derived signal aborts
 */
function withTimeout(
	externals: Array<AbortSignal | undefined>,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	const links: Array<{ sig: AbortSignal; onAbort: () => void }> = [];
	for (const sig of externals) {
		if (!sig) continue;
		if (sig.aborted) {
			controller.abort(sig.reason);
			continue;
		}
		const onAbort = () => controller.abort(sig.reason);
		sig.addEventListener("abort", onAbort, { once: true });
		links.push({ sig, onAbort });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			for (const { sig, onAbort } of links) sig.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * Map over `items` with at most `limit` concurrent calls to `fn`, preserving
 * input order in the result. On the first error, stop scheduling new work and
 * invoke `onError` (used to abort sibling requests), then reject.
 */
async function mapBounded<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	onError: () => void,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let stopped = false;
	const worker = async (): Promise<void> => {
		while (!stopped) {
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i], i);
			} catch (err) {
				stopped = true;
				onError();
				throw err;
			}
		}
	};
	const workers = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workers }, worker));
	return results;
}

async function translateGoogle(
	text: string,
	from: string,
	to: string,
	signal: AbortSignal,
): Promise<string> {
	const url =
		"https://translate.googleapis.com/translate_a/single" +
		`?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeQuery(text)}`;
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
	const de = email ? `&de=${encodeQuery(email)}` : "";
	const url =
		"https://api.mymemory.translated.net/get" +
		`?q=${encodeQuery(text)}&langpair=${from}|${to}${de}`;
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
 * Split text into chunks whose UTF-8 size stays under `maxBytes`, preferring
 * line boundaries so markdown structure is preserved on rejoin.
 *
 * Separators (runs of newlines, including the blank lines between paragraphs)
 * are kept in each chunk's `sep` field and never inside `chunk.text` — most
 * translation engines strip leading/trailing newlines from the text they
 * return, so keeping separators out of the translated payload is what preserves
 * paragraph, table and heading spacing. Translating each `text` and rejoining
 * with `sep` reproduces the original layout.
 *
 * A single line longer than the budget is split on spaces; a single word longer
 * than the budget is hard-split.
 */
function chunkByBytes(text: string, maxBytes: number): Array<{ text: string; sep: string }> {
	// Tokens alternate: content, newline-run, content, newline-run, …
	const tokens = text.split(/(\n+)/);
	const chunks: Array<{ text: string; sep: string }> = [];
	let buf = "";
	let bufBytes = 0;
	let carrySep = ""; // separator after buf's last content (becomes a boundary on flush)

	const flush = (sep: string) => {
		chunks.push({ text: buf, sep });
		buf = "";
		bufBytes = 0;
	};
	const attachToPrev = (sep: string) => {
		if (sep && chunks.length) chunks[chunks.length - 1].sep += sep;
	};

	for (let k = 0; k < tokens.length; k += 2) {
		const content = tokens[k] ?? "";
		const sepAfter = tokens[k + 1] ?? "";

		if (content === "") {
			// A blank line / leading or trailing separator: fold its newlines into
			// the pending carry (if buffering) or onto the previous chunk.
			if (buf === "") {
				attachToPrev(carrySep + sepAfter);
				carrySep = "";
			} else {
				carrySep += sepAfter;
			}
			continue;
		}

		const cBytes = utf8Bytes(content);

		// A single oversized line: flush the buffer, then split the line itself.
		if (cBytes > maxBytes) {
			if (buf !== "") flush(carrySep);
			else attachToPrev(carrySep);
			carrySep = "";
			for (const piece of splitOversized(content, maxBytes)) chunks.push(piece);
			chunks[chunks.length - 1].sep = sepAfter;
			continue;
		}

		if (buf === "") {
			buf = content;
			bufBytes = cBytes;
			carrySep = sepAfter;
		} else {
			const merged = bufBytes + utf8Bytes(carrySep) + cBytes;
			if (merged > maxBytes) {
				flush(carrySep);
				buf = content;
				bufBytes = cBytes;
				carrySep = sepAfter;
			} else {
				buf = buf + carrySep + content;
				bufBytes = merged;
				carrySep = sepAfter;
			}
		}
	}

	if (buf !== "") flush(carrySep);
	else attachToPrev(carrySep);

	if (chunks.length === 0) chunks.push({ text, sep: "" });
	return chunks;
}

/** UTF-8 byte length of a single Unicode code point. */
function codePointBytes(cp: number): number {
	if (cp <= 0x7f) return 1;
	if (cp <= 0x7ff) return 2;
	if (cp <= 0xffff) return 3;
	return 4;
}

/**
 * Hard-split a string into pieces each within `maxBytes` UTF-8 bytes, never
 * cutting through a code point (surrogate-pair safe). Linear time: each code
 * point is visited once and byte length is computed arithmetically, with no
 * repeated re-encoding of growing prefixes.
 */
function hardSplitByBytes(s: string, maxBytes: number): string[] {
	const pieces: string[] = [];
	let start = 0; // start index of the current piece
	let curBytes = 0;
	let i = 0;
	while (i < s.length) {
		const cp = s.codePointAt(i) as number;
		const units = cp > 0xffff ? 2 : 1; // UTF-16 units this code point spans
		const b = codePointBytes(cp);
		if (curBytes + b > maxBytes && i > start) {
			pieces.push(s.slice(start, i));
			start = i;
			curBytes = 0;
		}
		curBytes += b;
		i += units;
	}
	if (start < s.length) pieces.push(s.slice(start));
	return pieces;
}

/** Split one over-budget line on spaces, hard-splitting any over-budget word. */
function splitOversized(line: string, maxBytes: number): Array<{ text: string; sep: string }> {
	const out: Array<{ text: string; sep: string }> = [];
	let buf = "";
	let bufBytes = 0;

	for (const word of line.split(" ")) {
		const wBytes = utf8Bytes(word);

		// A single word that is itself over budget: flush, then hard-split it
		// linearly. All but the last piece are emitted; the tail becomes the new
		// buffer so it can rejoin the following word with a space.
		if (wBytes > maxBytes) {
			if (buf !== "") {
				out.push({ text: buf, sep: " " });
				buf = "";
				bufBytes = 0;
			}
			const pieces = hardSplitByBytes(word, maxBytes);
			for (let k = 0; k < pieces.length - 1; k++) out.push({ text: pieces[k], sep: "" });
			buf = pieces[pieces.length - 1] ?? "";
			bufBytes = utf8Bytes(buf);
			continue;
		}

		if (buf === "") {
			buf = word;
			bufBytes = wBytes;
		} else if (bufBytes + 1 + wBytes > maxBytes) {
			// +1 for the joining space.
			out.push({ text: buf, sep: " " });
			buf = word;
			bufBytes = wBytes;
		} else {
			buf = `${buf} ${word}`;
			bufBytes += 1 + wBytes;
		}
	}

	if (buf !== "") out.push({ text: buf, sep: " " });
	if (out.length) out[out.length - 1].sep = "";
	return out;
}

/**
 * Translate `text` from one language to another, trying providers in order
 * until one fully succeeds. Long text is split into provider-sized chunks and
 * the translated pieces are rejoined, preserving line structure.
 *
 * @param text - source text
 * @param from - source language code (e.g. "en")
 * @param to - target language code (e.g. "ru")
 * @param options.signal - optional external AbortSignal
 * @param options.timeoutMs - per-request timeout (default {@link DEFAULT_TIMEOUT_MS})
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
		const chunks = chunkByBytes(trimmed, PROVIDER_MAX_BYTES[provider]);
		// Abort sibling chunk requests as soon as one chunk fails for this provider.
		const attemptCtrl = new AbortController();
		try {
			const parts = await mapBounded(
				chunks,
				PROVIDER_CONCURRENCY[provider],
				async (chunk) => {
					// Pure-separator chunk: nothing to translate, no network call.
					if (!chunk.text.trim()) return chunk.text;
					const { signal, cleanup } = withTimeout(
						[options?.signal, attemptCtrl.signal],
						timeoutMs,
					);
					try {
						return provider === "google"
							? await translateGoogle(chunk.text, from, to, signal)
							: await translateMyMemory(chunk.text, from, to, signal);
					} finally {
						cleanup();
					}
				},
				() => attemptCtrl.abort(),
			);
			const out = parts.map((part, i) => part + chunks[i].sep).join("");
			if (!out.trim()) throw new Error("empty result");
			return { text: out, provider };
		} catch (err) {
			attemptCtrl.abort();
			errors.push(`${provider}: ${(err as Error).message}`);
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
