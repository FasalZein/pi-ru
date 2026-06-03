# pi-ru

A Pi extension that translates between English and Russian, both ways, right
inside your session:

- **Type in English, the agent receives Russian.** Write your prompt in
  English and pi-ru sends the Russian translation to the agent.
- **Read the agent's Russian answers in English.** Toggle a display-only
  English translation that appears under each Russian reply.

Translation is free and near-instant (Google by default, MyMemory as a no-key
fallback) — no API key required.

## Quick start

Install from GitHub:

```bash
pi install git:github.com/FasalZein/pi-ru
```

Or run the local checkout for development:

```bash
cd pi-ru
pi -e ./src/index.ts
```

Then in your session:

```
/ru what files are in this directory?
   → sends to the agent: какие файлы находятся в этом каталоге?
```

That's it. The agent gets the Russian text as if you had typed it yourself.

## Features

- **One-shot translate + send** — `/ru <english>` translates a single message
  to Russian and sends it to the agent.
- **Auto input mode** — `/ru on` translates every plain English message you
  type before it reaches the agent; `/ru off` turns it back off.
- **Read answers in English** — `/ru-en` (or **Option+T**) shows an English
  translation under each Russian answer, rendered as markdown.
- **Markdown-safe** — headings, lists, tables, and code blocks keep their
  formatting through translation.
- **Handles huge messages** — long text is split into provider-sized chunks,
  translated in parallel, and rejoined in order, so big pastes stay fast and
  don't hit provider length limits.
- **Footer indicator** — shows which translation modes are active.
- **No key required** — Google is the default; MyMemory is the no-key fallback.

## Usage

### Translate English → Russian (input)

One-shot:

```
/ru run the tests and fix any failures
   → sends: запусти тесты и исправь все сбои
```

`/ru` is a registered slash command, so it shows up in the `/` autocomplete
menu.

Auto mode, so you don't retype `/ru` every time:

- `/ru on` — every plain English message is auto-translated to Russian before
  it reaches the agent.
- `/ru off` — back to normal.

Slash commands (`/model`, …) and `!bash` lines always pass through
untranslated, even in auto mode.

### Translate Russian → English (output)

When the agent replies in Russian and you'd rather read English:

- Run `/ru-en`, or press **Option+T** (`alt+t`).
- While on, each Russian answer gets an English translation block beneath it,
  added after the answer finishes streaming.
- Turning it on also translates the most recent answer immediately — even right
  after a reload, it falls back to the last answer in the session history.
- While a translation is running, the footer shows an `EN: translating…` loader
  so long answers don't look stuck.

The English block is rendered as **markdown** and respects **Ctrl+O**
(expand/collapse) like tool output: collapsed it shows a one-line preview,
expanded it shows the full translation.

The block is **display-only** — it is never sent back to the agent, so the
conversation the model sees stays exactly as it was (all Russian). Turning the
toggle off stops translating new answers; blocks already shown stay in the
transcript (collapse them with Ctrl+O), since Pi has no API to remove a message
once it's displayed.

Change the shortcut with `PI_RU_EN_SHORTCUT` (e.g. `PI_RU_EN_SHORTCUT=alt+r`).

### Footer indicator

When [`pi-fancy-footer`](https://github.com/mavam/pi-fancy-footer) is installed,
pi-ru contributes a footer widget showing the active mode:

| Indicator | Meaning |
|-----------|---------|
| `RU→` | Auto input translation is on (English you type → Russian). |
| `→EN` | Output translation is on (Russian answers → English block). |
| `RU⇄EN` | Both are on. |

Without fancy-footer it falls back to a plain status entry. The indicator is
hidden when no mode is active.

## Install

This is a standard Pi extension.

```bash
pi install git:github.com/FasalZein/pi-ru
```

For local development from this checkout:

```bash
pi -e ./src/index.ts
```

Auto-discovery also works if you drop it in `~/.pi/agent/extensions/` or
`.pi/extensions/`.

## Configuration (all optional)

| Env var | Effect |
|---------|--------|
| `PI_RU_PROVIDER` | Force a single provider: `google` or `mymemory`. |
| `PI_RU_MYMEMORY_EMAIL` | Raise MyMemory's no-key daily limit. |
| `PI_RU_TIMEOUT_MS` | Per-request timeout in ms (default `4000`). |
| `PI_RU_EN_SHORTCUT` | Shortcut to toggle English output (default `alt+t`). |

## How it translates

Providers are tried in order until one fully succeeds:

| Order | Provider | Key needed | Notes |
|-------|----------|-----------|-------|
| 1 | Google (unofficial) | no | Default. ~300–800ms, excellent both ways. |
| 2 | MyMemory | no | No-key fallback, ~1s. |

The Google endpoint (`translate.googleapis.com/translate_a/single`) is
unofficial. It needs no key and has been stable for years, which is why it's the
default. MyMemory is the no-key safety net if Google fails.

### Long messages

Text that exceeds a provider's length limit is split into chunks on line
boundaries (a single over-long line is split on spaces, and a single over-long
word is hard-split). Chunks are translated **in parallel** with a per-provider
concurrency cap (Google 6, MyMemory 2), then rejoined in their original order.
Blank lines and other separators are preserved exactly, so paragraph, heading,
and table spacing survives. If any chunk fails, the remaining requests for that
provider are cancelled and the fallback provider takes over.

## Speed

Single-phrase latency (`npm run bench`, US West Coast):

| Provider | min | median | p95 | mean |
|----------|----:|-------:|----:|-----:|
| google | 68ms | 160ms | 1389ms | 272ms |
| mymemory | 362ms | 506ms | 786ms | 515ms |

Google is the near-instant path; MyMemory is only used if Google fails, so a
successful translation is always Google-speed.

For large inputs, parallel chunking keeps things fast: at a simulated 50ms per
request, a ~200KB input (113 chunks) completes in roughly the time of
`ceil(chunks / 6)` sequential requests — about a 5.6–5.8× speedup over
translating the chunks one at a time.

## Test

```bash
npm test                  # unit + command behavior tests (mocked fetch, fast)
npm run test:integration  # real `pi` process loads the extension (RPC, no model call)
npm run test:all          # everything
npm run bench             # live latency benchmark per provider
```

- `test/translate.test.mjs` — provider chain (order, fallback, forcing,
  timeout/abort, error aggregation), chunking (line/blank-line preservation,
  oversized lines), and parallelism (bounded concurrency, ordered rejoin,
  sibling-abort on failure, huge-input round-trip) via the public API with a
  mocked `fetch`.
- `test/command.test.mjs` — extension wiring: `/ru` translates and sends
  Russian; `/ru on|off` drives auto input mode (with command/bash pass-through
  and loop guard); `/ru-en` and the shortcut toggle the English block;
  `agent_end` injects it only while on; a stale translation after toggle-off is
  dropped; the context hook keeps blocks out of the model's view; the
  fancy-footer widget reflects the active mode.
- `test/output.test.mjs` — pure output helpers (text extraction, latest-answer
  lookup) and the Russian → English direction.
- `test/integration.rpc.test.mjs` — spawns a real `pi --mode rpc` and asserts
  `/ru` and `/ru-en` register. Uses `get_commands`, so it makes **no model
  call** and costs nothing. Auto-skips if `pi` is not on PATH.

The live test inside `translate.test.mjs` auto-skips when offline.
