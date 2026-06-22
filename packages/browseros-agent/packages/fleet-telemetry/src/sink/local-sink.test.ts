/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { silentLogger } from '../test-helpers'
import type { TelemetryEvent } from '../types'
import { LocalSink } from './local-sink'

function evt(seq: number): TelemetryEvent {
  return {
    schema_version: 0,
    event_id: `e${seq}`,
    ts: 1_700_000_000_000 + seq,
    install_id: 'i',
    device_id: null,
    company_id: null,
    user_id: null,
    session_id: 'run',
    browseros_version: '1',
    chromium_version: '1',
    os: 'macos',
    channel: 'dev',
    tab_id: null,
    frame_id: null,
    target_type: null,
    type: 'network.request',
    payload: { seq },
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-wal-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LocalSink', () => {
  test('appends events as JSONL and flush persists them', async () => {
    const sink = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
    })
    sink.write(evt(1))
    sink.write(evt(2))
    await sink.flush()

    const lines = (await readFile(sink.activePath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].event_id).toBe('e1')
    expect(parsed[1].payload.seq).toBe(2)
    await sink.close()
  })

  test('rotates the active segment past the file-size cap', async () => {
    const sink = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
      maxFileBytes: 400, // a couple of events per segment
    })
    for (let i = 0; i < 12; i++) {
      sink.write(evt(i))
      await sink.flush()
    }
    const segs = await sink.segments()
    expect(segs.length).toBeGreaterThan(0)
    // Rotated segments are ordered oldest-first by seq.
    expect(segs[0]).toContain('events-000000.jsonl')
    await sink.close()
  })

  test('drops the oldest rotated segment when over the total cap', async () => {
    const sink = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
      maxFileBytes: 300,
      maxTotalBytes: 700, // only a segment or two may survive
    })
    for (let i = 0; i < 40; i++) {
      sink.write(evt(i))
      await sink.flush()
    }
    const segs = await sink.segments()
    let total = 0
    for (const s of segs) total += (await readFile(s)).length
    expect(total).toBeLessThanOrEqual(700)
    // The very first segment must have been evicted.
    expect(segs.some((s) => s.endsWith('events-000000.jsonl'))).toBe(false)
    await sink.close()
  })

  test('resumes the rotation sequence on a fresh sink over the same dir', async () => {
    const a = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
      maxFileBytes: 300,
    })
    for (let i = 0; i < 8; i++) {
      a.write(evt(i))
      await a.flush()
    }
    const firstSegs = await a.segments()
    await a.close()

    const b = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
      maxFileBytes: 300,
    })
    for (let i = 100; i < 108; i++) {
      b.write(evt(i))
      await b.flush()
    }
    const moreSegs = await b.segments()
    expect(moreSegs.length).toBeGreaterThan(firstSegs.length)
    // No filename collision: every segment path is unique.
    expect(new Set(moreSegs).size).toBe(moreSegs.length)
    await b.close()
  })

  test('forceRotate seals the active segment so it appears in segments()', async () => {
    const sink = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
    })
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
    const sink = new LocalSink({
      dir,
      logger: silentLogger,
      flushIntervalMs: 0,
    })
    await sink.forceRotate()
    expect(await sink.segments()).toHaveLength(0)
    await sink.close()
  })
})
