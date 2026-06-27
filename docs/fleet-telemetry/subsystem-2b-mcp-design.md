# Subsystem #2b — Agentic access (MCP tool layer over the Query-API)

**Status:** design approved (2026-06-28). Builds on subsystem #2a (`docs/fleet-telemetry/subsystem-2a-query-ui-design.md`, DONE).
**Scope:** SUBSYSTEM #2b only — the MCP tool layer. It does NOT include an LLM, an
autonomous loop, or process-mining (that is #2c).

## 1. Purpose

Subsystem #2a exposed the captured fleet telemetry as a read-only HTTP Query-API
(`fleet-central/query`, `:9401`) plus a human dashboard. #2b makes that **same
contract** available to **agents**: any MCP-capable client (Claude Code today, the
autonomous #2c agent tomorrow, or the in-product BrowserOS agent) can call tools to
investigate fleet usage on demand — "analyze usage of X", "which agent tool fails most
this week", "show me the slowest hosts".

North-star context: future agents consume telemetry to discover business processes
(usage, time, stakeholders, iterations). #2b is the reusable access layer they stand on;
#2c is the autonomous reasoning built on top of it.

## 2. Architecture

A new **`fleet-central/mcp/`** service (Bun + Hono), a sibling to `ingest` and `query`.
It is a **pure, stateless adapter**: it translates MCP tool calls into HTTP calls
against the #2a Query-API and returns the JSON as the tool result. It has **no store,
no LLM, no writes**, and adds **no query capability beyond what #2a already exposes**.

```
MCP client (Claude Code today / #2c agent tomorrow)
   │  StreamableHTTP + Bearer MCP_TOKEN
   ▼
fleet-central/mcp        (:9402)
   │  GET /v1/... + Bearer QUERY_TOKEN   (by service name: http://query:9401)
   ▼
fleet-central/query      (:9401)   ──FINAL / query_params──▶  ClickHouse (loopback)
```

**Two secrets, two hops.** The client authenticates to the MCP service with `MCP_TOKEN`;
the MCP service authenticates to the Query-API with `QUERY_TOKEN` (which the client never
sees). The MCP service never touches ClickHouse or the WAL directly — every guarantee
#2a hardened (read-only, `FROM fleet.events FINAL` dedup, all user values bound as
`query_params` → no injection, loopback-only ClickHouse) is inherited for free because
#2b only ever calls the public Query-API.

**Why HTTP-adapter, not in-process:** the design treats the #2a Query-API as the frozen,
public contract. The MCP service depends only on that contract, not on `query/`'s
internals — so `query/` can evolve (or move to managed) without touching #2b, mirroring
the "freeze the expensive, keep the cheap replaceable" principle from Fase 3.

**Why a central HTTP/MCP service, not a local stdio subprocess:** it must be reachable by
local Claude Code today AND by remote / autonomous (#2c) agents tomorrow, and it should
match the StreamableHTTP MCP idiom already used in the monorepo
(`apps/server/src/agent/services/mcp/`).

## 3. Tool surface

Six thin tools, 1:1 with the #2a endpoints. The `fleet_` prefix keeps them
unmistakable inside a client that already has other tools.

| Tool | #2a endpoint | Returns | Own params |
|---|---|---|---|
| `fleet_meta` | `GET /v1/meta` | facets: types+counts, devices, channels, oses, time range | *(common only)* |
| `fleet_usage` | `GET /v1/insights/usage` | top hosts + navigation time series | `top` (N), `bucket` (`hour`\|`day`) |
| `fleet_agent_activity` | `GET /v1/insights/agent-activity` | per-tool execs/error_rate/p50/p95 + MCP scope counts | *(common only)* |
| `fleet_health` | `GET /v1/insights/health` | status families (2xx…5xx/failed), top failing hosts, slowest, error count | *(common only)* |
| `fleet_search_events` | `GET /v1/events` | raw event search | `type`, `host`, `q`, `limit` (≤1000), `offset` |
| `fleet_get_event` | `GET /v1/events/:id` | full event detail | `id` (required) |

**Common params** (every tool except `fleet_get_event`), identical to the #2a contract:
`from` / `to` (ISO or epoch-ms, default last 24h), `device_id`, `session_id`,
`install_id`, `channel`, `os`, `limit`, `offset`.

**Contract details:**

- **Input schema with zod** per tool → validates before any network call (bad params are
  caught by zod, not by ClickHouse).
- **Output:** the #2a `{data, meta}` JSON returned verbatim as the tool result's text
  content. `meta` already carries the resolved time window / counts, so the agent knows
  exactly which window it queried.
- **Rich descriptions:** each tool describes what it answers and when to use it — critical
  for an autonomous agent (#2c) to choose correctly. `fleet_meta` is described explicitly
  as *"start here to discover what types / devices / time range exist before querying"*.
- **No composite tools** (per the thin-wrappers decision). The agent composes:
  `fleet_meta` → refine → `fleet_usage` / `fleet_search_events`, etc. If #2c reveals a
  repeated multi-query pattern, a composite tool is added there, not here.

## 4. Components

Files under `fleet-central/mcp/`, mirroring `query/`:

| File | Role |
|---|---|
| `src/index.ts` | Startup: port 9402, requires `MCP_TOKEN` + `QUERY_BASE_URL` + `QUERY_TOKEN`, builds the `QueryClient` + MCP server, starts Hono. |
| `src/app.ts` | Hono: Bearer middleware (`MCP_TOKEN`) over `/mcp`, mounts `StreamableHTTPTransport`; unauthenticated `GET /health`. |
| `src/query-client.ts` | **The seam.** HTTP adapter `QueryClient` with one method per endpoint (`meta()`, `usage(p)`, `agentActivity(p)`, `health(p)`, `searchEvents(p)`, `getEvent(id)`). Builds the querystring, `fetch`es with `Bearer QUERY_TOKEN` + `AbortSignal.timeout`, maps non-2xx to a typed error. Interface `QueryClient` → `HttpQueryClient` (real) / `FakeQueryClient` (tests). Same pattern as #2a's `QueryReader` / ingest's `StoreWriter`. |
| `src/tools.ts` | Registry: array of `{name, description, inputSchema (zod), handler(client, args)}` — the 6 tools. Single source of truth. |
| `src/server.ts` | `createMcpServer(client)` using `@modelcontextprotocol/sdk`: iterates `tools.ts`, registers each tool, maps result→content / error→`isError`. |
| `src/params.ts` | `buildCommonQuery(args)` — common params → querystring. Serializes only; it does NOT reimplement #2a's parsing/clamping (that lives server-side in `query`). |
| `Dockerfile`, `.dockerignore` | Mirror `query/`; `EXPOSE 9402`. |
| `src/**/*.test.ts` | See §6. |

## 5. Data flow & error handling

1. MCP client opens a StreamableHTTP session at `/mcp` with `Authorization: Bearer
   MCP_TOKEN`. Missing/wrong token → `401` before any tool runs.
2. Client issues `tools/call`. The tool's zod schema validates args; invalid → tool
   result `isError` with the validation message (no network call made).
3. The handler calls the matching `QueryClient` method → `GET http://query:9401/v1/...`
   with `Bearer QUERY_TOKEN` and a request timeout.
4. **Query-API 2xx** → `{data, meta}` returned verbatim as the tool result.
5. **Query-API 4xx/5xx** → tool result `isError` with a sanitized message including the
   upstream status (e.g. `"query API returned 400: <body>"`). The `QUERY_TOKEN` is never
   echoed.
6. **Query-API unreachable / timeout** → tool result `isError`: `"telemetry query service
   unavailable"`.

`/health` returns `{status, query}` and is used by docker-compose's healthcheck and for
quick liveness checks; it does a cheap reachability probe of the query service.

## 6. Testing

Same rigor as #2a (TDD, subagent-driven build, per-task review + final opus review).

- **Unit per tool** with `FakeQueryClient`: assert each handler (a) builds the correct
  path/params and (b) maps the `{data, meta}` response correctly. No network, no Docker.
- **Unit `query-client`** with mocked `fetch`: correct querystring, Bearer header present,
  non-2xx → typed error, timeout path.
- **Unit `app`**: `/mcp` with no token → 401; bad token → 401; `/health` → 200.
- **Integration** (skipped without `QUERY_BASE_URL` in the environment, exactly like #2a's
  integration test): a real MCP handshake + one `tools/call` against a live Query-API.

## 7. Deployment & config

- New `mcp` service in the shared `fleet-central/docker-compose.yml`: `depends_on` query
  healthy, reaches it by service name (`QUERY_BASE_URL=http://query:9401`), publishes
  `:9402`.
- New env in `.env.example`: `MCP_TOKEN` (required), `MCP_PORT` (default 9402),
  `QUERY_BASE_URL` (default `http://query:9401`), `QUERY_TOKEN` (reuses the same value as
  the query service).
- **Commit `bun.lock` + `--frozen-lockfile`** in this service's Dockerfile from day one
  (the carried-over #2a follow-up — done right here from the start).

## 8. Acceptance / done criteria

- `bun test` green (unit + skipped integration), `tsc` clean, `bun run check` green.
- E2E live: `docker compose up -d --build` brings up clickhouse + ingest + query + mcp;
  connect Claude Code to `http://localhost:9402/mcp` (Bearer `MCP_TOKEN`) and have it
  answer a real fleet question against the ~948-row sample using only these tools
  (e.g. "which hosts are used most this week and which agent tool fails most?").

## 9. Non-goals (explicitly deferred)

- **No LLM, no autonomous loop** — that is #2c.
- **No new store, no writes, no SQL not already in #2a.**
- **No composite/synthesized tools** — thin 1:1 only; revisit in #2c if a pattern repeats.
- **In-product BrowserOS agent wiring** — the device stays frozen; if/when the product
  agent should investigate the fleet, it connects to this same central MCP service. Not
  part of #2b.
