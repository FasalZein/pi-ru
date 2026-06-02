/**
 * Translation speed benchmark for pi-ru.
 *
 * Measures real end-to-end latency of the no-key providers (Google, MyMemory)
 * over several English phrases and prints per-provider min / median / p95 / max,
 * plus a sample translation so you can eyeball quality.
 *
 * Run: npm run bench
 *      PI_RU_BENCH_RUNS=5 npm run bench   # repeats per phrase (default 3)
 *
 * DeepL is included only if PI_RU_DEEPL_API_KEY / DEEPL_API_KEY is set.
 * No model calls. Network required.
 */
import { translateToRussian } from "../src/translate.ts";

const PHRASES = [
	"Hello, how are you?",
	"What files are in this directory?",
	"Please run the tests and fix any errors you find.",
	"The quick brown fox jumps over the lazy dog near the river bank at dawn.",
	"Refactor the authentication module to use dependency injection and add unit tests.",
];

const RUNS = Math.max(1, Number.parseInt(process.env.PI_RU_BENCH_RUNS ?? "3", 10) || 3);

function stats(samples) {
	const s = [...samples].sort((a, b) => a - b);
	const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
	const sum = s.reduce((a, b) => a + b, 0);
	return {
		n: s.length,
		min: s[0],
		median: at(50),
		p95: at(95),
		max: s[s.length - 1],
		mean: sum / s.length,
	};
}

function fmt(ms) {
	return `${ms.toFixed(0)}ms`.padStart(7);
}

async function timeOne(provider, text) {
	process.env.PI_RU_PROVIDER = provider;
	const t0 = performance.now();
	try {
		const r = await translateToRussian(text, { timeoutMs: 8000 });
		return { ms: performance.now() - t0, ok: true, text: r.text };
	} catch (err) {
		return { ms: performance.now() - t0, ok: false, error: err.message };
	}
}

async function benchProvider(provider) {
	const samples = [];
	let failures = 0;
	let sample = "";
	for (const phrase of PHRASES) {
		for (let i = 0; i < RUNS; i++) {
			const r = await timeOne(provider, phrase);
			if (r.ok) {
				samples.push(r.ms);
				if (!sample) sample = r.text;
			} else {
				failures++;
			}
		}
	}
	return { provider, samples, failures, sample };
}

async function main() {
	const providers = ["google", "mymemory"];
	const deeplKey = process.env.PI_RU_DEEPL_API_KEY ?? process.env.DEEPL_API_KEY;
	if (deeplKey) providers.push("deepl");

	console.log(
		`pi-ru translation benchmark — ${PHRASES.length} phrases x ${RUNS} runs each\n`,
	);
	console.log(
		`${"provider".padEnd(10)} ${"min".padStart(7)} ${"median".padStart(7)} ` +
			`${"p95".padStart(7)} ${"max".padStart(7)} ${"mean".padStart(7)}  ok/fail`,
	);
	console.log("-".repeat(72));

	const results = [];
	for (const provider of providers) {
		const r = await benchProvider(provider);
		results.push(r);
		if (r.samples.length === 0) {
			console.log(
				`${provider.padEnd(10)} ${"—".padStart(7)} ${"—".padStart(7)} ` +
					`${"—".padStart(7)} ${"—".padStart(7)} ${"—".padStart(7)}  0/${r.failures}`,
			);
			continue;
		}
		const st = stats(r.samples);
		console.log(
			`${provider.padEnd(10)} ${fmt(st.min)} ${fmt(st.median)} ${fmt(st.p95)} ` +
				`${fmt(st.max)} ${fmt(st.mean)}  ${st.n}/${r.failures}`,
		);
	}

	console.log("\nSample translations:");
	for (const r of results) {
		console.log(`  [${r.provider}] ${r.sample || "(no successful translation)"}`);
	}

	// Reset env so we don't leak the forced provider.
	delete process.env.PI_RU_PROVIDER;

	const anyOk = results.some((r) => r.samples.length > 0);
	if (!anyOk) {
		console.error("\nAll providers failed — check network connectivity.");
		process.exit(1);
	}
}

await main();
