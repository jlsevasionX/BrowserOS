# Fase 2 — Implementation plan: on-device capture layer

**Status:** Plan (2026-06-21). Builds on ADR-0001 (mechanism) + taxonomy-v0.
**Goal:** turn the throwaway spike into the permanent, additive capture layer that
reliably captures every network connection (+ bodies) and agent action on-device,
normalizes to the taxonomy v0 envelope, redacts, and persists to a local
write-ahead log (WAL). **Out of scope (Fase 3):** shipping to a central server.

## Architecture

```
                 apps/server (existing)
   ┌───────────────────────────────────────────────┐
   │ CdpBackend ──onSessionEvent('Network.*')──┐    │
   │   (single ws, all sessions)               │    │
   │ PageManager (on-demand attach, unchanged) │    │
   └───────────────────────────────────────────┼────┘
                                                │  (new, additive)
                 packages/fleet-telemetry       ▼
   ┌───────────────────────────────────────────────────────────┐
   │ CaptureController                                           │
   │   • owns root auto-attach (waitForDebuggerOnStart) +        │
   │     Network.enable per session  → primary session, byte-0   │
   │   • subscribes via CdpBackend.onSessionEvent (global)       │
   │   • re-arms on CDP reconnect (epoch)                        │
   │        │                                                    │
   │        ▼                                                    │
   │   Normalizer  → builds taxonomy-v0 envelope                 │
   │        │       (network.request, agent.action, …)           │
   │        ▼                                                    │
   │   Redactor    → strips secrets/headers/bodies on-device     │
   │        │                                                    │
   │        ▼                                                    │
   │   LocalSink (WAL on disk)  ← Fase 2 STOPS HERE              │
   │        ⋯ (Fase 3: → OTel Collector → Kafka → ClickHouse)    │
   └───────────────────────────────────────────────────────────┘
```

## Package (additive — own namespace, merge-isolated)

- `packages/fleet-telemetry/` (working name; `<co>` brand TBD). Bun workspace pkg,
  package name e.g. `@fleet/telemetry`. NOT under `@browseros/*` (that's upstream's).
- Narrow file entries (no barrel), per monorepo CLAUDE rules. Shared constants
  reused from `@browseros/shared`.
- Touches upstream files at exactly ONE seam: a few lines in `apps/server/src/main.ts`
  lifecycle to construct + start the controller (thin shim). Everything else lives
  in the package.

## Components

### 1. CaptureController (the hard part)
- **Owns root auto-attach with pause-on-start:**
  `cdp.Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true, flatten:true})`,
  and on each `attachedToTarget`: `session.Network.enable()` then
  `session.Runtime.runIfWaitingForDebugger()` (capture from byte 0).
- **Global subscription** via `CdpBackend.onSessionEvent('Network.requestWillBeSent'|…, (params, sessionId)=>…)`
  — one listener per event type for ALL sessions (cleaner than per-session `.on`).
- **Bodies on the primary session:** the auto-attached session is the owner, so
  `getResponseBody`/`getRequestPostData` work (ADR-0001 finding 3 — VERIFY early, see de-risk).
- **Reconnect-safe:** watch `cdp.connectionEpoch()`; on reconnect, re-arm auto-attach
  + re-enable Network (sessions are gone after a reconnect).
- **Correlation state:** map `requestId → inflight` keyed per `(sessionId, requestId)`;
  resolve `tab_id`/`frame_id`/`target_type` from `targetInfo`.

### 2. Normalizer
- Pure functions: CDP event(s) → taxonomy-v0 envelope. One builder per family.
- Fase 2 families to wire: `network.request`, `network.websocket`, `navigation`,
  `page.lifecycle`, `agent.action`. (`app.event`/`agent.chat`/`error` = later.)
- `agent.action`: hook `agent/tool-adapter.ts` (already imports `metrics`/`logger`) —
  emit on each tool execute; reuse the seam where `metrics` already counts tools.

### 3. Redactor (mandatory — bodies are on)
- Pure, config-driven (per taxonomy §3): header allow/deny → presence+hash;
  body secret-scrub (bearer/JWT/api-key/card/IBAN/password fields); size cap
  (~64 KB) + always store `sha256`; sample high-volume types to metadata-only.
- Runs BEFORE the sink. Capture-level (`metadata|+headers|+bodies`) read from config.

### 4. LocalSink (WAL)
- Append-only on-disk log under `~/.browseros-dev` / prod data dir, so events
  survive offline + restart. Options: (a) JSONL file + rotation; (b) sqlite via the
  existing Drizzle setup (`lib/db/`) with a new `events` table. **Recommend (a)** for
  Fase 2 (simplest, append-optimized; WAL ≠ relational queries). Expose a read/drain
  API for Fase 3 to ship from.
- Backpressure: bounded size + drop-oldest with a counter event (no silent loss).

## Integration & lifecycle
- Construct in `main.ts` after `cdp.connect()`, before/after `new Browser(cdp)`:
  `const telemetry = createTelemetry(cdp, config); await telemetry.start()`.
- Config from env/managed-policy: capture levels, body cap, sampling, WAL path,
  on/off. Default OFF in dev unless explicitly enabled (mirror current telemetry).
- Coordinate with PageManager: telemetry's auto-attached session is primary;
  PageManager keeps its on-demand attach (its session becomes secondary — fine, it
  uses DOM/AX, not network bodies). VERIFY no regression (de-risk #2).

## De-risking — DONE (2026-06-21, throwaway `capture-derisk.ts`, reverted)
1. **Bodies on auto-attached primary session — PASS.** With root auto-attach owned by
   us (`setAutoAttach waitForDebuggerOnStart:true` + `runIfWaitingForDebugger`) +
   global `cdp.onSessionEvent`, `getResponseBody` worked **31/31 (bodyFail=0)** and
   returned real JSON. (Spike v2's secondary session was 0/all-fail — confirms the
   primary-session requirement and the fix.)
2. **No regression to PageManager/tools — PASS.** With root auto-attach ON, all MCP
   tools worked normally: list_pages, navigate_page, take_snapshot, get_page_content,
   new_page. The two attach models coexist on one connection.
3. **Byte-0 / untouched tabs — validated.** A side-channel `Target.createTarget`
   (bypassing the agent) was auto-attached and captured (sessions 42→77); pause-on-start
   active. Hard-confirm the initial-document capture during M2.
4. **Reconnect** (epoch re-arm): logic written + defensive; confirm during M2 (no
   disruptive browser restart forced now).
5. **Volume/perf**: still TODO during M2 (heavy site → event rate + WAL growth → tune sampling).

## Milestones within Fase 2
- M1: package skeleton + main.ts shim + config + no-op sink (events logged).
- M2: CaptureController (auto-attach + global subscription + reconnect) → `network.request` metadata.
- M3: bodies + Redactor.
- M4: LocalSink WAL + drain API + backpressure.
- M5: `agent.action` + `navigation` + `page.lifecycle` families.
- M6: tests (normalizer/redactor unit; capture integration against live CDP) + `bun run check` green.

## Open decisions (carried from taxonomy §5)
- Package namespace/brand `<co>`.
- Capture bodies always vs selective (volume/cost vs forensic value).
- WAL format: JSONL (recommended) vs sqlite events table.
