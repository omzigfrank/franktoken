# FrankToken normalized ingest

Use `POST /api/ingest` for an integration that cannot export OTLP. Send one event, an array, or `{ "events": [...] }` with `Authorization: Bearer <FRANKTOKEN_INGEST_TOKEN>`.

```json
{
  "key": "globally-stable-request-id",
  "sessionId": "conversation-or-session-id",
  "ts": 1786795200000,
  "durationMs": 1840,
  "provider": "claude-design",
  "product": "Claude Design",
  "model": "claude-sonnet-5",
  "input": 820,
  "cachedInput": 400,
  "cacheWrite": 0,
  "output": 210,
  "reasoning": 0,
  "total": 1430,
  "usd": 0.00591,
  "costKind": "estimated",
  "sourceType": "admin-api",
  "sourceLabel": "Enterprise Analytics API",
  "freshness": "4 hours",
  "title": "Design session · Homepage",
  "device": "web",
  "user": "user@example.com",
  "status": "ok"
}
```

`key` must remain stable across retries so the Hub can deduplicate. Sending the same key with changed values revises that event, which lets delayed billing feeds replace estimates. Token categories should be mutually exclusive; `total` must equal their sum. Set `costKind` to `provider` only when `usd` came from a billing source. Never send prompt text, completion text, or document contents—the report needs metadata and counts, not content.

OTLP/HTTP exporters can send JSON or protobuf directly to `/v1/traces`, `/v1/logs`, and `/v1/metrics`. FrankToken recognizes OpenTelemetry GenAI fields plus the Claude Code, Cowork, and Office Agent token/session attributes described in the provider documentation.
