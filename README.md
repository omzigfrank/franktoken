# FrankToken

FrankToken is a live, fidelity-aware AI consumption observatory. It combines request traces, local CLI sessions, provider usage aggregates, and USD cost into one Electron dashboard (Windows, macOS, Linux) and one shareable browser report.

The v0.3 rebuild adds:

- A central Hub that accepts OTLP/HTTP traces, logs, and metrics in JSON or protobuf.
- Server-sent updates to every open report as soon as a new signal arrives.
- Request-level session drill-down with timestamps, duration, token mix, model, device/user metadata, and cost.
- Cross-session and cross-model comparison charts.
- A coverage control room that labels the detail and freshness actually supplied by each product.
- Docker deployment and token-protected external sharing.
- Built-in OpenAI Organization Usage and Anthropic Usage API reconciliation.
- **Live, account-wide Claude limits** from `api/oauth/usage` — the pool every Claude surface
  draws down (Claude.ai, Claude Code CLI/web/desktop/IDE, Cowork, Design, Office plugins), so
  the 5-hour / weekly / per-model windows reflect usage from **any signed-in device**. OAuth
  credentials are read from `.credentials.json`, `CLAUDE_CONFIG_DIR`, `~/.config/claude`, or
  the **macOS Keychain**, auto-refreshed, with tolerant parsing across every observed
  `limits[]` API shape.
- **File watchers** on every local data root — the dashboard refreshes within seconds of a
  transcript changing, without waiting for a poll tick.
- **Session surface tagging**: local Claude sessions carry the surface they ran on
  (CLI / web / desktop / IDE / Cowork) from transcript metadata, filterable in the explorer.
- **ChatGPT / ChatGPT Work import**: OpenAI exposes no usage API for consumer ChatGPT, so drop
  the official data export's `conversations.json` into `~/.franktoken/imports/chatgpt/` (or
  `chatgpt-work/`) and conversations become sessions with timestamps, model slugs, and
  clearly-labeled estimated tokens (chars/4).
- **One-click shareable snapshot**: the "⬡" button exports a **single self-contained HTML
  report** (no external assets) with interactive charts, session flyouts, and 4-way session
  comparison overlays — for sharing without standing up a Hub.

![FrankToken icon](resources/icon.png)

## What “live” means

FrankToken does not pretend every vendor surface exposes the same data. It takes the most granular official feed available and labels both coverage and freshness.

| Surface | Best supported source | Best detail | Typical freshness |
|---|---|---:|---:|
| Claude Code | OpenTelemetry + local transcripts | Request and session | Seconds |
| Claude Cowork | OpenTelemetry | Prompt/request/tool metadata | Seconds |
| Claude for PowerPoint | Office Agent OTLP/HTTP | Turn/request/tool metadata | Seconds |
| Claude for Word | Office Agent OTLP/HTTP | Turn/request/tool metadata | Seconds |
| Claude web | Enterprise Analytics / Compliance adapter | Product/model or auditable activity | Provider-delayed |
| Claude Design | Enterprise Analytics adapter | Product/model aggregate | Provider-delayed |
| Claude API | Usage API | Minute × model × workspace/key | About five minutes |
| Codex | Local transcripts; workspace analytics adapter | Local request; cloud aggregate | Seconds locally |
| ChatGPT | Workspace analytics / Compliance adapter | Workspace activity | Provider-defined |
| ChatGPT Work | Workspace and Codex analytics adapters | Workspace/user/model aggregate | Provider-defined |
| OpenAI API | Organization Usage API | Minute × model × project/user/key | Minutes |
| ChatGPT (personal) | Official data export import | Conversation/message (estimated tokens) | Manual |

Vendor reality matters: provider admin APIs are reconciliation feeds, not second-by-second event streams. Public provider documentation also does not promise personal ChatGPT or Claude users a token-level export for every web conversation. FrankToken therefore never scrapes private UI state or invents per-session precision.

To add a provider, drop a file in `src/main/providers/` that default-exports the object
described in [`types.js`](src/main/providers/types.js) (`id`, `name`, `color`, `detect()`,
`fetch()`), emit `sessions[]` via [`sessions.js`](src/main/providers/sessions.js), and add it
to the array in [`registry.js`](src/main/providers/registry.js). The UI, tray, charts, hub
sync, and report pick it up automatically.

Official capability references: [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage), [Claude Code Analytics API](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api), [Cowork OpenTelemetry](https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry), [Office Agents OpenTelemetry](https://support.claude.com/en/articles/14447276-configure-a-custom-opentelemetry-collector-for-office-agents), [Anthropic Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), [OpenAI Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage), and [ChatGPT workspace analytics](https://learn.chatgpt.com/docs/enterprise/workspace-analytics).

## Architecture

```text
Claude Code ─┐
Cowork ──────┤ OTLP/HTTP (seconds) ───────────┐
Word/PPT ────┘                                │
                                               ▼
Provider admin APIs ── delayed reconcile ─ FrankToken Hub ── SSE ── shareable report
                                               ▲                    desktop clients
Codex/Claude local transcripts ─ desktop ──────┘
```

The Hub stores only telemetry metadata in append-only JSONL. It does not need prompt text, generated text, document contents, or source code.

## Install

Download the installer for your platform from the [latest release](https://github.com/omzigfrank/franktoken/releases/latest):

| Platform | File | Install |
|---|---|---|
| Windows | `FrankToken-<version>-win-x64.exe` | Run it. Installs per-user (no admin prompt) and adds Start Menu + desktop shortcuts. |
| macOS (Apple Silicon) | `FrankToken-<version>-mac-arm64.dmg` | Open, drag to Applications. |
| macOS (Intel) | `FrankToken-<version>-mac-x64.dmg` | Open, drag to Applications. |
| Linux | `FrankToken-<version>-linux-x86_64.AppImage` | `chmod +x` it, then run. |

FrankToken lives in your **system tray / menu bar** — after launching, click the tray icon to open the dashboard. It is not a taskbar app.

**The builds are unsigned** (no code-signing certificates configured), so each OS will warn you the first time:

- **Windows** — SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
- **macOS** — Gatekeeper reports the app is damaged or from an unidentified developer. Clear the quarantine flag once:
  ```bash
  xattr -dr com.apple.quarantine /Applications/FrankToken.app
  ```
- **Linux** — mark the AppImage executable:
  ```bash
  chmod +x FrankToken-*.AppImage && ./FrankToken-*.AppImage
  ```

To cut a new release, push a version tag — CI builds all three platforms and attaches them to a GitHub Release:

```bash
npm version patch      # or: minor / major — commits and tags
git push origin main --follow-tags
```

## Run from source

```bash
npm install
npm run dev
```

The desktop app reads `~/.codex/sessions/**/*.jsonl` and `~/.claude/projects/**/*.jsonl`. In **Settings**, add a FrankToken Hub URL and its read token to merge local history with every device reporting to that Hub.

Build an installer locally with `npm run dist:win`, `npm run dist:mac`, or `npm run dist:linux` — output lands in `dist/`. Each platform must be built on its own OS.

## Deploy the Hub

Copy the example environment file, replace both secrets with independent random values, and start Docker Compose:

```bash
cp .env.example .env
docker compose up -d --build
```

On PowerShell, generate a secret with:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Put the Hub behind HTTPS before sending telemetry over the internet. The default standalone host is `127.0.0.1`; the Docker image intentionally binds `0.0.0.0` and requires secrets through Compose.

Open the read-only external report at:

```text
https://tokens.example.com/share?token=<FRANKTOKEN_SHARE_TOKEN>
```

The ingest token and share token serve different purposes. Do not place the ingest token in a browser URL or share it with report visitors.

## Connect real-time exporters

FrankToken exposes standard OTLP/HTTP endpoints:

```text
POST /v1/traces
POST /v1/logs
POST /v1/metrics
Authorization: Bearer <FRANKTOKEN_INGEST_TOKEN>
```

A typical Claude Code environment points its OTLP exporter at the Hub:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://tokens.example.com
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <FRANKTOKEN_INGEST_TOKEN>"
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
```

Configure Cowork and Office Agents with the same HTTPS collector in their organization telemetry settings. FrankToken maps Office `agent.surface` values to Word, PowerPoint, Excel, and Outlook automatically.

For a source that cannot emit OTLP, use the [normalized ingest schema](docs/INGEST_SCHEMA.md). Stable event keys make retries idempotent.

## Cloud reconciliation

The Hub polls enabled organization APIs once per minute and deduplicates their minute buckets:

```text
FRANKTOKEN_OPENAI_ADMIN_KEY=...
FRANKTOKEN_ANTHROPIC_ADMIN_KEY=...
FRANKTOKEN_ANTHROPIC_ANALYTICS_KEY=...
FRANKTOKEN_CLOUD_POLL_SECONDS=60
```

The Anthropic keys are intentionally separate: `ANTHROPIC_ADMIN_KEY` reads Claude API usage from Claude Console, while `ANTHROPIC_ANALYTICS_KEY` reads product-level Claude Enterprise usage for chat, Claude Code, Cowork, Office Agents, and Claude Design. The provider does not allow the two key types to be interchanged. All keys are read only by the Hub process and are never returned to the browser.

## Cost semantics

- **Provider** means the amount came from a billing/usage source capable of reporting USD.
- **Estimated** means FrankToken multiplied mutually exclusive token categories by its local model pricing table.
- The UI always labels estimates; it never presents them as an invoice.

Pricing changes over time, so provider billing remains the source of truth. Add new pricing aliases in `src/main/providers/util.js` when models change.

## Test and build

```bash
npm test
npm run build
npm run hub
```

The test suite covers local transcript normalization, session aggregation, OTLP JSON, and OTLP protobuf decoding.

MIT.
