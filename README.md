# FrankToken

An **OS-agnostic, GUI-rich** system-tray app that shows your AI coding usage limits, token
consumption, and estimated cost across providers. Runs on **Windows, macOS, and Linux**
(Electron + React).

![tray + dashboard](resources/icon.png)

## What it does

- **System-tray icon** with a live tooltip + context menu showing the peak rate-limit window.
- **Rich dashboard window** (click the tray icon) with:
  - Usage **rings** and **window bars** (5-hour + weekly) with reset countdowns.
  - **Token breakdown** (input / output / cached / reasoning).
  - **Estimated cost** today and over 30 days.
  - **Per-day area & bar charts** (Recharts) per provider and combined.
  - **Overview** page aggregating every provider.
- **Privacy-first**: everything is parsed **on-device** from local CLI session files. Nothing is
  uploaded.
- **Accurate local totals**: every transcript in the selected range is scanned. Claude streaming
  snapshots and copied branch history are deduplicated by message ID, while Codex cumulative
  counters are converted into per-event deltas without double-counting cached input.

## Providers (v1)

| Provider | Source | Windows | Notes |
|----------|--------|---------|-------|
| **OpenAI Codex** | `~/.codex/sessions/**/*.jsonl` | Live (`rate_limits`) | 5h + weekly reported by the CLI |
| **Claude Code** | `api/oauth/usage` (live) + `~/.claude/projects/**/*.jsonl` | Live | real 5h / weekly / per-model limits via the OAuth token in `~/.claude/.credentials.json` (read-only, never rewritten); tokens & cost charts from transcripts. Falls back to a token-volume estimate if the token is missing/expired. |

Costs are **estimates** from a built-in pricing table — treat as guidance, not billing.
Token totals cover local Claude Code and OpenAI Codex activity. They do not include unrelated
Anthropic or OpenAI API usage from other applications or organization-level API keys.

## Add a provider (plugin interface)

Drop a file in `src/main/providers/` that default-exports the object described in
[`types.js`](src/main/providers/types.js) (`id`, `name`, `color`, `detect()`, `fetch()`), then add
it to the array in [`registry.js`](src/main/providers/registry.js). The UI, tray, and charts pick
it up automatically.

## Develop

```bash
npm install
npm run dev      # hot-reload dev
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
    index.js            tray, window, polling, IPC, settings
    providers/          on-device parsers (the plugin system)
      util.js           paths, JSONL streaming, pricing, cost
      codex.js          OpenAI Codex
      claude.js         Claude Code
      registry.js       provider list + fetchAll()
  preload/index.js      contextBridge API
  renderer/             React dashboard (Recharts visuals)
```

MIT.
