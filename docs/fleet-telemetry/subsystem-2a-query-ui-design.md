# Subsystem #2a — Query-API core + human UI

**Status:** Design approved (2026-06-27). Companion to the Fase-3 MVP (subsystem #1: transport + ingest + store).
**Author:** brainstormed with Juan.
**Scope:** The read-only query + visualization layer over `fleet.events`. First of three sub-projects that make up subsystem #2.

---

## 0. Context & decomposition

Subsystem #1 (Fase 3 MVP, DONE) lands fleet telemetry into ClickHouse `fleet.events`
(`ReplacingMergeTree(ingested_at)`, dedup by `event_id`, envelope columns +
`payload` as a JSON **String**). See `fase-3-mvp-design.md` and the taxonomy in
`taxonomy-v0.md`.

Subsystem #2 — "make the captured telemetry usable" — is the north-star: a
first-party query + visualization system on Juan's servers that **humans** use to
see how the fleet is used AND that **future agents** consume to reason about how
the terminal is used (discover business processes, time them, map stakeholders and
iterations). That is too large for one spec, so it is decomposed:

- **#2a (this spec)** — Query-API core + human UI. The read-only contract over
  `fleet.events` plus a minimal dashboard. Prerequisite for the other two.
- **#2b (later)** — Agentic access: expose the same Query-API as tools an agent
  can call on demand to investigate ("analyze usage of X").
- **#2c (later)** — Autonomous process-mining: agent(s) that scan the telemetry,
  detect sequences that look like business processes, estimate
  duration/stakeholders/iterations, and produce process "maps".

#2a is built first because #2b and #2c both consume the Query-API contract it
defines. **Decision (Juan): start with #2a.**

### Constraints driving the design
- **Consumers:** both humans and agents — so the core is a reusable Query-API; the
  UI is just its first consumer. (Decision: "ambos a la vez".)
- **Insights v1:** fleet usage, agent activity, health/errors, raw exploration.
  (Decision, multi-select.)
- **Access/footprint:** single operator (Juan), local / Tailscale, token auth like
  ingest, lightweight UI served by the same service. (Decision: "solo tú, local,
  mínimo".)
- **First-party only:** no third-party BI/vendor; no external egress (matches the
  project's "own it, no vendors" + vendor-kill-switch principle). This is also why
  a custom service beats pointing Grafana/Metabase at ClickHouse — an agent cannot
  consume Grafana, but it can consume our Query-API.

### Chosen approach (A)
Read-only `query` Bun+Hono service in `fleet-central/`, **fixed parameterized
endpoints per insight** + a raw-search endpoint, serving one static dashboard page
(no frontend build). Mirrors the existing `ingest` service patterns exactly.
Rejected: (B) a query-builder/DSL — premature, that flexibility belongs to #2b
with its own safeguards; (C) Grafana/Metabase — no reusable agent-facing contract,
adds a vendor, awkward with JSON-string payloads.

---

## 1. Architecture & placement

New sibling service to `ingest`, **read-only** — never writes to ClickHouse,
reuses the existing ClickHouse container (reached by service name, like ingest).

```
fleet-central/
  ingest/                       (exists, unchanged)
  query/                        ← NEW read-only Bun+Hono service
    src/
      index.ts                  startup: port 9401, reads QUERY_TOKEN + CLICKHOUSE_*
      app.ts                    Hono routes: Bearer auth + insight endpoints + raw + static
      params.ts                 zod parse/validate of common query params (range, filters, limits)
      reader/
        reader.ts               interface QueryReader (seam, like StoreWriter)
        clickhouse-reader.ts    @clickhouse/client impl, parameterized SELECTs
        memory-reader.ts        in-memory fake for tests (no Docker)
      insights/
        usage.ts                fleet usage  (pure: params -> {sql, params, mapRow})
        agent-activity.ts       agent activity
        health.ts               health / errors
        search.ts               raw event search + by-id + meta facets
    public/
      index.html                static dashboard (no build step)
      app.js, app.css           fetch endpoints + render charts
      vendor/uplot.*            vendored chart lib (no external CDN)
    package.json, tsconfig.json, Dockerfile
  docker-compose.yml            ← add "query" service (depends on clickhouse healthy)
```

**Data flow:** static UI → `GET /v1/insights/*` and `/v1/events*` (JSON) →
`ClickHouseReader` (parameterized SELECT, never client SQL) → ClickHouse
`fleet.events`.

**Isolation:** each insight is a pure module `(validatedParams) → {sql, params,
mapRow}`, testable against `MemoryReader` without Docker. `app.ts` only
orchestrates (auth, parse, call reader, shape response). The UI knows no SQL.

---

## 2. Query-API contract

### Common conventions (all endpoints)
- **Auth:** `Authorization: Bearer <QUERY_TOKEN>` → `401` if missing/mismatch
  (same shape as ingest `app.ts`).
- **Response:** `{ "data": [...], "meta": { range, filters, row_count, elapsed_ms } }`.
- **Common query params** (validated in `params.ts` with zod; passed as ClickHouse
  `query_params`, NEVER interpolated into the SQL string):
  - `from`, `to` — ISO or epoch ms. Default: last 24h. Map to `ts`.
  - `device_id`, `session_id`, `install_id`, `channel`, `os` — optional exact filters.
  - `limit` (default 100, max 1000), `offset`.

### Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{status, store}` (like ingest) |
| `GET` | `/v1/insights/usage` | Top hosts/domains by request count + navigation count; time series of navigations per bucket. Extra params: `top` (N hosts), `bucket` (`hour`\|`day`). Source: `type IN (network.request, navigation)`. |
| `GET` | `/v1/insights/agent-activity` | Per `tool` (from `agent.action`): execution count, `error_rate`, duration p50/p95; plus `agent.mcp_request` counts per `scope_id`. Source: `type IN (agent.action, agent.mcp_request)`. |
| `GET` | `/v1/insights/health` | Counts per status family (2xx/3xx/4xx/5xx/failed), top failing hosts, slowest requests (p95 `timing.total`), `type=error` count. Source: `network.request` + `error`. |
| `GET` | `/v1/events` | Raw search: events (envelope + payload) ordered by `ts DESC`, paginated. Extra params: `type` (exact family), `host`, `q` (substring over `url`/`tool`). Forensic explorer. |
| `GET` | `/v1/events/:event_id` | One full event (incl. payload with already-redacted bodies). Explorer detail. |
| `GET` | `/v1/meta` | Facets to populate UI filters: distinct `channel`, `os`, `device_id`; list of `type` with counts; available time range (min/max `ts`). |

**Notes:**
- Fixed per-insight endpoints (approach A): adding an insight = one `insights/*.ts`
  module + one route; touches nothing else.
- No free-SQL endpoint in #2a (that is #2b territory, with its own safeguards).
- `/v1/meta` keeps the UI data-driven (no hardcoded devices/types) and doubles as
  dataset documentation for #2b/#2c.

---

## 3. ClickHouse query layer

**Central challenge:** `payload` is stored as a JSON **String**
(`clickhouse-store.ts:54`), so business fields (`host`, `url`, `tool`, `status`,
`timing.total`, `scope_id`, `result`, `duration_ms`) live inside the string and are
extracted in SQL:
- `JSONExtractString(payload, 'host')`, `JSONExtractString(payload, 'tool')`
- `JSONExtractInt(payload, 'status')`
- `JSONExtractFloat(payload, 'timing', 'total')` (nested path)
- `JSONExtractString(payload, 'result')` for `error_rate`

**`QueryReader` seam** (interface, mirror of `StoreWriter`):
```ts
interface QueryReader {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  health(): Promise<boolean>
  close(): Promise<void>
}
```
- `ClickHouseReader` uses `@clickhouse/client` with native **`query_params`**
  (`{name:Type}` binding). User values are NEVER string-interpolated into SQL; only
  the insight module's fixed SQL is composed. This closes injection.
- `MemoryReader` for tests: holds rows in memory + a simple matcher, no Docker.

**Each `insights/*.ts` is pure:** `(validatedParams) → {sql, params, mapRow}`.
Example `agent-activity`:
```sql
SELECT JSONExtractString(payload,'tool') AS tool,
       count() AS executions,
       countIf(JSONExtractString(payload,'result')='error')/count() AS error_rate,
       quantile(0.5)(JSONExtractFloat(payload,'duration_ms'))  AS p50_ms,
       quantile(0.95)(JSONExtractFloat(payload,'duration_ms')) AS p95_ms
FROM fleet.events FINAL
WHERE type='agent.action' AND ts BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
  AND ({device_id:String}='' OR device_id={device_id:String})
GROUP BY tool ORDER BY executions DESC LIMIT {limit:UInt32}
```

**Dedup decision — `ReplacingMergeTree`:** the table dedups by `event_id` but the
merge is asynchronous, so transient duplicates can exist. For read correctness, all
queries use **`FROM fleet.events FINAL`**. At 20–500 devices the `FINAL` cost is
acceptable and prioritizes correctness over micro-optimization (consistent with
"freeze cheap, keep correct"). If it ever hurts, switch to explicit `event_id`
dedup central-side without touching the device.

**Time range & buckets:** `from`/`to` → `BETWEEN {from} AND {to}`; time series via
`toStartOfHour(ts)` / `toStartOfDay(ts)` per `bucket`. Safe defaults (24h, limit
100) applied in `params.ts` before reaching the reader.

**Error handling:** ClickHouse failure → endpoint returns `503
{error:"store_unavailable"}` (not an opaque 500); invalid params → `400` with zod
detail; `/health` reflects `store.health()`.

---

## 4. UI (static dashboard, no build)

**Philosophy:** dumb UI — only `fetch` + render. No business logic, no SQL, no
bundling pipeline. Served by the `query` service from `public/` (Hono serves
static).

**Minimal stack:** HTML + vanilla JS (native ES modules, no React/build);
**uPlot** for charts (vendored in `public/vendor/`, ~40KB, no external CDN →
respects first-party / no-egress); own light CSS, simple dark theme.

**Single page with tabs:**
```
┌─ Fleet Telemetry ───────────────── [token in localStorage] ─┐
│ Filters (from /v1/meta): [range ▼] [device ▼] [channel ▼] [os ▼]   │
├────────────────────────────────────────────────────────────────────┤
│ Tabs:  Usage  |  Agent  |  Health  |  Explore                       │
│  [Usage]    navigations time series + top-hosts table               │
│  [Agent]    tools table (exec / error_rate / p50 / p95) + MCP scopes│
│  [Health]   status bars 2xx..5xx + top failing hosts + slowest      │
│  [Explore]  raw events table (filters type/host/q) → row click =    │
│             detail panel with full event (payload + redacted bodies)│
└────────────────────────────────────────────────────────────────────┘
```

**Auth in UI:** first access prompts for `QUERY_TOKEN`, stored in `localStorage`,
sent as `Bearer` on every fetch. A `401` re-prompts. Enough for "just you, local".

**Details:**
- Each tab calls its endpoint only when activated (lazy), honoring the global filters.
- The explorer is the "raw exploration" face: paginated (`limit`/`offset`), row
  click → `GET /v1/events/:id` → panel with formatted envelope + payload (bodies
  arrive already redacted from the device).
- Visible loading/error states (spinner, message if store is down).
- No framework = a single `app.js` that could grow; if it passes ~300 lines, split
  per tab (`tabs/usage.js`, etc.) — same isolation criterion as the backend.

This is the browser-side, central-store counterpart of the existing console WAL
viewer (`packages/fleet-telemetry/scripts/inspect.ts`).

---

## 5. Auth, config & deploy

**Config (env, mirrors ingest `index.ts`):**
- `QUERY_PORT` (default `9401`)
- `QUERY_TOKEN` (**required**; process exits if missing, like `INGEST_TOKEN`)
- `CLICKHOUSE_URL` (default `http://clickhouse:8123`), `CLICKHOUSE_DB` (`fleet`),
  `CLICKHOUSE_USER` (`default`), `CLICKHOUSE_PASSWORD` (`''`)

**docker-compose:** add a `query` service to the existing
`fleet-central/docker-compose.yml`: builds `query/Dockerfile` (same shape as
ingest), `depends_on: clickhouse (condition: service_healthy)`, publishes
`9401:9401`, reads the same `.env`. Add `QUERY_TOKEN` to `.env.example`.

**Network posture:** local / Tailscale only. The port is not exposed publicly; the
Bearer token is the only gate. No CORS needed (UI served same-origin by the
service).

**Reuse:** ClickHouse container, network, and `.env` are shared with ingest. No new
infra beyond the one container for the query service.

---

## 6. Testing

- **`params.ts`** (unit, no Docker): defaults applied, range parsing (ISO + epoch),
  limit clamping (max 1000), invalid input → zod error.
- **Each `insights/*.ts`** (unit, `MemoryReader`): given seeded rows, the module
  produces the expected aggregation shape (counts, error_rate, percentiles,
  ordering, limit). Pure SQL builders verified by running against the in-memory
  matcher.
- **`app.ts`** (unit, `MemoryReader` + Hono test client, like `ingest/app.test.ts`):
  `401` without/with bad token; `200` shape `{data, meta}`; `400` on bad params;
  `503` when reader throws; `/health`; `/v1/meta` facets; `/v1/events/:id` 200 + 404.
- **ClickHouse integration** (one test, real container, like
  `clickhouse-store.test.ts`): seed a handful of taxonomy-v0 events via the ingest
  path (or direct insert), then assert each insight endpoint returns correct
  numbers — including that `FINAL` collapses a duplicated `event_id`.
- **`bun run`/`bun test` green** + `tsc --noEmit` for the new service.
- **E2E smoke (manual, documented):** bring up compose, point the UI at it with the
  existing E2E sample (948 rows) still in ClickHouse, eyeball each tab renders and
  the explorer detail opens.

---

## 7. Out of scope (deferred)

- **#2b** — agentic access (Query-API as agent tools / free-er query surface with
  safeguards).
- **#2c** — autonomous process-mining (business-process discovery, duration,
  stakeholders, iterations).
- **Multi-tenant / per-company auth** — `device_id`/`company_id`/`user_id` are still
  null until Fase 5; filters accept them but no tenancy enforcement now.
- **Writes / retention / TTL management** — query service is strictly read-only;
  retention is a store concern handled elsewhere.
- **Alerting / scheduled reports** — not in v1.
- **`network.websocket`, `agent.chat`, `error`-family richness** — these families
  are only partly wired upstream; insights cover what is reliably populated today
  (`network.request`, `navigation`, `page.lifecycle`, `agent.action`,
  `agent.mcp_request`, `app.event`). `error` is read opportunistically in the health
  insight.

---

## 8. Open questions (non-blocking)

- uPlot vs a tiny hand-rolled SVG bar/line renderer — decide at build time; uPlot is
  the default unless vendoring proves annoying.
- Whether `/v1/events` `q` substring should also search inside `payload` bodies
  (heavier) or only `url`/`tool` (chosen default for v1).
- Default time range (24h chosen) — trivially tunable.
