# Handover — BrowserOS fork: fleet telemetry (Track B)

_Last updated: 2026-06-28 (Subsystem #2a done — read-only Query-API + dashboard live on the central store; pushed to origin/dev)_

## TL;DR — where we are

- The fork is consolidated on the **monorepo** and the dev loop runs.
- **Track B (fleet telemetry)** is the active workstream. Fase 0 + Fase 1 **done**.
  **Fase 2 COMPLETE (M1–M6), all committed.** The capture layer records 6 of the
  9 taxonomy-v0 families into an on-disk JSONL WAL: `network.request` (headers +
  redacted bodies), `navigation`, `page.lifecycle`, `agent.action`,
  `agent.mcp_request`, and `app.event` (product-UI events forwarded from the
  extension). **Live-smoked green** (M2–M6 CDP families + the server half of the
  push families). `bun run check` green.
- **Fase 3 MVP (subsystem #1) DONE** — the WAL now ships to Juan's own central
  pipeline. Device-side **Shipper** drains rotated WAL segments → `POST /v1/events`
  (bearer token) → standalone **`fleet-central/`** Bun ingest (Hono) → **ClickHouse**
  (`ReplacingMergeTree`, dedup by `event_id`), all in Docker (local now → AWS by
  swapping `.env`). At-least-once; the device contract is frozen at URL+token so
  OTel/Redpanda/managed slot in central-side later. **E2E green** (see §Fase 3 MVP).
- **Subsystem #2 SCOPED, #2a DONE** — #2 (make the captured data usable) was
  decomposed into **#2a** Query-API core + human dashboard (DONE), **#2b** agentic
  access (NEXT), **#2c** autonomous process-mining. #2a = a new read-only
  `fleet-central/query/` Bun+Hono service over ClickHouse `fleet.events` + a static
  no-build dashboard, live on `:9401`. **E2E green** against the ~948-row sample (see
  §Subsystem #2a). **Next: subsystem #2b** = expose the same Query-API as agent tools.
- **Outstanding live-smoke** (unit/server-verified only): `agent.action` and the
  agent-side `app.event` forward end-to-end through a real LLM chat / built
  extension. Unwired families (optional, post-Fase-2): `network.websocket`,
  `agent.chat`, `error`.
- **Vendor-analytics kill-switch DONE + verified** — no telemetry can egress to
  BrowserOS infra. Our `@fleet/telemetry` layer has **zero third-party egress**
  (local WAL only).
- All committed on branch `dev` (see §Commit trail). **Working tree clean** — all
  Fase 2 work committed; pick up at Fase 3.

## North-star

The central telemetry is for **agents to consume**: a first-party telemetry +
**visualization** system on **Juan's own servers** that future agents query to
understand how the client terminal is used → map/"paint" processes → spend their
time smarter in professional production. **HARD CONSTRAINTS: telemetry goes ONLY to
his servers, never any third party, and must not stay merely local** (the Fase-2
local WAL is just a buffer; Fase 3 ships it onward). Fase 3 = own central pipeline
(OTel→Kafka→ClickHouse) + an agent-queryable visualization layer.

## Repo & machine

- Single source of truth: `/Users/juanlopez/agent/agentic-browser/BrowserOS/`
  (monorepo). Agent lives in `packages/browseros-agent`.
- Branch `dev`. Runs on the Mac Mini (hostname `Mac`); view the browser GUI via VNC.

## Dev loop

From `packages/browseros-agent`, always first:
`export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"`

- Start: `bun run dev:watch`  ·  Stop: `bun run dev:stop`  ·  Setup: `bun run dev:setup`
- Health: `curl http://localhost:9100/health` → `{"status":"ok","cdpConnected":true}`
- Ports: 9000 CDP · 9100 HTTP/MCP · 9300 legacy. Toolchain: node 20, bun 1.3.14, go 1.26.4.
- Per-machine `.env` fixes (gitignored): align `apps/agent/.env.development` ports to
  9000/9100/9300; comment out empty `GRAPHQL_SCHEMA_PATH=`.

## The capture layer — `packages/fleet-telemetry/`

Merge-isolated additive package (`@fleet/telemetry`). Imports only `@browseros/shared`,
`@browseros/cdp-protocol`, `zod` — **no server internals**. Wired at one seam in
`apps/server/src/main.ts`.

**Data flow:** CDP (root auto-attach, pause-on-start → byte-0) → `CaptureController`
(correlate; fetch body on the OWNING session at `bodies` level) → `Redactor`
(mandatory, on-device) → `Normalizer` (taxonomy-v0 envelope) → `LocalSink` (JSONL WAL).

| File | Role |
|---|---|
| `src/create.ts` | Factory `createTelemetry(deps, config?)`; default OFF → inert. Builds LocalSink + CaptureController. |
| `src/config.ts` | `resolveTelemetryConfig(env)` (zod). |
| `src/types.ts` | Structural contracts (no server imports). |
| `src/controller.ts` | Lifecycle: auto-attach, epoch re-arm, `navigation` + `page.lifecycle` families, `track()` push path. Delegates network to NetworkCapture. |
| `src/network-capture.ts` | `network.request` family: inflight correlation, redirect handling, body fetch on the owning session, redaction, inflight cap. |
| `src/redactor.ts` | Pure redaction: headers→sha256, body scrub (JWT/Bearer/cred fields/IBAN/**Luhn-gated card**), size cap, sha256. |
| `src/normalizer.ts` | Pure CDP→envelope builders (network, navigation, page.lifecycle). |
| `src/sink/local-sink.ts` | JSONL WAL: rotation, total-size cap (drop-oldest + counter), `segments()` drain API for Fase 3. |
| `src/*.test.ts` | 40 unit tests. |
| `scripts/inspect.ts` | **Dev tooling** — human-readable view of the WAL. |

Server-side push families (originate in server/agent code, not CDP):

| File | Role |
|---|---|
| `apps/server/src/lib/fleet-telemetry.ts` | Singleton accessor — holds the controller handle (set in main.ts), exposes `trackAgentAction` / `trackMcpRequest` / `trackAppEvent`. No-op until wired / when disabled. |
| `apps/server/src/agent/tool-adapter.ts` | Emits `agent.action` beside the existing `metrics.log('tool_executed')`. |
| `apps/server/src/api/routes/mcp.ts` | Emits `agent.mcp_request`. |
| `apps/server/src/api/routes/telemetry.ts` | `POST /telemetry/app-event` intake → `app.event`. |
| `apps/agent/lib/metrics/track.ts` | Agent UI `track()` also fire-and-forget POSTs each event to the intake route. |

### Config (env)

| Var | Default | Meaning |
|---|---|---|
| `BROWSEROS_TELEMETRY_ENABLED` | `false` | Master switch; inert when off. |
| `BROWSEROS_TELEMETRY_LEVEL` | `metadata` | `metadata` \| `headers` \| `bodies`. |
| `BROWSEROS_TELEMETRY_BODY_MAX` | `65536` | Stored body cap; larger → truncated (full-body sha256 kept). |
| `BROWSEROS_TELEMETRY_WAL_DIR` | derived | Default `<data dir>/telemetry`. |

`LOG_LEVEL=debug` needed to see per-event logs (orchestrator doesn't set
`NODE_ENV=development`, so logger defaults to `info`).

## How to run & verify

```bash
cd packages/browseros-agent
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

# Capture everything incl. bodies, live:
bun run dev:stop
BROWSEROS_TELEMETRY_ENABLED=true BROWSEROS_TELEMETRY_LEVEL=bodies bun run dev:watch
# …browse, or: curl -s -X PUT "http://localhost:9000/json/new?https://www.cnn.com"

# Drive the push families directly (server half):
curl -s -X POST http://localhost:9100/telemetry/app-event \
  -H 'Content-Type: application/json' -d '{"name":"ui.message.sent","properties":{"len":1}}'   # → 204, app.event
curl -s -X POST http://localhost:9100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                                          # → agent.mcp_request

# 1) Logic — 40 pkg unit tests (+ server accessor/route tests)
bun test packages/fleet-telemetry
bun test apps/server/tests/lib/fleet-telemetry.test.ts apps/server/tests/api/routes/telemetry.test.ts

# 2) See what was captured (the WAL inspector)
bun packages/fleet-telemetry/scripts/inspect.ts            # summary + redaction stats
bun packages/fleet-telemetry/scripts/inspect.ts --samples 5
bun packages/fleet-telemetry/scripts/inspect.ts --bodies   # only events with a captured body
bun packages/fleet-telemetry/scripts/inspect.ts --grep amazon
grep -c '"type":"app.event"' ~/.browseros-dev/telemetry/events.jsonl   # push families land too

# 3) Privacy spot-checks on the raw WAL
grep -o '"Cookie":"[^"]*"' ~/.browseros-dev/telemetry/events.jsonl | head   # must be sha256:
grep -c '\[redacted' ~/.browseros-dev/telemetry/events.jsonl
```

WAL lives at `~/.browseros-dev/telemetry/events.jsonl` (dev; `0700` dir / `0600` files).

## What's verified

- **M2** (network metadata) — live: byte-0 capture on agent-untouched/new tabs (192 events on a fresh cnn.com tab).
- **M3** (headers + bodies + Redactor) — live: 532 bodies on cnn.com, 0 fetch failures, redaction firing; Luhn fix verified.
- **M4** (WAL) — live: ~480 valid JSONL events on disk with real redacted bodies; survived an ungraceful kill (durability via periodic flush).
- **M5a** (navigation + page.lifecycle) — live: 9 navigation + opened/closed lifecycle on cnn.com; no Page.enable error on workers.
- **M5b** (push families) — server half live: `app.event` via `POST /telemetry/app-event` (204) + `agent.mcp_request` via `/mcp` both landed in the WAL with correct envelopes. `agent.action` + agent-side `app.event` forward unit/typecheck-verified only.
- **M6** (NetworkCapture extraction) — `bun run check` green (incl. the integration suite exercising the tool-adapter seam); network re-smoked live.
- All: package + server typecheck, biome, 40 unit tests green; pre-commit hooks green.

**Not yet live-verified (unit-tested instead):** `agent.action` end-to-end (needs
an LLM chat that triggers a tool call); the agent-side `app.event` forward from a
built extension; CDP reconnect re-arm; graceful `close()` stats (`dev:stop`
hard-kills); header redaction live (sample had no auth/cookie headers).

## Privacy / kill-switch

- Our layer = zero third-party egress (local WAL only).
- Upstream vendor analytics (server PostHog, agent-UI PostHog incl. session replay,
  Sentry) **hard-disabled** via `packages/shared/src/constants/fork.ts`
  `VENDOR_TELEMETRY_DISABLED=true` (commit `9de5a2c5`).
- Still-live to `llm.browseros.com` (FUNCTIONAL, not telemetry — left intact):
  LLM provider config + Klavis MCP proxy. Only carries data if the built-in
  BrowserOS LLM/connectors are used vs. own keys. Revisit in Fase 4.

## Key code anchors

- Capture seam in server: `apps/server/src/main.ts` (`createTelemetry` after `cdp.connect()`).
- **Global per-session event hook:** `CdpBackend.onSessionEvent` at `apps/server/src/browser/backends/cdp.ts:457`.
- CDP Network bindings: `packages/cdp-protocol/src/generated/{domains,domain-apis}/network.ts`.
- Agent-action choke point: `apps/server/src/agent/tool-adapter.ts` (emits `agent.action`).
- Server push accessor: `apps/server/src/lib/fleet-telemetry.ts` (`setFleetTelemetry` wired in main.ts).
- WAL dir resolution: `apps/server/src/lib/browseros-dir.ts` `getBrowserosDir()`.

## Commit trail (branch `dev`)

| Commit | What |
|---|---|
| `9de5a2c5` | Hard-disable vendor analytics egress |
| `f7782abd` | Capture layer Fase 2 M1 (skeleton) + M2 (network metadata) |
| `cf3cd320` | M3 — headers + bodies + Redactor (Luhn-gated cards) |
| `5e7c3e53` | M4 — on-disk WAL LocalSink |
| `68350490` | WAL inspector dev tool + handover refresh |
| `828ba097` | M5a — navigation + page.lifecycle families |
| `6231dc4b` | M5b — agent.action push family (track API + accessor) |
| `19ba76ff` | M5b follow-ups — agent.mcp_request + app.event |
| `4ccb4741` | M6 — extract NetworkCapture; Fase 2 closed |

## Fase 3 MVP — central pipeline

Spec `docs/fleet-telemetry/fase-3-mvp-design.md`; plan
`docs/fleet-telemetry/fase-3-implementation-plan.md`. Built subagent-driven (T1–T9).

**Guiding principle — freeze the expensive (device), keep the cheap replaceable
(center).** The device knows ONLY a URL + token and ships our native taxonomy-v0
JSONL. Everything central-side (store engine, OTel, Redpanda, managed hosting) is
swappable without touching a single browser.

**Device side (`packages/fleet-telemetry/`):**
- `src/ship/shipper.ts` — `Shipper` drains `LocalSink.segments()` oldest-first,
  `POST`s each segment, `unlink`s ONLY on `204`; backoff on 5xx/401/network; drops a
  poison (400) segment after N tries. `FetchTransport` = `(url, token, requestTimeoutMs=30s)`
  HTTP with `AbortSignal.timeout` (a hung POST throws → backoff, never wedges the loop).
  Owned by `CaptureController` (start/stop). `LocalSink.forceRotate()` seals the active
  segment each tick so low-volume events ship promptly — this deliberately SUPERSEDES the
  spec's `maxFileAgeMs` (dropped as redundant; the ship interval bounds latency).
- Config (default OFF / inert): `BROWSEROS_TELEMETRY_INGEST_URL`,
  `BROWSEROS_TELEMETRY_INGEST_TOKEN`, `BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS`
  (default 15000). No URL ⇒ Shipper inert, WAL-only (today's behavior).

**Central side (`fleet-central/`, standalone — NOT a Bun workspace member):**
- `ingest/` — Bun + Hono. `POST /v1/events` (bearer auth → 401; JSONL validated
  against a standalone zod envelope mirror; partial-success keeps valid lines and
  returns 204; whole-batch-unparseable → 400). `GET /health`. Writes via a
  `StoreWriter` seam (`MemoryStore` for tests, `ClickHouseStore` in prod).
- `clickhouse/init/01-schema.sql` — `fleet.events`,
  `ENGINE=ReplacingMergeTree(ingested_at)`, `ORDER BY (type, ts, event_id)` ⇒
  at-least-once duplicates collapse under `FINAL`. `payload` stored as JSON string.
- `docker-compose.yml` — ClickHouse (init SQL + persistent volume + healthcheck) +
  ingest (waits on a healthy CH, reaches it by service name). Local now → AWS by
  swapping `.env`. `.env`/`node_modules`/`bun.lock` gitignored.

**Run & verify:**
```
cd fleet-central && cp .env.example .env   # set a strong INGEST_TOKEN
docker compose up --build -d                # → curl localhost:9400/health = {"status":"ok","store":"connected"}
```
Device → central (from `packages/browseros-agent`, PATH exported):
```
BROWSEROS_TELEMETRY_ENABLED=true BROWSEROS_TELEMETRY_LEVEL=bodies LOG_LEVEL=debug \
BROWSEROS_TELEMETRY_INGEST_URL=http://localhost:9400 \
BROWSEROS_TELEMETRY_INGEST_TOKEN=<token> BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS=5000 \
bun run dev:watch
```
Query / dedup:
```
docker compose -f fleet-central/docker-compose.yml exec -T clickhouse clickhouse-client \
  --query "SELECT type, count() FROM fleet.events GROUP BY type ORDER BY 2 DESC"
# dedup net: SELECT count() AS c FROM fleet.events FINAL WHERE event_id='...'
```

**E2E result (2026-06-25, live):** real device → local compose → **948 rows** in
ClickHouse (network.request 924, navigation 18, page.lifecycle 6; 688 with captured
+redacted bodies); total==distinct==FINAL (clean delivery, no loss); dedup proven
through the live ingest (same `event_id` twice → 2 raw, **1 under FINAL**); bad token
→ 401. `bun run check` green after M1 (device half). Integration test (T7) proves
the dedup at the store layer (skipped in CI without `CLICKHOUSE_URL`).

**⚠️ Runtime state (2026-06-25):** the `fleet-central` Docker stack is **LEFT UP**
(`fleet-central-ingest-1` + `fleet-central-clickhouse-1` healthy, holding the E2E
sample). Device dev loop is **STOPPED**. To stop the central stack:
`docker compose -f fleet-central/docker-compose.yml down` (add `-v` to wipe the data
volume). Unrelated containers `agentic-redpanda/postgres/redpanda-console` are Juan's
other infra — leave them.

**Deferred (non-blocking, for subsystem #2 / hardening):** commit `bun.lock` +
`bun install --frozen-lockfile` for reproducible image builds; a blank-body 204
regression test; integration test id → UUID; `controller.test.ts` is 513 lines
(>400 warn) — split during subsystem-#2 work.

## Subsystem #2 — make the captured data usable

The north-star is twofold: **humans** see how the fleet is used, AND **future agents
consume** the telemetry to discover business processes (usage, time, stakeholders,
iterations). Too big for one spec → **decomposed into three sub-projects, each its own
spec → plan → build**, all on the **reusable read-only Query-API contract** #2a defines:

- **#2a — Query-API core + human UI** (DONE). Read-only service + dashboard.
- **#2b — Agentic access** (NEXT). Expose the same Query-API as tools an agent calls
  on demand to investigate ("analyze usage of X"). No new store; sits on #2a.
- **#2c — Autonomous process-mining**. Agent(s) scan the telemetry, detect sequences
  that look like business processes, estimate duration / stakeholders / iterations,
  produce process "maps".

### Subsystem #2a — Query-API + dashboard

Spec `docs/fleet-telemetry/subsystem-2a-query-ui-design.md`; plan
`subsystem-2a-implementation-plan.md`. Built subagent-driven (9 TDD tasks, per-task
review + an opus whole-branch review). On `dev`, pushed to origin (head `5278acab`).

**What it is:** a new **`fleet-central/query/`** Bun+Hono service — sibling to `ingest`,
**strictly read-only** over ClickHouse `fleet.events` (never writes) — plus a static
(no-build) dashboard. It's the durable contract #2b/#2c reuse; an agent can call the
same JSON API a human's browser does (which is why we built our own, not Grafana).

**Hard guarantees (verified in the final review):** read-only; every query uses
`FROM fleet.events FINAL` (collapses at-least-once dupes); all user values bound as
ClickHouse `query_params` (zero string interpolation → no injection); time filters
bound as `Int64` epoch-ms via `fromUnixTimestamp64Milli`; `/v1/*` behind `Bearer
QUERY_TOKEN`; no external CDN at runtime (uPlot vendored under `public/vendor/`); CH
host port bound **127.0.0.1** only (loopback).

**Endpoints** (`{data, meta}` shape; `400` bad params, `401` no token, `503` store down):

| Route | Returns |
|---|---|
| `GET /health` | `{status, store}` |
| `GET /v1/insights/usage` | top hosts (`?top=N`) + navigation time series (`?bucket=hour\|day`) |
| `GET /v1/insights/agent-activity` | per-tool execs/error_rate/p50/p95 + MCP scope counts |
| `GET /v1/insights/health` | status families (2xx…5xx/failed), top failing hosts, slowest, error count |
| `GET /v1/events`, `/v1/events/:id` | raw event search (`?type&host&q&limit&offset`) + full detail |
| `GET /v1/meta` | facets (types+counts, devices, channels, oses, time range) for the UI filters |
| `GET /` | static dashboard (enter `QUERY_TOKEN` when prompted; stored in localStorage) |

Common params: `from`/`to` (ISO or epoch-ms, default last 24h), `device_id`,
`session_id`, `install_id`, `channel`, `os`, `limit` (≤1000), `offset`.

**Files (`fleet-central/query/`):**

| File | Role |
|---|---|
| `src/index.ts` | Startup: port 9401, requires `QUERY_TOKEN`, builds `ClickHouseReader`. |
| `src/app.ts` | Hono: `/health`, `/v1/*` Bearer middleware, all routes, then static fallback (mounted LAST so API wins). |
| `src/params.ts` | `parseCommonParams` — defaults/ISO+epoch/limit clamp; `→{ok,value}`. |
| `src/sql.ts` | `commonFilter` — shared `AND …` WHERE fragment (time range + optional exact filters), bound params. |
| `src/response.ts` | `buildMeta(params, rowCount, startedAt)`. |
| `src/insights/{agent-activity,usage,health,search}.ts` | Pure builders `(params)→{sql,params}` + row mappers. `InsightQuery` defined in agent-activity, reused. |
| `src/reader/{reader,clickhouse-reader,memory-reader}.ts` | `QueryReader` seam (mirrors ingest `StoreWriter`); `ClickHouseReader` (real, `query_params`+JSONEachRow, lazy client, `rawClient()` test hatch); `MemoryReader` (queued result sets) for Docker-free unit tests. |
| `public/{index.html,app.css,app.js}` + `public/vendor/uPlot.*` | Vanilla-JS 4-tab dashboard (Usage/Agent/Health/Explore), token in localStorage, lazy per-tab fetch, explorer row → detail panel. Cells via `textContent` (XSS-safe over captured URLs). |
| `Dockerfile`, `.dockerignore` | Mirror ingest; EXPOSE 9401. |
| `src/**/*.test.ts` | 50 unit + 1 integration (skips without `CLICKHOUSE_URL`; proves `FINAL` dedup). |

Deploy: `query` service added to the shared `fleet-central/docker-compose.yml`
(depends on a healthy ClickHouse, reaches it by service name, publishes `9401`). New
env `QUERY_TOKEN` (required) + `QUERY_PORT` in `.env.example`.

**Run & verify:**
```
cd fleet-central                       # set QUERY_TOKEN in .env
docker compose up -d --build           # brings up clickhouse + ingest + query
curl -s localhost:9401/health          # {"status":"ok","store":"connected"}
T=$(grep QUERY_TOKEN .env | cut -d= -f2)
curl -s -H "authorization: Bearer $T" "localhost:9401/v1/meta" | head -c 300
# open http://localhost:9401/ , enter QUERY_TOKEN
# unit tests + integration:
cd query && bun test                                   # 50 pass, integration skipped
CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_PASSWORD=<pw> bun test src/reader/clickhouse-reader.test.ts
```

**E2E result (2026-06-28, live):** full stack up; `/health` ok; `/v1/meta` returns
real types from the sample (network.request 1561, navigation 45, page.lifecycle 6,
agent.action 2); `/v1/insights/usage?top=3` returns 3 hosts + hour-bucketed nav
series; `/v1/insights/agent-activity` returns per-tool stats; `401` without token.
50 unit tests + tsc clean.

**Bugs caught during review/live-smoke (all fixed):** (1) **ClickHouse `formatDateTime`
uses `%i` for minutes, `%M`=month name** — buckets rendered `08:June:00`; fixed
`%M`→`%i` in usage/search + regression guards (unit tests can't catch this — the
format string only executes against real CH, so **always live-smoke time formatting**);
(2) an over-broad search test forced dropping the host/url SELECT columns (kept the
columns, tightened the test); (3) CH host port was `0.0.0.0` → loopback; (4) removed an
unused `zod` dep, implemented the documented-but-ignored `top` param, clamped `offset`
to UInt32, hardened table rendering against XSS.

**Deferred (non-blocking, post-merge):** commit `bun.lock` + `--frozen-lockfile`
(priority — reproducible Docker builds); `/health` returns 200 when degraded; `opt()`
doesn't trim filter values; `lineChart` x-axis tick→label alignment fragile; README
`## Query` heading is cosmetic. **Never got a live in-browser eyeball** (Chrome
extension not connected) — curl-smoked the served assets + endpoints instead.

**⚠️ Runtime state (2026-06-28):** the `fleet-central` stack is **LEFT UP** — `query`
on `:9401` (rebuilt with all fixes), `ingest` on `:9400`, ClickHouse on
`127.0.0.1:8123`, holding the ~948-row sample. Dashboard at `http://localhost:9401/`,
token **`dev-query-token-456`** (dev value in `.env`). Down:
`docker compose -f fleet-central/docker-compose.yml down` (`-v` wipes data).

### Subsystem #2b — MCP tool layer (agentic access)

Spec `docs/fleet-telemetry/subsystem-2b-mcp-design.md`; plan
`subsystem-2b-implementation-plan.md`. Built subagent-driven (5 TDD tasks, per-task
review + an opus whole-branch review = READY TO MERGE, no Critical/Important). On `dev`,
commits `f6892bff..9de7005c`.

**What it is:** a new **`fleet-central/mcp/`** Bun+Hono service — sibling to `ingest`/
`query` — that exposes the #2a Query-API as **6 MCP tools** any agent can call. It is a
**pure, stateless HTTP adapter**: MCP tool call → HTTP GET against the Query-API
(Bearer `QUERY_TOKEN`) → the `{data, meta}` JSON returned verbatim as the tool result.
**No store, no LLM, no writes, no ClickHouse access** — it depends only on the public
#2a contract (so `query/` can evolve without touching #2b). StreamableHTTP transport,
bearer-gated with `MCP_TOKEN`, on **:9402**.

**Tools (1:1 with #2a endpoints, `fleet_` prefix):** `fleet_meta`, `fleet_usage`,
`fleet_agent_activity`, `fleet_health`, `fleet_search_events`, `fleet_get_event`. Common
params (from/to/device_id/session_id/install_id/channel/os/limit/offset) on every tool
except `fleet_get_event`. Each tool has a rich description so an autonomous agent (#2c)
can pick correctly; `fleet_meta` is "start here to discover what to query".

**Hard guarantees (verified in the final review):** bearer gate registered before the
`/mcp` route (exact-match, covers POST, no bypass); `QUERY_TOKEN` never leaks into tool
results or error messages (explicit regression test); pure-adapter invariant holds (no
`@clickhouse/client` dep, no SQL); per-request server+transport (MCP SDK requirement);
compose service is additive (clickhouse/ingest/query/volumes untouched); `mcp/bun.lock`
tracked via `!mcp/bun.lock` gitignore exception → `--frozen-lockfile` resolves; no real
`.env` committed.

**Files (`fleet-central/mcp/`):**

| File | Role |
|---|---|
| `src/index.ts` | Startup: port 9402, requires `MCP_TOKEN` + `QUERY_TOKEN`, builds `HttpQueryClient` (default `QUERY_BASE_URL=http://query:9401`). |
| `src/query-client.ts` | The seam: `QueryClient` interface → `HttpQueryClient` (fetch + Bearer + `AbortSignal.timeout`, non-2xx → typed `QueryClientError`) / `FakeQueryClient` (tests). Mirrors #2a's `QueryReader`. |
| `src/params.ts` | `buildQuery(args)` — serializes defined args to a querystring. |
| `src/tools.ts` | `TOOLS: ToolDef[]` — the 6 tools (zod `inputSchema` + handler delegating to a `QueryClient` method). Single source of truth. |
| `src/server.ts` | `createMcpServer(client)` — registers all `TOOLS` on an SDK `McpServer`; success → `{content:[text]}`, throw → `{content:[text], isError:true}`. |
| `src/app.ts` | Hono: unauth `GET /health` (probes `client.ping()`), Bearer middleware on `/mcp`, per-request `StreamableHTTPTransport` mount. |
| `Dockerfile`, `.dockerignore` | Mirror `query/`; `bun install --frozen-lockfile`; EXPOSE 9402. |
| `src/**/*.test.ts` | 17 unit tests incl. a real in-memory MCP handshake (SDK `Client` + `InMemoryTransport`). |

Deploy: `mcp` service added to the shared `fleet-central/docker-compose.yml`
(depends_on `query` started, reaches it by service name, publishes `9402`). New env
`MCP_TOKEN` (required) + `MCP_PORT` in `.env.example`.

**Run & verify:**
```
cd fleet-central                       # set MCP_TOKEN in .env (e.g. dev-mcp-token-789)
docker compose up -d --build           # brings up clickhouse + ingest + query + mcp
curl -s localhost:9402/health          # {"status":"ok","query":"connected"}
T=$(grep '^MCP_TOKEN=' .env | cut -d= -f2)
# NOTE: StreamableHTTP needs this Accept header on POST:
curl -s -X POST localhost:9402/mcp \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'      # lists the 6 fleet_ tools
cd mcp && bun test                                          # 17 pass, tsc clean
```

**E2E result (2026-06-28, live):** full stack up incl. `mcp:9402`; `/health` ok; bare
`POST /mcp` → `401`; authed `tools/list` → all 6 `fleet_` tools; `fleet_meta` `tools/call`
returned live data from the ~948-row sample (network.request 1561, navigation 45,
page.lifecycle 6, agent.action 2). 17 unit tests + tsc clean.

**Deferred (non-blocking, post-merge):** non-constant-time bearer compare (consistent
with `query`); `mcp` `depends_on` uses `service_started` (query defines no healthcheck —
only valid option); no compose `healthcheck` wired on the `mcp` service; degraded/down
`/health` path untested. **Claude-Code GUI E2E** (add the server as an HTTP MCP server at
`http://localhost:9402/mcp` with `Authorization: Bearer <MCP_TOKEN>`, ask a real fleet
question) was NOT run — the curl `tools/call` is the accepted fallback acceptance.

**⚠️ Runtime state (2026-06-28):** `mcp` is **LEFT UP** in the stack on `:9402`, token
**`dev-mcp-token-789`** (dev value in `.env`).

## Next steps

1. **Subsystem #2b** — agentic access: **DONE** (see §Subsystem #2b above), `fleet-central/mcp`
   on `:9402`, 6 MCP tools over the #2a contract. **Next: #2c** — autonomous
   process-mining (the full north-star): agents scan the telemetry via these tools (or a
   superset) to detect business-process sequences and estimate duration/stakeholders/
   iterations. Own spec → plan; builds on #2a's Query-API + #2b's tool layer.
2. **#2a hardening** (post-merge, non-blocking) — commit `bun.lock` +
   `--frozen-lockfile` (priority); the smaller deferred items in §Subsystem #2a.
3. **Growth path (central-side, device frozen)** — insert OTel + Redpanda in front of
   the ingest, or add a `StoreWriter` that produces to Redpanda; swap ClickHouse to
   managed via env. None of this touches the device.
4. **Close the outstanding capture-side live-smoke** — `agent.action` + the agent-side
   `app.event` forward end-to-end through a real LLM chat / built extension.
5. **Optional remaining families** — `network.websocket`, `agent.chat`, `error`.
6. **Fase 5** — fleet identity: fill `device_id`/`company_id`/`user_id` (null today),
   per-device tokens / rotation (MVP uses one static bearer token). This is also what
   makes #2a's `device_id`/`company_id` filters meaningful.

## Open decisions

- **Package brand/namespace** — provisional `@fleet/telemetry` + `fleet-central`; brand TBD.
- **`device_id` source** (Fase 5) — hardware UUID vs generated-and-stored.
- **WebSocket frame capture depth** — metadata-only vs payloads.

## Artifacts

- Docs (in repo): `docs/fleet-telemetry/{adr-0001-network-capture,taxonomy-v0,fase-2-plan,fase-3-mvp-design,fase-3-implementation-plan,subsystem-2a-query-ui-design,subsystem-2a-implementation-plan,HANDOVER}.md`
- Memory: `browseros-project`, `browseros-fork-strategy`, `browseros-dev-env-runbook`,
  `browseros-telemetry-build`, `browseros-remote-build-setup`.
