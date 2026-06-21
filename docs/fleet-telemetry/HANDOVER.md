# Handover — BrowserOS fork: pivot + fleet telemetry (Track B)

_Last updated: 2026-06-21_

## TL;DR — where we are

- The fork is consolidated on the **monorepo** and the dev loop runs.
- **Track B (fleet telemetry)** is the active workstream. Fase 0 + Fase 1 **done**.
  **Fase 2 M1 + M2 DONE** (code-complete, unit/typecheck/biome green) — capturing
  `network.request` metadata into a no-op sink. **Not yet live-smoked.**
- **Vendor-analytics kill-switch DONE + verified** — no telemetry can egress to
  BrowserOS infra (PostHog server + agent + Sentry hard-disabled). Our own
  `@fleet/telemetry` layer has zero network egress (local NoopSink only).
- **Working tree has uncommitted changes** from this session (additive pkg
  `packages/fleet-telemetry`, the main.ts seam, the kill-switch). Nothing committed
  yet — `git status` to review; commit when ready.

## North-star (sharpened 2026-06-21)

The central telemetry is for **agents to consume**: a first-party telemetry +
**visualization** system on **Juan's own servers** that future agents query to
understand how the client terminal is used → map/"paint" processes → spend their
time smarter in professional production. **HARD CONSTRAINT: telemetry goes ONLY to
his servers, never any third party, and must not stay merely local** (the Fase-2
local WAL is just a buffer; Fase 3 ships it onward). This reframes Fase 3 = own
central pipeline (OTel→Kafka→ClickHouse) + an agent-queryable visualization layer.

## Repo & machine

- Single source of truth: `/Users/juanlopez/agent/agentic-browser/BrowserOS/`
  (monorepo). Agent lives in `packages/browseros-agent`. The old standalone
  `BrowserOS-agent` is **archived on GitHub + deleted locally**.
- Branch `dev`, **0/0 vs `upstream/main`** (current with the community).
- Runs on the Mac Mini (hostname `Mac`). View the browser GUI via VNC/Screen Sharing.

## Dev loop (how to resume)

From `packages/browseros-agent`, always first:
`export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"`

- One-time/after dep or schema changes: `bun run dev:setup`
- Start everything (server + agent UI + browser): `bun run dev:watch`
- Stop: `bun run dev:stop`
- Health: `curl http://localhost:9100/health` → `{"status":"ok","cdpConnected":true}`
- Ports: 9000 CDP · 9100 HTTP/MCP · 9300 legacy. Toolchain: node 20, bun 1.3.14,
  **go 1.26.4** (required — dev orchestrator is a Go binary).
- Per-machine `.env` fixes (gitignored, redo on each machine): align
  `apps/agent/.env.development` ports to 9000/9100/9300; comment out empty
  `GRAPHQL_SCHEMA_PATH=`. (Details in the dev-env memory.)
- A `bun run dev:watch` may still be running in the background from the last session.

## What's done

- **Pivot:** monorepo = SoT; standalone archived/deleted; dev loop re-established
  with the new Go tooling + ports.
- **Fase 1 (decide capture mechanism + taxonomy):** see `adr-0001-network-capture.md`
  and `taxonomy-v0.md`. Network capture was unwired in the server; a throwaway spike
  proved CDP server-side capture is rich (metadata + cross-origin + XHR/beacons),
  found the on-demand-attach gap, and proved bodies need the **primary** session.
- **Fase 2 plan + de-risk:** see `fase-2-plan.md`. De-risk PASSED: bodies on our
  auto-attached primary session (31/31), no regression to MCP tools, byte-0 capture
  of untouched tabs. Mechanism = **root auto-attach with pause-on-start on the
  server's CDP connection**, subscribed globally via `CdpBackend.onSessionEvent`.

## Key code anchors (verified)

- Network capture seam: `apps/server/src/browser/core/pages.ts` `attach()` +
  `session.ts` `onSessionAttached`; observer template `observer/frames.ts`.
- **Global per-session event hook:** `CdpBackend.onSessionEvent(event, handler)` at
  `apps/server/src/browser/backends/cdp.ts:457`.
- CDP Network bindings: `packages/cdp-protocol/src/generated/{domains,domain-apis}/network.ts`.
- Agent-action choke point: `apps/server/src/agent/tool-adapter.ts`.
- **Fork kill-switch:** `packages/shared/src/constants/fork.ts` →
  `VENDOR_TELEMETRY_DISABLED=true`. Honored in `lib/metrics.ts` (PostHog client
  never built), `lib/sentry.ts` (`enabled:false`+dsn undefined), and
  `apps/agent/lib/analytics/posthog.ts` (inline const — agent has no shared dep).
  `REQUIRED_FOR_PRODUCTION` in `env.ts` no longer requires SENTRY_DSN/POSTHOG_API_KEY.
- **Still-live egress to `llm.browseros.com` (FUNCTIONAL, not telemetry — left intact):**
  `BROWSEROS_CONFIG_URL` (LLM provider config) + Klavis connector proxy. Only carry
  data if Juan uses the built-in BrowserOS LLM provider / connectors vs his own API
  keys. Revisit in Fase 4 when wiring his own LLM routing. Remote Hermes OFF (JWT gate).
- Vendor URLs: `packages/shared/src/constants/urls.ts`
  (KLAVIS_PROXY, POSTHOG_DEFAULT, AGENT_CONTROL_WORKER).
- DB: `lib/db/` (Drizzle); no events/audit table yet.

## Immediate next step

**Fase 2 — M1 DONE (2026-06-21).** Additive pkg `packages/fleet-telemetry`
(`@fleet/telemetry`; narrow exports `./create`/`./config`/`./types`; deps
`@browseros/shared`+`zod`) with structural contracts (`TelemetryCdp`,
`TelemetrySink`, `TelemetryController`), env-driven config (default OFF;
`BROWSEROS_TELEMETRY_ENABLED|_LEVEL|_BODY_MAX|_WAL_DIR`), a no-op logging sink,
and a skeleton `CaptureController`. Wired at ONE seam in `apps/server/src/main.ts`
(construct + `start()` after `cdp.connect()`, best-effort `stop()` on shutdown).
Green: server+pkg typecheck, 5 unit tests, biome. Not runtime-smoked (no dev loop
was up) — compile-level verified.

**Fase 2 — M2 DONE (2026-06-21), code-complete + unit/typecheck verified (not yet
live-smoked).** `CaptureController` does the real capture: root auto-attach
pause-on-start (`Target.setAutoAttach{waitForDebuggerOnStart:true,flatten:true}`),
per-attach `Network.enable` BEFORE `Runtime.runIfWaitingForDebugger` (byte-0),
global `onSessionEvent` for the four Network lifecycle events, correlation keyed
`${sessionId}:${requestId}` (redirect-aware; drop-oldest cap 8192), and epoch-poll
re-arm on reconnect. Emits taxonomy-v0 `network.request` **metadata only** to the
NoopSink. New pkg files: `normalizer.ts` (pure builders), `test-helpers.ts`
(`FakeCdp`/`CollectingSink`), `normalizer.test.ts`, `controller.test.ts`. `types.ts`
expanded (`TelemetryCdp` needs `session()`+`Target`; added `TelemetryContext`);
`@browseros/cdp-protocol` added as a pkg dep. main.ts shim now passes `context`
(install_id/versions/os/channel). 14 tests + both typechecks + biome green.

**Vendor-analytics kill-switch DONE (2026-06-21) — verified.** Audit found 3 upstream
analytics sinks to BrowserOS infra (server PostHog, agent-UI PostHog incl. session
replay, Sentry w/ `sendDefaultPii`), all gated by build-inlined keys (OFF in dev).
Killed via `VENDOR_TELEMETRY_DISABLED` (see anchors). Runtime-verified: with a fake
POSTHOG_API_KEY set, `metrics.isEnabled()===false`. server+agent+shared typecheck +
biome green.

**Next — pick one to resume:**
1. **Live smoke (M2 validation):** `BROWSEROS_TELEMETRY_ENABLED=true bun run
   dev:watch` on the Mini, browse a heavy site, confirm `Fleet telemetry capture
   started`, per-event debug logs, and reconnect re-arm.
2. **Continue Fase 2:** M3 bodies on the primary session
   (`getResponseBody`/`getRequestPostData`) + Redactor; M4 WAL; M5
   agent/navigation/page.lifecycle families; M6 tests (`bun run check`).
3. **Design Fase 3** now that the north-star is sharpened (own central pipeline +
   agent-queryable visualization). The LocalSink/WAL is the buffer Fase 3 ships from.

## Open decisions

- **Package namespace `<co>`** — provisional `fleet-telemetry`; brand TBD.
- **Capture bodies always vs selective** — chosen "everything incl. bodies"; revisit
  for volume/cost. Redaction is mandatory regardless.
- **WAL format** — JSONL (recommended) vs sqlite events table.
- **Central infra location** (Fase 3) — cloud / on-prem / managed.
- **`device_id` source** (Fase 5).

## Roadmap (remaining)

Fase 2 capture layer → Fase 3 own central infra (OTel→Kafka→ClickHouse) → Fase 4 cut
vendor cord → Fase 5 fleet identity/enrollment → Fase 6 distribution + auto-update
(Apple Developer ID + Omaha — start the Apple Developer ID procurement early) →
Fase 7 scale & harden.

## Artifacts

- Docs (in repo): `docs/fleet-telemetry/{adr-0001-network-capture,taxonomy-v0,fase-2-plan,HANDOVER}.md`
- Memory: `browseros-project`, `browseros-fork-strategy`, `browseros-dev-env-runbook`,
  `browseros-remote-build-setup`, `browseros-telemetry-build`.
