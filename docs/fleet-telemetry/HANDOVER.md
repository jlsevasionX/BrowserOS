# Handover — BrowserOS fork: fleet telemetry (Track B)

_Last updated: 2026-06-25 (Fase 3 MVP subsystem #1 done — central pipeline live, E2E green)_

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
  **Next: subsystem #2** = the agent-query/visualization layer on top of ClickHouse.
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

## Next steps

1. **Subsystem #2** — the agent-query / visualization layer on top of `fleet.events`
   (the north-star: agents query usage to spend their time smarter). Its own spec →
   plan cycle.
2. **Growth path (central-side, device frozen)** — insert OTel + Redpanda in front of
   the ingest, or add a `StoreWriter` that produces to Redpanda; swap ClickHouse to
   managed via env. None of this touches the device.
3. **Close the outstanding live-smoke** — `agent.action` + the agent-side `app.event`
   forward end-to-end through a real LLM chat / built extension.
4. **Optional remaining families** — `network.websocket`, `agent.chat`, `error`.
5. **Fase 5** — fleet identity: fill `device_id`/`company_id`/`user_id` (null today),
   per-device tokens / rotation (MVP uses one static bearer token).

## Open decisions

- **Package brand/namespace** — provisional `@fleet/telemetry` + `fleet-central`; brand TBD.
- **`device_id` source** (Fase 5) — hardware UUID vs generated-and-stored.
- **WebSocket frame capture depth** — metadata-only vs payloads.

## Artifacts

- Docs (in repo): `docs/fleet-telemetry/{adr-0001-network-capture,taxonomy-v0,fase-2-plan,fase-3-mvp-design,fase-3-implementation-plan,HANDOVER}.md`
- Memory: `browseros-project`, `browseros-fork-strategy`, `browseros-dev-env-runbook`,
  `browseros-telemetry-build`, `browseros-remote-build-setup`.
