# Fase 3 MVP — Central Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship captured telemetry events off each device to a central, queryable ClickHouse that Juan owns — running in Docker locally today, on AWS tomorrow by swapping only `.env`.

**Architecture:** The device's existing on-disk WAL (`LocalSink`) is the crash-safe boundary. A new **Shipper** (inside `@fleet/telemetry`) drains rotated WAL segments oldest-first, POSTs the raw JSONL to a configurable ingest URL with a bearer token, and deletes each segment only on success. The center is a standalone Bun **ingest** service (Hono) that validates the taxonomy-v0 envelope and writes through a `StoreWriter` seam into **ClickHouse** (`ReplacingMergeTree`, dedup by `event_id`). The device knows only "URL + token" — every future change (OTel, Redpanda, managed hosting) is central-side, device frozen.

**Tech Stack:** TypeScript + Bun, Zod, Hono (ingest), `@clickhouse/client`, Docker / docker-compose. `bun:test` for tests.

## Global Constraints

- Additive only — NO upstream BrowserOS edits beyond the existing `@fleet/telemetry` seam. With no ingest URL configured, behavior is exactly as today (WAL-only).
- Telemetry goes ONLY to Juan's servers, never a third party.
- Extensionless TS imports (`./shipper`, not `./shipper.js`).
- kebab-case filenames; new files carry the existing license header block (see any current file in `packages/fleet-telemetry/src`).
- No package-wide barrel; narrow `exports` only.
- Keep comments minimal (constraints/invariants only).
- All commits use Conventional Commits (repo enforces via lefthook `commit-msg`) and end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Device work runs from `packages/browseros-agent`; first `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"`. Central work runs from `fleet-central/` (its own `bun install`).
- Spec deviation (deliberate, YAGNI): the spec's `maxFileAgeMs` WAL auto-rotation is dropped — the Shipper calls `forceRotate()` every tick, so the ship interval already bounds latency. Only `forceRotate()` is added to the WAL. The `BROWSEROS_TELEMETRY_MAX_FILE_AGE_MS` env is therefore not implemented.

---

## File Structure

**Device (`packages/browseros-agent/packages/fleet-telemetry/`):**
- Modify `src/sink/local-sink.ts` — add public `forceRotate()`.
- Modify `src/config.ts` — add `ingestUrl`, `ingestToken`, `shipIntervalMs`.
- Create `src/ship/shipper.ts` — Shipper + `ShippableWal`/`ShipTransport` interfaces + `FetchTransport`.
- Create `src/ship/shipper.test.ts`.
- Modify `src/controller.ts` — accept + start/stop an optional shipper.
- Modify `src/create.ts` — construct the shipper when an ingest URL is set.

**Central (`BrowserOS/fleet-central/`, standalone, NOT a Bun workspace member):**
- Create `ingest/package.json`, `ingest/tsconfig.json`.
- Create `ingest/src/envelope.ts` — standalone zod schema mirroring `TelemetryEvent`.
- Create `ingest/src/envelope.test.ts`.
- Create `ingest/src/store/store-writer.ts` — `StoreWriter` interface + `MemoryStore` fake.
- Create `ingest/src/store/clickhouse-store.ts` — `ClickHouseStore`.
- Create `ingest/src/store/clickhouse-store.test.ts` — integration (skipped without `CLICKHOUSE_URL`).
- Create `ingest/src/app.ts` — Hono app factory (`/health`, `POST /v1/events`).
- Create `ingest/src/app.test.ts`.
- Create `ingest/src/index.ts` — entrypoint (reads env, wires ClickHouseStore, serves).
- Create `ingest/Dockerfile`.
- Create `clickhouse/init/01-schema.sql`.
- Create `docker-compose.yml`, `.env.example`, `.gitignore`, `README.md`.

---

## Task 1: WAL `forceRotate()`

Adds a public method the Shipper calls each tick so low-volume events don't sit in the un-shippable active segment.

**Files:**
- Modify: `packages/fleet-telemetry/src/sink/local-sink.ts`
- Test: `packages/fleet-telemetry/src/sink/local-sink.test.ts`

**Interfaces:**
- Produces: `LocalSink.forceRotate(): Promise<void>` — flushes buffered lines, then renames the active segment to a rotated one if it is non-empty; no-op if nothing has been written. After it resolves, `segments()` includes the just-sealed file and the active segment is empty.

- [ ] **Step 1: Write the failing test** — append to the `describe('LocalSink', ...)` block in `local-sink.test.ts`:

```ts
  test('forceRotate seals the active segment so it appears in segments()', async () => {
    const sink = new LocalSink({ dir, logger: silentLogger, flushIntervalMs: 0 })
    sink.write(evt(1))
    sink.write(evt(2))
    await sink.forceRotate()

    const segs = await sink.segments()
    expect(segs).toHaveLength(1)
    const lines = (await readFile(segs[0], 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    await sink.close()
  })

  test('forceRotate is a no-op when nothing was written', async () => {
    const sink = new LocalSink({ dir, logger: silentLogger, flushIntervalMs: 0 })
    await sink.forceRotate()
    expect(await sink.segments()).toHaveLength(0)
    await sink.close()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/sink/local-sink.test.ts`
Expected: FAIL — `sink.forceRotate is not a function`.

- [ ] **Step 3: Implement `forceRotate`** — in `local-sink.ts`, add this method right after `close()` (it reuses the private `chain`/`rotate`/`ensureInit` machinery so it never races the timer):

```ts
  /** Flush buffered lines, then seal the active segment if it has any bytes. */
  async forceRotate(): Promise<void> {
    await this.enqueueDrain()
    this.chain = this.chain.then(async () => {
      if (this.activeBytes > 0) await this.rotate()
    })
    await this.chain
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/sink/local-sink.test.ts`
Expected: PASS (all LocalSink tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/fleet-telemetry/src/sink/local-sink.ts packages/fleet-telemetry/src/sink/local-sink.test.ts
git commit -m "feat(fleet-telemetry): add LocalSink.forceRotate for prompt shipping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Shipper config

Adds the device-side ingest config. Absence of a URL keeps the Shipper inert.

**Files:**
- Modify: `packages/fleet-telemetry/src/config.ts`
- Test: `packages/fleet-telemetry/src/config.test.ts`

**Interfaces:**
- Produces: `TelemetryConfig` gains `ingestUrl: string` (default `''`), `ingestToken: string` (default `''`), `shipIntervalMs: number` (default `15000`). Envs: `BROWSEROS_TELEMETRY_INGEST_URL`, `BROWSEROS_TELEMETRY_INGEST_TOKEN`, `BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS`.

- [ ] **Step 1: Write the failing test** — add to `config.test.ts`:

```ts
test('resolves shipper config from env', () => {
  const c = resolveTelemetryConfig({
    BROWSEROS_TELEMETRY_ENABLED: 'true',
    BROWSEROS_TELEMETRY_INGEST_URL: 'https://t.example/',
    BROWSEROS_TELEMETRY_INGEST_TOKEN: 'secret',
    BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS: '5000',
  } as NodeJS.ProcessEnv)
  expect(c.ingestUrl).toBe('https://t.example/')
  expect(c.ingestToken).toBe('secret')
  expect(c.shipIntervalMs).toBe(5000)
})

test('shipper config defaults to inert (empty url, 15s interval)', () => {
  const c = resolveTelemetryConfig({} as NodeJS.ProcessEnv)
  expect(c.ingestUrl).toBe('')
  expect(c.shipIntervalMs).toBe(15000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/config.test.ts`
Expected: FAIL — `ingestUrl` undefined / property missing.

- [ ] **Step 3: Implement** — edit `config.ts`:

In `TelemetryConfigSchema` add three fields:
```ts
  /** Central ingest base URL. Empty ⇒ Shipper inert (WAL-only). */
  ingestUrl: z.string(),
  ingestToken: z.string(),
  /** Ship-loop cadence in ms. */
  shipIntervalMs: z.number().int().positive(),
```
In `DEFAULT_TELEMETRY_CONFIG` add:
```ts
  ingestUrl: '',
  ingestToken: '',
  shipIntervalMs: 15_000,
```
In `resolveTelemetryConfig`'s parsed object add:
```ts
    ingestUrl: env.BROWSEROS_TELEMETRY_INGEST_URL ?? DEFAULT_TELEMETRY_CONFIG.ingestUrl,
    ingestToken:
      env.BROWSEROS_TELEMETRY_INGEST_TOKEN ?? DEFAULT_TELEMETRY_CONFIG.ingestToken,
    shipIntervalMs: parseInt10(
      env.BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS,
      DEFAULT_TELEMETRY_CONFIG.shipIntervalMs,
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet-telemetry/src/config.ts packages/fleet-telemetry/src/config.test.ts
git commit -m "feat(fleet-telemetry): add ingest URL/token/interval config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Shipper

The core device-side component: drain segments, POST, delete on success, back off on failure, drop poison segments after N tries.

**Files:**
- Create: `packages/fleet-telemetry/src/ship/shipper.ts`
- Test: `packages/fleet-telemetry/src/ship/shipper.test.ts`

**Interfaces:**
- Consumes: `LoggerInterface` from `@browseros/shared/types/logger`; `LocalSink.forceRotate`/`flush`/`segments` (Task 1).
- Produces:
  - `interface ShippableWal { flush(): Promise<void>; forceRotate(): Promise<void>; segments(): Promise<string[]> }`
  - `interface ShipTransport { send(body: Buffer): Promise<number> }` — returns an HTTP status; throws on network error.
  - `class FetchTransport implements ShipTransport` — `constructor(url: string, token: string, logger: LoggerInterface)`; POSTs to `${url}/v1/events` (trailing slash tolerated) with `Authorization: Bearer ${token}` and `Content-Type: application/x-ndjson`.
  - `interface ShipperOptions { wal: ShippableWal; transport: ShipTransport; logger: LoggerInterface; intervalMs?: number; maxPoisonAttempts?: number; backoffMaxMs?: number }`
  - `class Shipper { constructor(opts: ShipperOptions); start(): void; stop(): Promise<void>; runOnce(): Promise<void> }` — `runOnce` is the single drain pass (exposed for tests); `start` self-schedules it on a timer with backoff.

- [ ] **Step 1: Write the failing test** — create `shipper.test.ts`:

```ts
/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { silentLogger } from '../test-helpers'
import { Shipper, type ShipTransport, type ShippableWal } from './shipper'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-ship-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A WAL stub that exposes pre-written segment files in `dir`, oldest-first. */
function walOver(dir: string): ShippableWal {
  return {
    flush: async () => {},
    forceRotate: async () => {},
    segments: async () => {
      const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort()
      return names.map((n) => join(dir, n))
    },
  }
}

class FakeTransport implements ShipTransport {
  bodies: Buffer[] = []
  constructor(private readonly statuses: number[]) {}
  async send(body: Buffer): Promise<number> {
    this.bodies.push(body)
    const s = this.statuses.shift()
    if (s === undefined) return 204
    if (s === 0) throw new Error('network down')
    return s
  }
}

async function seg(dir: string, name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content)
}

describe('Shipper.runOnce', () => {
  test('ships each segment and deletes it on 204', async () => {
    await seg(dir, 'events-000000.jsonl', '{"event_id":"a"}\n')
    await seg(dir, 'events-000001.jsonl', '{"event_id":"b"}\n')
    const transport = new FakeTransport([204, 204])
    const shipper = new Shipper({ wal: walOver(dir), transport, logger: silentLogger })

    await shipper.runOnce()

    expect(transport.bodies).toHaveLength(2)
    expect((await readdir(dir)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0)
  })

  test('keeps the segment and stops the batch on a 5xx', async () => {
    await seg(dir, 'events-000000.jsonl', '{"event_id":"a"}\n')
    await seg(dir, 'events-000001.jsonl', '{"event_id":"b"}\n')
    const transport = new FakeTransport([503])
    const shipper = new Shipper({ wal: walOver(dir), transport, logger: silentLogger })

    await shipper.runOnce()

    // First segment failed → batch stops, both files remain.
    expect((await readdir(dir)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(2)
  })

  test('keeps the segment on a network error (transport throws)', async () => {
    await seg(dir, 'events-000000.jsonl', '{"event_id":"a"}\n')
    const transport = new FakeTransport([0])
    const shipper = new Shipper({ wal: walOver(dir), transport, logger: silentLogger })

    await shipper.runOnce()

    expect((await readdir(dir)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
  })

  test('drops a poison (400) segment only after maxPoisonAttempts', async () => {
    await seg(dir, 'events-000000.jsonl', 'not json\n')
    const transport = new FakeTransport([400, 400, 400])
    const shipper = new Shipper({
      wal: walOver(dir),
      transport,
      logger: silentLogger,
      maxPoisonAttempts: 3,
    })

    await shipper.runOnce() // attempt 1 — kept
    expect((await readdir(dir)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    await shipper.runOnce() // attempt 2 — kept
    expect((await readdir(dir)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    await shipper.runOnce() // attempt 3 — dropped
    expect((await readdir(dir)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/ship/shipper.test.ts`
Expected: FAIL — cannot resolve `./shipper`.

- [ ] **Step 3: Implement** — create `shipper.ts`:

```ts
/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Shipper — drains rotated WAL segments to the central ingest. The WAL is the
 * crash-safe boundary: a segment is deleted only after the ingest acknowledges
 * it (204). Delivery is at-least-once; the ingest/store dedups by event_id. The
 * device knows only a URL + token, so swapping what sits behind the endpoint
 * (ingest, OTel, Redpanda, managed) never touches the device.
 */

import { readFile, unlink } from 'node:fs/promises'
import type { LoggerInterface } from '@browseros/shared/types/logger'

export interface ShippableWal {
  flush(): Promise<void>
  forceRotate(): Promise<void>
  segments(): Promise<string[]>
}

export interface ShipTransport {
  /** POST the segment bytes. Returns an HTTP status; throws on network error. */
  send(body: Buffer): Promise<number>
}

export interface ShipperOptions {
  wal: ShippableWal
  transport: ShipTransport
  logger: LoggerInterface
  intervalMs?: number
  /** Drop a segment the ingest rejects (400) after this many attempts. */
  maxPoisonAttempts?: number
  backoffMaxMs?: number
}

const DEFAULT_INTERVAL_MS = 15_000
const DEFAULT_MAX_POISON = 3
const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1000

export class Shipper {
  private readonly wal: ShippableWal
  private readonly transport: ShipTransport
  private readonly logger: LoggerInterface
  private readonly intervalMs: number
  private readonly maxPoisonAttempts: number
  private readonly backoffMaxMs: number
  private readonly poison = new Map<string, number>()

  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private failures = 0

  constructor(opts: ShipperOptions) {
    this.wal = opts.wal
    this.transport = opts.transport
    this.logger = opts.logger
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.maxPoisonAttempts = opts.maxPoisonAttempts ?? DEFAULT_MAX_POISON
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.schedule(this.intervalMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    await this.runOnce()
    // Back off while failures persist; otherwise resume the steady cadence.
    const delay =
      this.failures > 0
        ? Math.min(this.intervalMs * 2 ** this.failures, this.backoffMaxMs)
        : this.intervalMs
    this.schedule(delay)
  }

  /** One drain pass over the sealed segments. Exposed for tests. */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.wal.flush()
      await this.wal.forceRotate()
      const segments = await this.wal.segments()
      for (const path of segments) {
        const ok = await this.shipOne(path)
        if (!ok) return // outage/auth → stop the batch, keep the rest for next tick
      }
      this.failures = 0
    } catch (error) {
      this.failures++
      this.logger.warn('Telemetry shipper pass failed', { error: errMsg(error) })
    } finally {
      this.running = false
    }
  }

  /** @returns true to continue the batch, false to stop it (outage/auth). */
  private async shipOne(path: string): Promise<boolean> {
    let body: Buffer
    try {
      body = await readFile(path)
    } catch {
      return true // file vanished (cap eviction) — skip, keep going
    }
    let status: number
    try {
      status = await this.transport.send(body)
    } catch (error) {
      this.failures++
      this.logger.warn('Telemetry ship transport error', { error: errMsg(error) })
      return false
    }
    if (status === 204) {
      await this.drop(path)
      this.failures = 0
      this.poison.delete(path)
      return true
    }
    if (status === 400) {
      const tries = (this.poison.get(path) ?? 0) + 1
      this.poison.set(path, tries)
      if (tries >= this.maxPoisonAttempts) {
        this.logger.warn('Telemetry dropping poison segment', { path, tries })
        await this.drop(path)
        this.poison.delete(path)
      }
      return true // 400 is per-segment; keep draining the rest
    }
    // 401 / 5xx → server problem; stop and back off.
    this.failures++
    this.logger.warn('Telemetry ingest rejected batch', { status })
    return false
  }

  private async drop(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch {
      // already gone
    }
  }
}

export class FetchTransport implements ShipTransport {
  private readonly endpoint: string
  constructor(
    url: string,
    private readonly token: string,
    private readonly logger: LoggerInterface,
  ) {
    this.endpoint = `${url.replace(/\/+$/, '')}/v1/events`
  }
  async send(body: Buffer): Promise<number> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/x-ndjson',
      },
      body,
    })
    return res.status
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/ship/shipper.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fleet-telemetry/src/ship/shipper.ts packages/fleet-telemetry/src/ship/shipper.test.ts
git commit -m "feat(fleet-telemetry): add Shipper (drain WAL → ingest, at-least-once)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the Shipper into the controller + factory

Starts/stops the Shipper with the capture lifecycle, only when an ingest URL is configured.

**Files:**
- Modify: `packages/fleet-telemetry/src/controller.ts`
- Modify: `packages/fleet-telemetry/src/create.ts`
- Test: `packages/fleet-telemetry/src/controller.test.ts`

**Interfaces:**
- Consumes: `Shipper`/`FetchTransport` (Task 3); `TelemetryConfig.ingestUrl/ingestToken/shipIntervalMs` (Task 2).
- Produces: `CaptureController` constructor gains a 7th optional param `shipper?: { start(): void; stop(): Promise<void> }`. `start()` calls `shipper.start()`; `stop()` awaits `shipper.stop()` (before the sink flush/close).

- [ ] **Step 1: Write the failing test** — add to `controller.test.ts` (it already imports `FakeCdp`, `CollectingSink`, `silentLogger`, `testContext`; check the top of the file for exact names and reuse them):

```ts
test('starts and stops the shipper with the capture lifecycle', async () => {
  const cdp = new FakeCdp()
  const sink = new CollectingSink()
  const calls: string[] = []
  const shipper = {
    start: () => calls.push('start'),
    stop: async () => {
      calls.push('stop')
    },
  }
  const controller = new CaptureController(
    cdp,
    { enabled: true, captureLevel: 'metadata', bodyMaxBytes: 1024, walDir: '', ingestUrl: 'x', ingestToken: '', shipIntervalMs: 1000 },
    sink,
    silentLogger,
    testContext,
    'run-1',
    shipper,
  )
  await controller.start()
  await controller.stop()
  expect(calls).toEqual(['start', 'stop'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/controller.test.ts`
Expected: FAIL — constructor ignores the 7th arg / `calls` stays empty.

- [ ] **Step 3: Implement**

In `controller.ts`, add the constructor param (after `runId`):
```ts
    private readonly runId: string,
    private readonly shipper?: { start(): void; stop(): Promise<void> },
```
In `start()`, after the `this.logger.info('Fleet telemetry capture started', …)` call, add:
```ts
    this.shipper?.start()
```
In `stop()`, before `await this.sink.flush()`, add:
```ts
    await this.shipper?.stop()
```

In `create.ts`, replace the controller construction with shipper wiring. Add imports at the top:
```ts
import { FetchTransport, Shipper } from './ship/shipper'
```
Replace the `return new CaptureController(...)` block with:
```ts
  const shipper = config.ingestUrl
    ? new Shipper({
        wal: sink,
        transport: new FetchTransport(
          config.ingestUrl,
          config.ingestToken,
          deps.logger,
        ),
        logger: deps.logger,
        intervalMs: config.shipIntervalMs,
      })
    : undefined
  if (shipper) deps.logger.info('Fleet telemetry shipper enabled')
  return new CaptureController(
    deps.cdp,
    config,
    sink,
    deps.logger,
    deps.context,
    runId,
    shipper,
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry/src/controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Full package check + commit**

Run: `cd packages/browseros-agent && bun test packages/fleet-telemetry && bun --cwd packages/fleet-telemetry run typecheck`
Expected: all tests PASS, typecheck clean.

```bash
git add packages/fleet-telemetry/src/controller.ts packages/fleet-telemetry/src/create.ts packages/fleet-telemetry/src/controller.test.ts
git commit -m "feat(fleet-telemetry): wire Shipper into capture lifecycle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **M1 gate:** `cd packages/browseros-agent && bun run check` should be green. Device side complete; runtime behavior unchanged unless `BROWSEROS_TELEMETRY_INGEST_URL` is set.

---

## Task 5: Central package scaffold + envelope schema

Stands up the standalone `fleet-central/ingest` package and the zod envelope the ingest validates against.

**Files:**
- Create: `fleet-central/ingest/package.json`, `fleet-central/ingest/tsconfig.json`
- Create: `fleet-central/ingest/src/envelope.ts`
- Test: `fleet-central/ingest/src/envelope.test.ts`
- Create: `fleet-central/.gitignore`

**Interfaces:**
- Produces: `EnvelopeSchema` (zod) and `type Envelope = z.infer<typeof EnvelopeSchema>` mirroring the device's `TelemetryEvent`; `parseLine(line: string): { ok: true; value: Envelope } | { ok: false }`.

- [ ] **Step 1: Create the package scaffold**

`fleet-central/ingest/package.json`:
```json
{
  "name": "fleet-ingest",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "start": "bun src/index.ts"
  },
  "dependencies": {
    "@clickhouse/client": "^1.7.0",
    "hono": "^4.12.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/bun": "latest"
  }
}
```

`fleet-central/ingest/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src"]
}
```

`fleet-central/.gitignore`:
```
node_modules/
.env
clickhouse-data/
bun.lock
```

Run: `cd fleet-central/ingest && bun install`
Expected: dependencies installed, `node_modules` present.

- [ ] **Step 2: Write the failing test** — `fleet-central/ingest/src/envelope.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseLine } from './envelope'

// A representative event exactly as the device emits it (see fleet-telemetry types.ts).
const DEVICE_EVENT = {
  schema_version: 0,
  event_id: 'e1',
  ts: 1_700_000_000_000,
  install_id: 'i',
  device_id: null,
  company_id: null,
  user_id: null,
  session_id: 'run',
  browseros_version: '1.2.3',
  chromium_version: '120.0.0',
  os: 'macos',
  channel: 'dev',
  tab_id: null,
  frame_id: null,
  target_type: null,
  type: 'network.request',
  payload: { method: 'GET', status: 200 },
}

describe('parseLine', () => {
  test('accepts a real device envelope', () => {
    const r = parseLine(JSON.stringify(DEVICE_EVENT))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.event_id).toBe('e1')
  })
  test('rejects non-JSON', () => {
    expect(parseLine('not json').ok).toBe(false)
  })
  test('rejects a missing required field', () => {
    const { event_id, ...rest } = DEVICE_EVENT
    expect(parseLine(JSON.stringify(rest)).ok).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd fleet-central/ingest && bun test src/envelope.test.ts`
Expected: FAIL — cannot resolve `./envelope`.

- [ ] **Step 4: Implement** — `fleet-central/ingest/src/envelope.ts`:

```ts
import { z } from 'zod'

/**
 * Mirrors the device's taxonomy-v0 TelemetryEvent (fleet-telemetry/src/types.ts).
 * Kept standalone so this service stays decoupled from the device package build;
 * envelope.test.ts pins it to a real device event so drift is caught.
 */
export const EnvelopeSchema = z.object({
  schema_version: z.literal(0),
  event_id: z.string().min(1),
  ts: z.number(),
  install_id: z.string(),
  device_id: z.string().nullable(),
  company_id: z.string().nullable(),
  user_id: z.string().nullable(),
  session_id: z.string(),
  browseros_version: z.string(),
  chromium_version: z.string(),
  os: z.enum(['macos', 'windows', 'linux']),
  channel: z.enum(['dev', 'dogfood', 'prod']),
  tab_id: z.number().nullable(),
  frame_id: z.string().nullable(),
  target_type: z.string().nullable(),
  type: z.string(),
  payload: z.record(z.unknown()),
})

export type Envelope = z.infer<typeof EnvelopeSchema>

export function parseLine(
  line: string,
): { ok: true; value: Envelope } | { ok: false } {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false }
  }
  const parsed = EnvelopeSchema.safeParse(json)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}
```

- [ ] **Step 5: Run test + commit**

Run: `cd fleet-central/ingest && bun test src/envelope.test.ts`
Expected: PASS (3 tests).

```bash
git add fleet-central/.gitignore fleet-central/ingest/package.json fleet-central/ingest/tsconfig.json fleet-central/ingest/src/envelope.ts fleet-central/ingest/src/envelope.test.ts
git commit -m "feat(fleet-central): scaffold ingest package + envelope schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: StoreWriter seam + ingest HTTP app

The ingest endpoint: auth, JSONL validation, write through the swappable `StoreWriter`.

**Files:**
- Create: `fleet-central/ingest/src/store/store-writer.ts`
- Create: `fleet-central/ingest/src/app.ts`
- Test: `fleet-central/ingest/src/app.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `parseLine` (Task 5).
- Produces:
  - `interface StoreWriter { write(events: Envelope[]): Promise<void>; health(): Promise<boolean>; close(): Promise<void> }`
  - `class MemoryStore implements StoreWriter` with a public `events: Envelope[]`.
  - `createApp(opts: { store: StoreWriter; token: string }): Hono` — `GET /health`, `POST /v1/events` per spec §5.2 (204 ok, 400 all-unparseable, 401 bad token; partial success accepts valid lines and returns 204).

- [ ] **Step 1: Write the failing test** — `fleet-central/ingest/src/app.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { createApp } from './app'
import { MemoryStore } from './store/store-writer'

const EVENT = {
  schema_version: 0, event_id: 'e1', ts: 1, install_id: 'i',
  device_id: null, company_id: null, user_id: null, session_id: 's',
  browseros_version: '1', chromium_version: '1', os: 'macos', channel: 'dev',
  tab_id: null, frame_id: null, target_type: null, type: 'navigation', payload: {},
}
const TOKEN = 'secret'

function req(body: string, token = TOKEN): Request {
  return new Request('http://x/v1/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' },
    body,
  })
}

describe('ingest app', () => {
  test('health reports store status', async () => {
    const app = createApp({ store: new MemoryStore(), token: TOKEN })
    const res = await app.request('http://x/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', store: 'connected' })
  })

  test('401 on a bad token', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const res = await app.request(req(`${JSON.stringify(EVENT)}\n`, 'wrong'))
    expect(res.status).toBe(401)
    expect(store.events).toHaveLength(0)
  })

  test('204 and stores valid events', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const body = `${JSON.stringify(EVENT)}\n${JSON.stringify({ ...EVENT, event_id: 'e2' })}\n`
    const res = await app.request(req(body))
    expect(res.status).toBe(204)
    expect(store.events.map((e) => e.event_id)).toEqual(['e1', 'e2'])
  })

  test('partial success: keeps valid lines, ignores garbage, returns 204', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const body = `${JSON.stringify(EVENT)}\nGARBAGE\n`
    const res = await app.request(req(body))
    expect(res.status).toBe(204)
    expect(store.events).toHaveLength(1)
  })

  test('400 when no line is parseable', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const res = await app.request(req('garbage\nmore garbage\n'))
    expect(res.status).toBe(400)
    expect(store.events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd fleet-central/ingest && bun test src/app.test.ts`
Expected: FAIL — cannot resolve `./app`.

- [ ] **Step 3: Implement the store** — `fleet-central/ingest/src/store/store-writer.ts`:

```ts
import type { Envelope } from '../envelope'

/** The swappable destination. ClickHouse today; OTel/Redpanda/managed later. */
export interface StoreWriter {
  write(events: Envelope[]): Promise<void>
  health(): Promise<boolean>
  close(): Promise<void>
}

/** In-memory store for tests and the `docker compose` skeleton. */
export class MemoryStore implements StoreWriter {
  readonly events: Envelope[] = []
  async write(events: Envelope[]): Promise<void> {
    this.events.push(...events)
  }
  async health(): Promise<boolean> {
    return true
  }
  async close(): Promise<void> {}
}
```

- [ ] **Step 4: Implement the app** — `fleet-central/ingest/src/app.ts`:

```ts
import { Hono } from 'hono'
import type { Envelope } from './envelope'
import { parseLine } from './envelope'
import type { StoreWriter } from './store/store-writer'

export interface AppOptions {
  store: StoreWriter
  token: string
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const ok = await opts.store.health()
    return c.json({ status: ok ? 'ok' : 'degraded', store: ok ? 'connected' : 'down' })
  })

  app.post('/v1/events', async (c) => {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${opts.token}`) return c.body(null, 401)

    const raw = await c.req.text()
    const valid: Envelope[] = []
    let lines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      lines++
      const r = parseLine(line)
      if (r.ok) valid.push(r.value)
    }
    if (lines > 0 && valid.length === 0) return c.body(null, 400)
    if (valid.length > 0) await opts.store.write(valid)
    return c.body(null, 204)
  })

  return app
}
```

- [ ] **Step 5: Run test + commit**

Run: `cd fleet-central/ingest && bun test src/app.test.ts`
Expected: PASS (5 tests).

```bash
git add fleet-central/ingest/src/store/store-writer.ts fleet-central/ingest/src/app.ts fleet-central/ingest/src/app.test.ts
git commit -m "feat(fleet-central): ingest HTTP app + StoreWriter seam

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: ClickHouse schema + `ClickHouseStore`

The real store. Schema uses `ReplacingMergeTree` so resent (`event_id`-duplicate) rows collapse.

**Files:**
- Create: `fleet-central/clickhouse/init/01-schema.sql`
- Create: `fleet-central/ingest/src/store/clickhouse-store.ts`
- Test: `fleet-central/ingest/src/store/clickhouse-store.test.ts` (integration; skipped without `CLICKHOUSE_URL`)

**Interfaces:**
- Consumes: `Envelope` (Task 5), `StoreWriter` (Task 6).
- Produces: `class ClickHouseStore implements StoreWriter` — `constructor(opts: { url: string; database: string; username: string; password: string })`; `write` does one batch `insert` into `events` (format `JSONEachRow`); `health` runs `SELECT 1`.

- [ ] **Step 1: Write the schema** — `fleet-central/clickhouse/init/01-schema.sql`:

```sql
CREATE DATABASE IF NOT EXISTS fleet;

CREATE TABLE IF NOT EXISTS fleet.events (
  event_id          String,
  ts                DateTime64(3),
  ingested_at       DateTime64(3) DEFAULT now64(3),
  schema_version    UInt8,
  install_id        String,
  device_id         Nullable(String),
  company_id        Nullable(String),
  user_id           Nullable(String),
  session_id        String,
  browseros_version String,
  chromium_version  String,
  os                LowCardinality(String),
  channel           LowCardinality(String),
  tab_id            Nullable(Int64),
  frame_id          Nullable(String),
  target_type       Nullable(String),
  type              LowCardinality(String),
  payload           String
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (type, ts, event_id);
```

- [ ] **Step 2: Write the failing integration test** — `clickhouse-store.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { Envelope } from '../envelope'
import { ClickHouseStore } from './clickhouse-store'

const URL = process.env.CLICKHOUSE_URL
const skip = !URL

function event(id: string): Envelope {
  return {
    schema_version: 0, event_id: id, ts: 1_700_000_000_000, install_id: 'i',
    device_id: null, company_id: null, user_id: null, session_id: 's',
    browseros_version: '1', chromium_version: '1', os: 'macos', channel: 'dev',
    tab_id: null, frame_id: null, target_type: null, type: 'navigation',
    payload: { test: true },
  }
}

describe.skipIf(skip)('ClickHouseStore (integration)', () => {
  const store = new ClickHouseStore({
    url: URL ?? '',
    database: 'fleet',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  })

  test('health is true against a live server', async () => {
    expect(await store.health()).toBe(true)
  })

  test('insert then read back, and dedup by event_id', async () => {
    const id = `it-${process.env.USER ?? 'x'}-dedup`
    await store.write([event(id)])
    await store.write([event(id)]) // resend → must collapse with FINAL
    const client = store.rawClient()
    const rs = await client.query({
      query: `SELECT count() AS c FROM fleet.events FINAL WHERE event_id = {id:String}`,
      query_params: { id },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<{ c: string }>
    expect(Number(rows[0].c)).toBe(1)
    await store.close()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd fleet-central/ingest && bun test src/store/clickhouse-store.test.ts`
Expected: FAIL — cannot resolve `./clickhouse-store` (tests are skipped only after the import resolves).

- [ ] **Step 4: Implement** — `fleet-central/ingest/src/store/clickhouse-store.ts`:

```ts
import { type ClickHouseClient, createClient } from '@clickhouse/client'
import type { Envelope } from '../envelope'
import type { StoreWriter } from './store-writer'

export interface ClickHouseStoreOptions {
  url: string
  database: string
  username: string
  password: string
}

export class ClickHouseStore implements StoreWriter {
  private readonly client: ClickHouseClient

  constructor(opts: ClickHouseStoreOptions) {
    this.client = createClient({
      url: opts.url,
      database: opts.database,
      username: opts.username,
      password: opts.password,
    })
  }

  async write(events: Envelope[]): Promise<void> {
    if (events.length === 0) return
    await this.client.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: events.map((e) => ({
        event_id: e.event_id,
        ts: e.ts, // DateTime64(3): epoch ms
        schema_version: e.schema_version,
        install_id: e.install_id,
        device_id: e.device_id,
        company_id: e.company_id,
        user_id: e.user_id,
        session_id: e.session_id,
        browseros_version: e.browseros_version,
        chromium_version: e.chromium_version,
        os: e.os,
        channel: e.channel,
        tab_id: e.tab_id,
        frame_id: e.frame_id,
        target_type: e.target_type,
        type: e.type,
        payload: JSON.stringify(e.payload),
      })),
    })
  }

  async health(): Promise<boolean> {
    try {
      await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
      return true
    } catch {
      return false
    }
  }

  /** Escape hatch for tests that read rows back. */
  rawClient(): ClickHouseClient {
    return this.client
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
```

- [ ] **Step 5: Verify (with a throwaway ClickHouse) + commit**

Run (spin up a temporary CH, apply schema, run the integration test):
```bash
cd fleet-central
docker run -d --name ch-test -p 8123:8123 \
  -v "$PWD/clickhouse/init":/docker-entrypoint-initdb.d \
  clickhouse/clickhouse-server:24.8
sleep 8
cd ingest && CLICKHOUSE_URL=http://localhost:8123 bun test src/store/clickhouse-store.test.ts
cd .. && docker rm -f ch-test
```
Expected: 2 integration tests PASS (dedup count == 1). (Without `CLICKHOUSE_URL` the suite is skipped — that is the normal CI path.)

```bash
git add fleet-central/clickhouse/init/01-schema.sql fleet-central/ingest/src/store/clickhouse-store.ts fleet-central/ingest/src/store/clickhouse-store.test.ts
git commit -m "feat(fleet-central): ClickHouse schema + ClickHouseStore with event_id dedup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Entrypoint + Docker Compose

Wires real env → `ClickHouseStore` → served app, and packages the whole center as `docker compose up`.

**Files:**
- Create: `fleet-central/ingest/src/index.ts`
- Create: `fleet-central/ingest/Dockerfile`
- Create: `fleet-central/docker-compose.yml`
- Create: `fleet-central/.env.example`
- Create: `fleet-central/README.md`

**Interfaces:**
- Consumes: `createApp` (Task 6), `ClickHouseStore` (Task 7).

- [ ] **Step 1: Implement the entrypoint** — `fleet-central/ingest/src/index.ts`:

```ts
import { createApp } from './app'
import { ClickHouseStore } from './store/clickhouse-store'

const port = Number(process.env.INGEST_PORT ?? 9400)
const token = process.env.INGEST_TOKEN
if (!token) {
  console.error('INGEST_TOKEN is required')
  process.exit(1)
}

const store = new ClickHouseStore({
  url: process.env.CLICKHOUSE_URL ?? 'http://clickhouse:8123',
  database: process.env.CLICKHOUSE_DB ?? 'fleet',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
})

const app = createApp({ store, token })
console.log(`fleet-ingest listening on :${port}`)
export default { port, fetch: app.fetch }
```

- [ ] **Step 2: Verify it boots and rejects a missing token**

Run: `cd fleet-central/ingest && bun src/index.ts`
Expected: exits with `INGEST_TOKEN is required`. Then:
Run: `cd fleet-central/ingest && INGEST_TOKEN=dev CLICKHOUSE_URL=http://localhost:1 bun src/index.ts &` then `curl -s localhost:9400/health; kill %1`
Expected: server prints the listening line; `/health` returns `{"status":"degraded","store":"down"}` (no CH reachable — proves wiring, not connectivity).

- [ ] **Step 3: Write the Dockerfile** — `fleet-central/ingest/Dockerfile`:

```dockerfile
FROM oven/bun:1.3
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
EXPOSE 9400
CMD ["bun", "src/index.ts"]
```

- [ ] **Step 4: Write `docker-compose.yml`** — `fleet-central/docker-compose.yml`:

```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.8
    restart: unless-stopped
    environment:
      CLICKHOUSE_DB: ${CLICKHOUSE_DB:-fleet}
      CLICKHOUSE_USER: ${CLICKHOUSE_USER:-default}
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD:-}
    volumes:
      - ./clickhouse/init:/docker-entrypoint-initdb.d:ro
      - clickhouse-data:/var/lib/clickhouse
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8123/ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  ingest:
    build: ./ingest
    restart: unless-stopped
    depends_on:
      clickhouse:
        condition: service_healthy
    environment:
      INGEST_PORT: 9400
      INGEST_TOKEN: ${INGEST_TOKEN:?set INGEST_TOKEN in .env}
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_DB: ${CLICKHOUSE_DB:-fleet}
      CLICKHOUSE_USER: ${CLICKHOUSE_USER:-default}
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD:-}
    ports:
      - "${INGEST_PORT:-9400}:9400"

volumes:
  clickhouse-data:
```

- [ ] **Step 5: Write `.env.example` and `README.md`**

`fleet-central/.env.example`:
```
# Central pipeline config. Copy to .env (gitignored) and fill in.
INGEST_PORT=9400
INGEST_TOKEN=change-me-to-a-long-random-string
CLICKHOUSE_DB=fleet
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
```

`fleet-central/README.md`:
```markdown
# fleet-central

Central telemetry pipeline for the BrowserOS fork. Runs locally in Docker today
and deploys to AWS by changing only `.env`. The device knows only an ingest
URL + token; everything here is replaceable without touching devices.

## Run locally
1. `cp .env.example .env` and set a strong `INGEST_TOKEN`.
2. `docker compose up --build`
3. Health: `curl localhost:9400/health` → `{"status":"ok","store":"connected"}`.

## Point a device at it
On the device (from `packages/browseros-agent`):
```
BROWSEROS_TELEMETRY_ENABLED=true \
BROWSEROS_TELEMETRY_LEVEL=bodies \
BROWSEROS_TELEMETRY_INGEST_URL=http://localhost:9400 \
BROWSEROS_TELEMETRY_INGEST_TOKEN=<same as .env> \
bun run dev:watch
```

## Query
```
docker compose exec clickhouse clickhouse-client \
  --query "SELECT type, count() FROM fleet.events GROUP BY type"
```

## Future (central-side only, device frozen)
Insert OTel Collector + Redpanda in front of ingest, or add a `StoreWriter`
that produces to Redpanda; swap ClickHouse to managed via env. None of this
touches the device.
```

- [ ] **Step 6: Verify the full stack boots + commit**

Run:
```bash
cd fleet-central && cp .env.example .env
# set INGEST_TOKEN to a test value in .env first
docker compose up --build -d
sleep 12
curl -s localhost:9400/health
docker compose down
```
Expected: `/health` → `{"status":"ok","store":"connected"}`.

```bash
git add fleet-central/ingest/src/index.ts fleet-central/ingest/Dockerfile fleet-central/docker-compose.yml fleet-central/.env.example fleet-central/README.md
git commit -m "feat(fleet-central): entrypoint + docker-compose (ingest + ClickHouse)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end smoke + HANDOVER update

Proves a real device event lands in ClickHouse, and records the runbook.

**Files:**
- Modify: `docs/fleet-telemetry/HANDOVER.md`

- [ ] **Step 1: Bring up the center**

```bash
cd fleet-central && docker compose up --build -d && sleep 12
curl -s localhost:9400/health   # expect {"status":"ok","store":"connected"}
```

- [ ] **Step 2: Run a device pointed at it**

From `packages/browseros-agent` (after `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"`):
```bash
bun run dev:stop 2>/dev/null
BROWSEROS_TELEMETRY_ENABLED=true \
BROWSEROS_TELEMETRY_LEVEL=bodies \
LOG_LEVEL=debug \
BROWSEROS_TELEMETRY_INGEST_URL=http://localhost:9400 \
BROWSEROS_TELEMETRY_INGEST_TOKEN=<token from fleet-central/.env> \
BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS=5000 \
bun run dev:watch
```
Expected log lines: `Fleet telemetry shipper enabled`, `Fleet telemetry capture started`. Browse to a page (e.g. cnn.com) on the dev BrowserOS to generate events; wait ~15s for at least two ship ticks.

- [ ] **Step 3: Verify rows landed**

```bash
cd fleet-central
docker compose exec clickhouse clickhouse-client \
  --query "SELECT type, count() FROM fleet.events GROUP BY type ORDER BY 2 DESC"
```
Expected: non-zero counts across families (`network.request`, `navigation`, `page.lifecycle`, …).

- [ ] **Step 4: Verify at-least-once dedup**

While the device runs, `docker compose restart ingest`, keep browsing, then:
```bash
docker compose exec clickhouse clickhouse-client \
  --query "SELECT count() - countDistinct(event_id) AS dup_rows_before_merge FROM fleet.events"
docker compose exec clickhouse clickhouse-client \
  --query "SELECT count() FROM fleet.events FINAL"   # deduped view
```
Expected: any duplicates from resends collapse under `FINAL` (the MVP correctness bar).

- [ ] **Step 5: Tear down + record the runbook**

```bash
cd packages/browseros-agent && bun run dev:stop
cd ../../fleet-central && docker compose down
```
Add a `## Fase 3 MVP — central pipeline` section to `docs/fleet-telemetry/HANDOVER.md` capturing: the device contract (URL + token + JSONL), the `fleet-central/` layout, the run/verify/dedup commands above, and the forward path (OTel/Redpanda/managed are central-side, device frozen). Then commit:

```bash
cd .. && git add docs/fleet-telemetry/HANDOVER.md
git commit -m "docs(fleet-telemetry): document Fase 3 MVP central pipeline + E2E runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **M4 / MVP gate:** A real device event is queryable in central ClickHouse; resends dedup under `FINAL`. With the ingest env unset, the device is unchanged. Subsystem #2 (visualization / agent-query layer) is the next spec.

---

## Self-review notes

- **Spec coverage:** §5 contract → Tasks 3/5/6; §6.A Shipper → Task 3; §6 Ajuste → Task 1 (`forceRotate`; `maxFileAgeMs` deliberately dropped, see Global Constraints); §6 config → Task 2; §6.B ingest → Task 6; §6.C store + schema → Tasks 6/7; §6.D Docker → Task 8; §7 envelope-compat → Task 5; §8 error handling → Task 3; §9 testing → Tasks 1/3/6/7/9; §12 forward path → README + HANDOVER (Tasks 8/9).
- **Device↔ingest type pin:** Task 5's `envelope.test.ts` validates a literal copy of the device's `TelemetryEvent` shape; if the device envelope changes, that test fails — the intended drift alarm.
