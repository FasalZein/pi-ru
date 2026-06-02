# pi-ru

Type `/ru <english text>` in Pi and your message is translated to Russian and
sent to the agent **in place** — your request becomes the Russian text.

```
/ru what files are in this directory?
→ ru → (google)
   (your message is sent to the agent as: какие файлы находятся в этом каталоге?)
```

## How it works

pi-ru hooks pi's **input seam** (`pi.on("input")`). When you send `/ru <text>`,
it translates the text and rewrites your message in place via an input
transform, so the conversation history shows a single Russian message — not a
`/ru` command plus a separate injected message.

Because pi checks extension commands before the input event, `/ru` is
intentionally **not** a registered slash command. That is what lets the
extension rewrite the request in place. (Trade-off: `/ru` won't appear in the
slash-command autocomplete menu.)

## Why

Fast, free, near-instant English → Russian translation built into your prompt
flow. No API key required by default.

## How it translates

Providers are tried in order until one succeeds:

| Order | Provider | Key needed | Notes |
|-------|----------|-----------|-------|
| 1 | DeepL | yes (if configured) | Official, highest quality. Used first only when a key is set. |
| 2 | Google (unofficial) | no | Default. ~300–800ms, excellent EN→RU. |
| 3 | MyMemory | no | No-key fallback, ~1s. |

The Google endpoint (`translate.googleapis.com/translate_a/single`) is
unofficial. It needs no key and has been stable for years, which is why it is
the default. MyMemory is a no-key safety net if Google fails.

See the research behind these choices in
`.pi/artifacts/pi-ru/translation-provider-research-2026-06-03.md`.

## Install

This package is a standard Pi extension. From the directory that contains it:

```bash
pi install git:github.com/<you>/pi-ru     # if published
# or load locally for a quick test:
pi -e ./pi-ru/src/index.ts
```

Auto-discovery also works if you drop it in `~/.pi/agent/extensions/` or
`.pi/extensions/`.

## Configuration (all optional)

| Env var | Effect |
|---------|--------|
| `PI_RU_PROVIDER` | Force a single provider: `google`, `mymemory`, or `deepl`. |
| `PI_RU_DEEPL_API_KEY` / `DEEPL_API_KEY` | Enable DeepL (preferred when set). Free keys end in `:fx`. |
| `PI_RU_MYMEMORY_EMAIL` | Raise MyMemory's no-key daily limit. |
| `PI_RU_TIMEOUT_MS` | Per-provider request timeout (default `4000`). |

## Speed

Live benchmark (`npm run bench`, 5 phrases x 4 runs, US West Coast):

| Provider | min | median | p95 | mean |
|----------|----:|-------:|----:|-----:|
| google | 68ms | 160ms | 1389ms | 272ms |
| mymemory | 362ms | 506ms | 786ms | 515ms |

Google is the near-instant path; MyMemory is only used if Google fails, so a
successful `/ru` is always Google-speed. No free provider tested was faster than
Google's direct endpoint — its latency is essentially the network round-trip floor.

## Test

```bash
npm test              # unit + command behavior tests (mocked fetch, fast)
npm run test:integration  # real `pi` process loads the extension (RPC, no model call)
npm run test:all          # everything
npm run bench             # live latency benchmark per provider
```

- `test/translate.test.mjs` — behavior of the provider chain (order, fallback,
  forcing, timeout/abort, error aggregation) via the public API with a mocked `fetch`.
- `test/command.test.mjs` — the `/ru` input transform: translates and rewrites in place,
  passes non-`/ru` input through, guards against loops, handles empty input and failures.
- `test/integration.rpc.test.mjs` — spawns a real `pi --mode rpc` and asserts the
  extension loads with no error (and, by design, registers no `/ru` command). Uses
  `get_commands`, so it makes **no model call** and costs nothing. Auto-skips if `pi`
  is not on PATH.

The live test inside `translate.test.mjs` auto-skips when offline.
