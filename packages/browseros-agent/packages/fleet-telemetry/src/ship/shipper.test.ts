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
import { type ShippableWal, Shipper, type ShipTransport } from './shipper'

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
      const names = (await readdir(dir))
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
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
    const shipper = new Shipper({
      wal: walOver(dir),
      transport,
      logger: silentLogger,
    })

    await shipper.runOnce()

    expect(transport.bodies).toHaveLength(2)
    expect(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
    ).toHaveLength(0)
  })

  test('keeps the segment and stops the batch on a 5xx', async () => {
    await seg(dir, 'events-000000.jsonl', '{"event_id":"a"}\n')
    await seg(dir, 'events-000001.jsonl', '{"event_id":"b"}\n')
    const transport = new FakeTransport([503])
    const shipper = new Shipper({
      wal: walOver(dir),
      transport,
      logger: silentLogger,
    })

    await shipper.runOnce()

    // First segment failed → batch stops, both files remain.
    expect(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
    ).toHaveLength(2)
  })

  test('keeps the segment on a network error (transport throws)', async () => {
    await seg(dir, 'events-000000.jsonl', '{"event_id":"a"}\n')
    const transport = new FakeTransport([0])
    const shipper = new Shipper({
      wal: walOver(dir),
      transport,
      logger: silentLogger,
    })

    await shipper.runOnce()

    expect(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
    ).toHaveLength(1)
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
    expect(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
    ).toHaveLength(1)
    await shipper.runOnce() // attempt 2 — kept
    expect(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
    ).toHaveLength(1)
    await shipper.runOnce() // attempt 3 — dropped
    expect(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
    ).toHaveLength(0)
  })
})
