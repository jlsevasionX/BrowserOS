# Fase 3 MVP — Central Pipeline (design spec)

**Date:** 2026-06-22
**Status:** Approved design, pre-implementation
**Scope:** Subsystem #1 of Fase 3 — get a captured event off the device and into a
queryable central store that Juan owns. The visualization / agent-query layer
(north-star, subsystem #2) is a **separate** spec → plan cycle after this MVP.

Prior context: `adr-0001-network-capture.md`, `taxonomy-v0.md`, `fase-2-plan.md`,
`HANDOVER.md`. Fase 2 is closed: capture → normalize → redact → on-disk WAL all
ship on the device; 6 taxonomy-v0 families are wired. Today the data dies in the
device's WAL. This spec adds the central half.

## 1. Goal & success criterion

**MVP success:** an event captured on a device appears as a queryable row in a
central ClickHouse that runs in Docker — locally today, on Juan's AWS tomorrow by
swapping only the `.env`.

**Hard constraints (from project memory):**
- Telemetry goes ONLY to Juan's servers, never a third party.
- Telemetry must NOT stay merely local — the WAL is just the device-side buffer;
  this phase ships it onward.
- Additive only: no upstream BrowserOS edits beyond the existing seam; with no
  ingest URL configured the system behaves exactly as today (WAL-only).

## 2. Guiding principle — freeze the expensive, keep the cheap replaceable

- **The device is expensive to change** — it is installed on every terminal across
  Juan's companies; redeploying the fleet is painful.
- **The center is cheap to change** — it is Juan's own infra, a `docker compose`
  cycle.

Therefore: **the device knows only "one URL + one token" and ships our native
taxonomy-v0 JSON. Everything else (store engine, OTel, Redpanda, managed hosting)
lives centrally and is replaced without touching a single browser.**

This is what makes "move fast now, adapt later and done" true:
- *Fast now:* the device ships the envelope we already have — zero mapping, zero
  OTel, zero Kafka. The center is as thin as possible.
- *Adapt later:* the device contract is frozen, so inserting OTel + Redpanda is a
  **central-side** change placed *in front of* the ingest. The canonical future
  stack `OTel → Redpanda → ClickHouse` keeps ClickHouse as the destination — so
  today's ClickHouse is not throwaway; Redpanda is transport, ClickHouse is sink.

## 3. Non-goals (YAGNI for this MVP)

- No Kafka / Redpanda, no OTel Collector. They slot in front of the ingest later,
  central-side, with no device change.
- No managed hosting yet (ClickHouse Cloud, etc.) — that is a later `StoreWriter`
  swap, central-side.
- No visualization / dashboard / agent-query layer — separate spec (subsystem #2).
- No fleet identity (`device_id`/`company_id`/`user_id` stay null — Fase 5).
- No new event families (`network.websocket`, `agent.chat`, `error` remain
  optional/unwired).

## 4. Architecture

```
┌─ DEVICE (each terminal) ───────────────┐      ┌─ CENTRAL (Docker: local today → AWS) ─┐
│  CaptureController ─► LocalSink (WAL)   │      │  fleet-ingest (Bun)                   │
│     (capture, Fase 2)    │ JSONL,       │      │    POST /v1/events  (bearer token)    │
│                          │ rotate by    │      │    GET  /health                       │
│                          │ size + AGE   │      │    validate envelope (zod) ──┐        │
│                          ▼              │      │                              ▼        │
│                     Shipper (NEW) ──HTTPS──────►  StoreWriter (interface)              │
│                      segments() oldest  │      │      └─ ClickHouseStore impl           │
│                      POST batched JSONL  │      │             │                         │
│                      2xx ⇒ unlink        │      │             ▼                         │
│                      backoff + retry     │      │        ClickHouse (events table,      │
│                                          │      │        ReplacingMergeTree, volume)    │
└──────────────────────────────────────────┘      └────────────────────────────────────┘
```

The **WAL is the crash-safe boundary** between capture and ship. Capture is
unchanged from Fase 2.

## 5. The durable contract (the part that must not change)

This is the frozen interface between device and center.

### 5.1 Wire format
- Transport: HTTPS `POST {INGEST_URL}/v1/events`.
- Auth: `Authorization: Bearer {INGEST_TOKEN}`.
- Body: the rotated WAL segment verbatim — **JSONL** (one taxonomy-v0
  `TelemetryEvent` envelope per line). Content-Type `application/x-ndjson`.
  Optional `Content-Encoding: gzip` (device may gzip; ingest must accept both).
- The envelope is the existing `TelemetryEvent` (types.ts) — `event_id`, `ts`,
  `install_id`, `session_id`, `type`, `payload`, etc. `event_id` is the dedup key.

### 5.2 Responses
- `204 No Content` — accepted (all lines durably written). Device deletes segment.
- `400` — malformed/invalid lines. Ingest still accepts the valid lines (partial
  success is logged); returns 400 only when the whole batch is unparseable.
  Device treats 400 as "do not retry this segment forever" → see §8.
- `401` — bad/missing token. Device keeps segment, backs off, warns.
- `5xx` / network error — Device keeps segment, backs off, retries.

### 5.3 Idempotency
At-least-once delivery. The ingest never needs to dedup in-process; ClickHouse's
`ReplacingMergeTree` collapses duplicate `event_id`s at merge time. A resent
segment is therefore safe.

## 6. Components

### A. Shipper (device) — `packages/fleet-telemetry/src/ship/shipper.ts` (NEW)
- Owned by `CaptureController` (start/stop alongside the sink).
- Loop on `SHIP_INTERVAL_MS` (default 15s):
  1. `await sink.flush()` then force-rotate the active segment (see §C ajuste) so
     a sealed segment exists.
  2. `const segs = await sink.segments()` (oldest-first; already excludes active).
  3. For each segment in order: read bytes → POST → on `204` `unlink` the file;
     on `400` (whole batch unparseable) increment that segment's poison counter
     and `unlink` only after N attempts (§8); on `401`/`5xx`/network error stop
     the batch, increment failure counter, apply backoff, leave remaining
     segments for next tick.
- Backoff: exponential with cap (e.g. 15s → 30s → … → 5min), reset on success.
- Bounded by the WAL's existing total-size cap (oldest rotated segment dropped if
  the device is offline long enough — already implemented, counter exists).
- Inert when `INGEST_URL` is empty → system stays WAL-only (today's behavior).

### Ajuste. `LocalSink` time-based rotation — `packages/fleet-telemetry/src/sink/local-sink.ts`
- Add `maxFileAgeMs` option (default ~30s). The active segment rotates when it
  exceeds `maxFileBytes` **OR** its age exceeds `maxFileAgeMs`.
- Add a public `forceRotate()` (no-op when active is empty) the Shipper can call
  before draining, so low-volume devices don't strand events in the active file.
- Track active-segment open time to drive age-based rotation.
- Purely additive; existing size-based behavior and tests unchanged.

### Config — `packages/fleet-telemetry/src/config.ts`
New env vars (all optional; absence ⇒ Shipper inert):
- `BROWSEROS_TELEMETRY_INGEST_URL` — base URL of the central ingest.
- `BROWSEROS_TELEMETRY_INGEST_TOKEN` — bearer token.
- `BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS` — ship loop cadence (default 15000).
- `BROWSEROS_TELEMETRY_MAX_FILE_AGE_MS` — WAL age rotation (default 30000).
Extend the zod schema + `resolveTelemetryConfig`. Wiring stays in `create.ts`
(construct the Shipper when URL present, pass it to the controller).

### B. Ingest service — `fleet-central/ingest/` (NEW top-level dir)
- Bun HTTP service. Routes:
  - `POST /v1/events` — check bearer token; read body (gunzip if needed); split
    JSONL; validate each line against the taxonomy-v0 envelope schema (zod,
    shared with the device — see §7); pass valid events to `StoreWriter.write`;
    respond per §5.2.
  - `GET /health` — `{status:"ok", store:"connected"}` (pings ClickHouse).
- Config via env: `INGEST_PORT`, `INGEST_TOKEN`, `CLICKHOUSE_URL`,
  `CLICKHOUSE_DB`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`.
- Batches inserts (one INSERT per received segment).

### C. Store — `fleet-central/ingest/src/store/` (NEW)
- `StoreWriter` interface: `write(events: TelemetryEvent[]): Promise<void>`,
  `health(): Promise<boolean>`, `close(): Promise<void>`. **This is the seam that
  makes the store replaceable** (managed ClickHouse / Redpanda producer / etc.
  later — a one-file change, device untouched).
- `ClickHouseStore` impl: batch INSERT into the `events` table over ClickHouse
  HTTP. Uses the official `@clickhouse/client` (Bun-compatible) or raw HTTP.

#### ClickHouse schema (`fleet-central/clickhouse/init/01-schema.sql`)
```sql
CREATE TABLE IF NOT EXISTS events (
  event_id        String,
  ts              DateTime64(3),           -- from envelope ts (epoch millis)
  ingested_at     DateTime64(3) DEFAULT now64(3),
  schema_version  UInt8,
  install_id      String,
  device_id       Nullable(String),
  company_id      Nullable(String),
  user_id         Nullable(String),
  session_id      String,
  browseros_version String,
  chromium_version  String,
  os              LowCardinality(String),
  channel         LowCardinality(String),
  tab_id          Nullable(Int64),
  frame_id        Nullable(String),
  target_type     Nullable(String),
  type            LowCardinality(String),  -- event family
  payload         String                    -- raw JSON of payload; query via JSONExtract
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (type, ts, event_id);             -- ORDER BY includes event_id ⇒ dedup key
```
Notes:
- `ReplacingMergeTree` + `event_id` in the sort key ⇒ at-least-once duplicates
  collapse at merge. Queries that must not see duplicates use `FINAL` or
  dedup-aware aggregation (documented for subsystem #2).
- `payload` stored as a JSON string for MVP simplicity; per-family materialized
  columns/views are a subsystem-#2 concern (do NOT build now).

### D. Docker — `fleet-central/docker-compose.yml` + `.env.example` (NEW)
- Services: `clickhouse` (official image, persistent named volume, init SQL
  mounted) and `ingest` (built from `fleet-central/ingest/Dockerfile`).
- `ingest` depends_on `clickhouse` healthy.
- `.env.example` documents every var; real `.env` is gitignored.
- Runs on the Mac Mini today (`docker compose up`); identical compose deploys to
  AWS tomorrow with a different `.env`.

## 7. Sharing the envelope schema device↔ingest

The ingest must validate the exact taxonomy-v0 envelope. Options, decision below:
- The `TelemetryEvent` type lives in `@fleet/telemetry/types`. For the MVP the
  ingest will define a **standalone zod schema** mirroring `TelemetryEvent`
  (the envelope is small and stable), to avoid coupling the central service to
  the device package's build. A unit test asserts the two stay structurally
  compatible (a representative event from the device round-trips through the
  ingest schema). Revisit extracting a shared schema package if drift appears.

## 8. Error handling & delivery guarantees

- **Telemetry never crashes the host.** All Shipper errors are caught and logged
  (mirrors the WAL's "never throw out of a drain" rule).
- **At-least-once, never silent loss:** segments persist until a `204`. Offline
  devices accumulate until the WAL total-size cap drops the *oldest* rotated
  segment (existing behavior, counted + logged).
- **Poison segment (`400`):** a segment the ingest rejects as wholly unparseable
  is deleted after N (e.g. 3) attempts and logged with a counter, so one corrupt
  file cannot wedge the queue forever. (Valid-line partial success means this is
  rare.)
- **Backpressure:** Shipper sends at most one segment's worth per POST and walks
  segments oldest-first; it never loads the whole WAL into memory.
- **Auth/availability (`401`/`5xx`):** keep segment, exponential backoff, warn.

## 9. Testing

- **Device unit:** Shipper sends → `204` → unlinks; `5xx` → keeps + backs off;
  `400` poison → drops after N; uses a fake HTTP transport. Time-based rotation +
  `forceRotate()` unit tests on `LocalSink`.
- **Central unit:** ingest auth (`401`), validation (`400` on garbage, `204` on
  valid, partial-success path), `/health`; against a fake `StoreWriter`.
- **Central integration:** `ClickHouseStore` against a ClickHouse container —
  insert + read back, and dedup (insert same `event_id` twice → one row with
  `FINAL`).
- **Envelope compatibility:** a representative device event validates against the
  ingest schema (§7).
- **E2E smoke (manual, like Fase 2):** real device with
  `BROWSEROS_TELEMETRY_INGEST_URL` set → `docker compose up` locally → query the
  row in ClickHouse. Verify dedup by killing the device mid-ship and restarting.

## 10. Milestones

- **M1 — WAL time-rotation + Shipper (device), inert without URL.** `forceRotate()`
  + `maxFileAgeMs`; Shipper + config; unit tests; `bun run check` green. No central
  side yet → still WAL-only at runtime.
- **M2 — Central skeleton.** `fleet-central/` with ingest (`/health`, `/v1/events`
  with auth + validation), `StoreWriter` interface + a fake/in-memory impl, unit
  tests, `docker-compose` with the ingest only (no CH yet) bootable.
- **M3 — ClickHouse store.** `ClickHouseStore` + schema + compose CH service +
  integration test (insert/read/dedup).
- **M4 — Wire + E2E.** Point a real device at the local compose; live smoke; verify
  row + dedup. Update `HANDOVER.md`. Decide gzip on/off based on observed sizes.

## 11. Open decisions (non-blocking; default chosen, revisit if needed)

- **gzip on the wire** — default off for MVP simplicity; turn on in M4 if segment
  sizes warrant.
- **Shared envelope schema package** — default standalone-mirror-with-compat-test
  (§7); extract a package only if drift appears.
- **Token management** — single static bearer token for MVP; per-device tokens /
  rotation is a Fase 5 (fleet identity) concern.
- **`fleet-central/ingest` in the Bun workspace vs standalone** — default
  standalone (own `package.json`, not a monorepo workspace member) so central infra
  is decoupled from the device build; reuses Bun + zod but not workspace wiring.

## 12. Forward path (explicitly out of this spec, recorded so we don't design it away)

- Insert **OTel Collector + Redpanda** in front of the ingest (or have the ingest
  produce to Redpanda via a new `StoreWriter`) — central-side, device frozen.
- Swap ClickHouse to **managed** — central-side `StoreWriter`/config change.
- Build **subsystem #2** (visualization + agent-query layer) on top of ClickHouse.
