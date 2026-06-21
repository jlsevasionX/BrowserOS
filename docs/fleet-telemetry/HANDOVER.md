# Handover — BrowserOS fork: fleet telemetry (Track B)

_Last updated: 2026-06-22_

## TL;DR — where we are

- The fork is consolidated on the **monorepo** and the dev loop runs.
- **Track B (fleet telemetry)** is the active workstream. Fase 0 + Fase 1 **done**.
  **Fase 2 M1–M4 DONE and committed** — the capture layer records `network.request`
  with headers + redacted bodies into an on-disk JSONL WAL. **Live-smoked green**
  (M2/M3/M4). Remaining in Fase 2: **M5** (more event families) + **M6** (`bun run check`).
- **Vendor-analytics kill-switch DONE + verified** — no telemetry can egress to
  BrowserOS infra. Our `@fleet/telemetry` layer has **zero third-party egress**
  (local WAL only).
- All committed on branch `dev` (see §Commit trail). Working tree clean except the
  in-progress item you're picking up.

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
| `src/controller.ts` | Auto-attach, global `onSessionEvent`, correlation, epoch re-arm, body fetch. |
| `src/redactor.ts` | Pure redaction: headers→sha256, body scrub (JWT/Bearer/cred fields/IBAN/**Luhn-gated card**), size cap, sha256. |
| `src/normalizer.ts` | Pure CDP→envelope builders. |
| `src/sink/local-sink.ts` | JSONL WAL: rotation, total-size cap (drop-oldest + counter), `segments()` drain API for Fase 3. |
| `src/*.test.ts` | 30 unit tests. |
| `scripts/inspect.ts` | **Dev tooling** — human-readable view of the WAL. |

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

# 1) Logic — 30 unit tests
bun test packages/fleet-telemetry

# 2) See what was captured (the WAL inspector)
bun packages/fleet-telemetry/scripts/inspect.ts            # summary + redaction stats
bun packages/fleet-telemetry/scripts/inspect.ts --samples 5
bun packages/fleet-telemetry/scripts/inspect.ts --bodies   # only events with a captured body
bun packages/fleet-telemetry/scripts/inspect.ts --grep amazon

# 3) Privacy spot-checks on the raw WAL
grep -o '"Cookie":"[^"]*"' ~/.browseros-dev/telemetry/events.jsonl | head   # must be sha256:
grep -c '\[redacted' ~/.browseros-dev/telemetry/events.jsonl
```

WAL lives at `~/.browseros-dev/telemetry/events.jsonl` (dev; `0700` dir / `0600` files).

## What's verified

- **M2** (network metadata) — live: byte-0 capture on agent-untouched/new tabs (192 events on a fresh cnn.com tab).
- **M3** (headers + bodies + Redactor) — live: 532 bodies on cnn.com, 0 fetch failures, redaction firing; Luhn fix verified.
- **M4** (WAL) — live: ~480 valid JSONL events on disk with real redacted bodies; survived an ungraceful kill (durability via periodic flush).
- All: package + server typecheck, biome, 30 unit tests green; pre-commit hooks green.

**Not yet live-verified (unit-tested instead):** CDP reconnect re-arm; graceful
`close()` stats (`dev:stop` hard-kills); header redaction live (sample had no
auth/cookie headers).

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
- Agent-action choke point (for M5): `apps/server/src/agent/tool-adapter.ts`.
- WAL dir resolution: `apps/server/src/lib/browseros-dir.ts` `getBrowserosDir()`.

## Commit trail (branch `dev`)

| Commit | What |
|---|---|
| `9de5a2c5` | Hard-disable vendor analytics egress |
| `f7782abd` | Capture layer Fase 2 M1 (skeleton) + M2 (network metadata) |
| `cf3cd320` | M3 — headers + bodies + Redactor (Luhn-gated cards) |
| `5e7c3e53` | M4 — on-disk WAL LocalSink |

## Next steps

1. **M5** — wire remaining taxonomy-v0 families on the same pipeline:
   `agent.action`/`agent.mcp_request` (hook `agent/tool-adapter.ts`; fold the existing
   `tool_executed`/`mcp.request` rollup), `navigation` + `page.lifecycle` (subscribe to
   `Page.*` CDP events), `app.event` passthrough for the ~90 agent-UI events.
2. **M6** — full `bun run check` green; close Fase 2.
3. **Fase 3** — ship from `LocalSink.segments()` to own infra + visualization/agent-query layer.
4. **Fase 5** — fleet identity: fill `device_id`/`company_id`/`user_id` (null placeholders today).

## Open decisions

- **Package brand/namespace** — provisional `@fleet/telemetry`; brand TBD.
- **Central infra location** (Fase 3) — cloud / on-prem / managed.
- **`device_id` source** (Fase 5) — hardware UUID vs generated-and-stored.
- **WebSocket frame capture depth** — metadata-only vs payloads.

## Artifacts

- Docs (in repo): `docs/fleet-telemetry/{adr-0001-network-capture,taxonomy-v0,fase-2-plan,HANDOVER}.md`
- Memory: `browseros-project`, `browseros-fork-strategy`, `browseros-dev-env-runbook`,
  `browseros-telemetry-build`, `browseros-remote-build-setup`.
