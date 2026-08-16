# FrankToken

An **OS-agnostic, GUI-rich** system-tray app that shows your AI usage limits, token
consumption, per-session detail, and estimated USD cost across providers. Runs on
**Windows, macOS, and Linux** (Electron + React).

![tray + dashboard](resources/icon.png)

## What it does

- **System-tray icon** with a live tooltip + context menu showing the peak rate-limit window.
- **Live, account-wide Claude limits**: the 5-hour / weekly / per-model windows come from the
  same usage API every Claude surface draws down — so they reflect usage from **any device
  you sign into**, whether it happened in Claude.ai, Claude Code (CLI/web/desktop/IDE),
  Claude Cowork, Claude Design, or the Office plugins.
- **Real-time**: file watchers on every provider's data root push updates to the dashboard
  within seconds of a session streaming tokens — no waiting for the next poll.
- **Sessions explorer**: every session with timestamps, length, model calls, token breakdown
  (input / cached / output), models used, and estimated USD cost. Sortable, filterable by
  provider/surface, searchable. Click a session for a **flyout** with its cumulative token
  timeline and per-model split. Pick up to 4 sessions for a **comparison overlay** (aligned
  burn curves + total/cost/length/pace bars).
- **Models view**: every model compared head-to-head — tokens, cost, sessions, effective
  $/1M tokens, and daily-usage overlay.
- **Shareable interactive report**: one click ("⬡ Share") exports a **single self-contained
  HTML file** — dark, interactive, zero external dependencies — with the overview, every
  session (flyouts + comparisons), and the model head-to-heads. Send it to anyone; it opens
  in any browser.
- **Privacy-first**: everything is parsed **on-device**. Nothing is uploaded; the report is a
  local file you choose to share.

## Providers & coverage (v0.2)

| Provider | Live limits | Token/session detail | Notes |
|----------|-------------|----------------------|-------|
| **Claude** (all surfaces) | ✅ account-wide, every device & surface, via `api/oauth/usage` | Local transcripts: `~/.claude/projects/**` (+ `CLAUDE_CONFIG_DIR`, `~/.config/claude`) | OAuth token read from `.credentials.json` **or the macOS Keychain**; auto-refreshed. Sessions are tagged with their surface (CLI / web / desktop / IDE / Cowork) from transcript metadata. |
| **OpenAI Codex** | ✅ from CLI `rate_limits` events | `~/.codex/sessions/**/*.jsonl` | Cumulative counters diffed into per-event deltas. |
| **ChatGPT / ChatGPT Work** | ❌ (OpenAI exposes no usage API for ChatGPT) | Import-based: drop `conversations.json` from the official data export into `~/.franktoken/imports/chatgpt/` (or `chatgpt-work/`) | Tokens are **estimates** (chars/4) — exports carry text, not token counts. Conversations become sessions with timestamps and model slugs. |

**Being precise about what's possible:** per-token metering for Claude.ai chat, Claude
Design, Cowork, and the Office plugins is not exposed by any API — but because Anthropic's
rate limits are unified, the **live windows here already include that usage**, from every
device. Session-level granularity exists wherever transcripts exist locally (any Claude
Code-family surface on this machine), plus whatever you import for ChatGPT.

Costs are **estimates** from a built-in list-price table — treat as guidance, not billing.

## Add a provider (plugin interface)

Drop a file in `src/main/providers/` that default-exports the object described in
[`types.js`](src/main/providers/types.js) (`id`, `name`, `color`, `detect()`, `fetch()`), then add
it to the array in [`registry.js`](src/main/providers/registry.js). The UI, tray, charts,
sessions explorer, and report pick it up automatically (`fetch()` may include a `sessions[]`
array — see `buildSessionSummary` in [`util.js`](src/main/providers/util.js)).

## Develop

```bash
npm install
npm run dev      # hot-reload dev
npm test         # node --test
```

## Build a desktop installer

```bash
npm run dist:win    # NSIS installer (Windows)
npm run dist:mac    # dmg
npm run dist:linux  # AppImage
```

## Architecture

```
src/
  main/                 Electron main process (Node)
    index.js            tray, window, polling + fs watchers, IPC, settings
    report.js           self-contained interactive HTML report generator
    providers/          on-device parsers (the plugin system)
      util.js           paths, JSONL streaming, pricing, cost, session summaries
      claude.js         Claude — all surfaces (live limits + local transcripts)
      codex.js          OpenAI Codex
      chatgpt.js        ChatGPT / ChatGPT Work (export imports)
      registry.js       provider list + fetchAll()
  preload/index.js      contextBridge API
  renderer/             React dashboard (Recharts visuals)
    components/         Overview, ProviderView, SessionsView, ModelsView, …
```

MIT.
