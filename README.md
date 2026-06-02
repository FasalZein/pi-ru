# pi-ru

Type `/ru <english text>` in Pi to translate the text to Russian and send the
Russian version to the agent as your request.

```
/ru what files are in this directory?
→ ru → (google) какие файлы находятся в этом каталоге?
   (the Russian text is sent to the agent)
```

`/ru` is a registered slash command, so it appears in the `/` autocomplete menu.

## Reading the answer in English

When you're testing a model that works in Russian but you want to read its
replies in English, toggle **output translation**:

- Run `/ru-en`, or press **Option+T** (`alt+t`).
- While on, each Russian answer gets a display-only English block beneath it,
  added after the answer finishes streaming.
- Toggling on also translates the most recent answer immediately.

The English block is **display-only**: it is never sent back to the model, so
the model's context stays 100% Russian across turns. This is the point for
alignment-testing models in Russian — your reading aid never contaminates what
the model sees.

Change the shortcut with `PI_RU_EN_SHORTCUT` (e.g. `PI_RU_EN_SHORTCUT=alt+r`).

## Why

Fast, free, near-instant English → Russian translation built into your prompt
flow. No API key required by default.

## How it translates

Providers are tried in order until one succeeds:

| Order | Provider | Key needed | Notes |
|-------|----------|-----------|-------|
| 1 | Google (unofficial) | no | Default. ~300–800ms, excellent EN→RU. |
| 2 | MyMemory | no | No-key fallback, ~1s. |

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
| `PI_RU_PROVIDER` | Force a single provider: `google` or `mymemory`. |
| `PI_RU_MYMEMORY_EMAIL` | Raise MyMemory's no-key daily limit. |
| `PI_RU_TIMEOUT_MS` | Per-provider request timeout (default `4000`). |
| `PI_RU_EN_SHORTCUT` | Keyboard shortcut to toggle English output (default `alt+t`). |

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

- `test/translate.test.mjs` — provider chain (order, fallback, forcing, timeout/abort,
  error aggregation) via the public API with a mocked `fetch`.
- `test/command.test.mjs` — extension wiring: `/ru` translates and sends Russian; `/ru-en`
  and the shortcut toggle a display-only English block; `agent_end` injects it only while on;
  the context hook strips blocks so the model never sees them.
- `test/output.test.mjs` — pure output helpers (text extraction) and the RU→EN direction.
- `test/integration.rpc.test.mjs` — spawns a real `pi --mode rpc` and asserts `/ru` and
  `/ru-en` register. Uses `get_commands`, so it makes **no model call** and costs nothing.
  Auto-skips if `pi` is not on PATH.

The live test inside `translate.test.mjs` auto-skips when offline.
