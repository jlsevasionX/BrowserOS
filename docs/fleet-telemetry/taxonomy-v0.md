# Fleet telemetry — event taxonomy v0

**Status:** Draft (Fase 1, 2026-06-21). Companion to ADR-0001 (capture mechanism).
**Scope decision (Juan):** capture *everything*, including request/response
bodies → **redaction is mandatory**, on-device, before anything leaves the host.

Goal: one unified event stream covering "everything that happens and every
connection", normalized so a central store (OTel → Kafka → ClickHouse) can query
across the fleet. v0 = the schema we build Fase 2 against; expect iteration.

## 1. Common envelope

Every event, regardless of family, is wrapped in:

```jsonc
{
  "schema_version": 0,
  "event_id":   "uuid",          // unique per event
  "ts":         1718900000000,   // wall-clock ms at capture

  // identity / fleet attribution
  "install_id": "string",        // BROWSEROS_INSTALL_ID / browserosId (exists today)
  "device_id":  "string",        // stable per-device id  (TBD source — Fase 5)
  "company_id": "string",        // tenant, from managed policy/enrollment (Fase 5; placeholder now)
  "user_id":    "string|null",   // OS user / SSO subject (placeholder)
  "session_id": "string",        // one browser run

  // build / environment
  "browseros_version": "string",
  "chromium_version":  "string",
  "os": "macos|windows|linux",
  "channel": "dev|dogfood|prod",

  // correlation (null when N/A)
  "tab_id":      "number|null",
  "frame_id":    "string|null",
  "target_type": "page|iframe|service_worker|worker|shared_worker|browser|null",

  // the event
  "type":    "network.request",  // see families below
  "payload": { /* type-specific */ }
}
```

Identity fields already partly exist (`lib/metrics.ts` `MetricsConfig`:
install_id, client_id, versions). `company_id`/`device_id`/`user_id` are
placeholders filled by fleet enrollment (Fase 5).

## 2. Event families (v0)

| `type` | Source (verified) | One per |
|---|---|---|
| `network.request` | CDP Network on primary session (ADR-0001) | completed/failed HTTP request |
| `network.websocket` | CDP `webSocketCreated/Closed/Frame*` | ws lifecycle (frames optional) |
| `navigation` | CDP `Page.frameNavigated` | committed navigation |
| `page.lifecycle` | CDP `Target.targetCreated/Destroyed`, tab activate | tab/target open/close/activate |
| `agent.action` | `agent/tool-adapter.ts` (choke point) | tool execution |
| `agent.mcp_request` | MCP path / Klavis (`api/routes/mcp.ts`) | external connector call |
| `agent.chat` | `agent/ai-sdk-agent.ts` | chat turn (metadata, not content, by default) |
| `app.event` | existing PostHog events → passthrough | product UI event |
| `error` | `lib/sentry.ts` captures | captured exception |

### 2.1 `network.request` payload (the core)

```jsonc
{
  "request_id": "string",
  "method": "GET|POST|...",
  "url": "https://host/path",          // query redacted per policy
  "host": "host",
  "resource_type": "Document|XHR|Fetch|Script|Image|Font|Stylesheet|Ping|Other",
  "initiator": { "type": "parser|script|preload|other", "url": "string|null" },

  "outcome": "ok|failed|canceled",
  "status": 200, "status_text": "OK",
  "mime_type": "application/json",
  "protocol": "h2", "remote_ip": "string|null",
  "from_cache": false,
  "blocked_reason": "string|null", "error_text": "string|null",

  "request_bytes": 0, "response_bytes": 0,   // encodedDataLength
  "timing": { "dns": 0, "connect": 0, "ssl": 0, "ttfb": 0, "total": 0 },

  "request_headers":  { /* redacted */ },
  "response_headers": { /* redacted */ },
  "request_body":  { "captured": true, "size": 0, "sha256": "…", "content": "…|null" },
  "response_body": { "captured": true, "size": 0, "sha256": "…", "content": "…|null" }
}
```

Mechanics (from the spike): metadata from `requestWillBeSent` →
`responseReceived` → `loadingFinished/Failed`; bodies from
`Network.getResponseBody` / `getRequestPostData` **on the primary session**
(ADR-0001 finding 3). `sha256` is always stored even when `content` is
dropped/sampled, so dedup and integrity survive redaction.

### 2.2 `agent.action` payload

```jsonc
{
  "tool": "navigate_page",
  "source": "browser|legacy|mcp",
  "args": { /* redacted */ },
  "result": "ok|error",
  "duration_ms": 0,
  "error": "string|null"
}
```

## 3. Redaction policy (mandatory — bodies are on)

Runs **on-device before emit**, config-driven by managed policy:

1. **Header allow/deny.** Drop value of `Authorization`, `Cookie`, `Set-Cookie`,
   `Proxy-Authorization`, `x-api-key`-like → store `present:true` + hash only.
2. **Body secret-scrub.** Regex-scrub bearer/JWT/API-key patterns, card/IBAN,
   and `password`/`token`/`secret` form fields before storing `content`.
3. **Size cap + sampling.** Cap stored `content` (e.g. 64 KB); larger or binary
   bodies → metadata + `sha256` only. Sample high-volume types (Image/Font/Ping)
   to metadata-only by default; full bodies for Document/XHR/Fetch.
4. **Per-family capture level** (metadata | +headers | +bodies) toggleable by
   policy; internal-fleet default = +bodies with the scrub above.

Operational/legal note (out of legal scope per project decision, but required):
ES *Estatuto de los Trabajadores* art. 20bis → employees must be **informed** of
monitoring (one internal-policy paragraph).

## 4. Mapping the existing ~90 events

- **Server** `lib/metrics.ts` (`browseros.server.*`, incl. `tool_executed`
  rollup, `mcp.request`) → fold into `agent.action` / `agent.mcp_request` (keep
  the rollup/sampling already implemented).
- **Agent UI** `apps/agent/lib/constants/analyticsEvents.ts` (`<area>.<entity>.<action>`)
  → `app.event` passthrough with `payload.name = <original>`.
- Both currently POST to vendor PostHog (`POSTHOG_DEFAULT`) — redirected to our
  pipeline in Fase 4.

## 5. Open questions

- Package namespace `<co>` for the Fase 2 capture package (e.g.
  `packages/fleet-telemetry`) — still TBD (brand/name).
- `device_id` source (hardware UUID vs generated-and-stored) — decided at Fase 5.
- WebSocket frame payloads: capture or metadata-only? (volume vs forensic value).
