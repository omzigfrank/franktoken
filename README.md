# FrankToken

FrankToken is a live, fidelity-aware AI consumption observatory. It combines request traces, local CLI sessions, provider usage aggregates, and USD cost into one Electron dashboard and one shareable browser report.

The v0.2 rebuild adds:

- A central Hub that accepts OTLP/HTTP traces, logs, and metrics in JSON or protobuf.
- Server-sent updates to every open report as soon as a new signal arrives.
- Request-level session drill-down with timestamps, duration, token mix, model, device/user metadata, and cost.
- Cross-session and cross-model comparison charts.
- A coverage control room that labels the detail and freshness actually supplied by each product.
- Docker deployment and token-protected external sharing.
- Built-in OpenAI Organization Usage and Anthropic Usage API reconciliation.

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

Vendor reality matters: provider admin APIs are reconciliation feeds, not second-by-second event streams. Public provider documentation also does not promise personal ChatGPT or Claude users a token-level export for every web conversation. FrankToken therefore never scrapes private UI state or invents per-session precision.

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

## Run the desktop app

```bash
npm install
npm run dev
```

The desktop app reads `~/.codex/sessions/**/*.jsonl` and `~/.claude/projects/**/*.jsonl`. In **Settings**, add a FrankToken Hub URL and its read token to merge local history with every device reporting to that Hub.

Build an installer with `npm run dist:win`, `npm run dist:mac`, or `npm run dist:linux`.

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
