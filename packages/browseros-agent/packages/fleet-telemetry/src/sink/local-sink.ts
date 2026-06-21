/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * LocalSink — the on-disk write-ahead log that replaces the M1 NoopSink. Events
 * are buffered in memory and appended as JSONL to an active segment; the segment
 * rotates past a size cap, and total on-disk size is bounded by dropping the
 * OLDEST rotated segment (never the active one) with a counter — no silent loss
 * (taxonomy v0 §3 / fase-2-plan §4). Fase 3 ships from `segments()` and deletes
 * what it has shipped.
 *
 * The WAL holds redacted bodies, so the directory is created 0700.
 */

import {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { LoggerInterface } from '@browseros/shared/types/logger'
import type { TelemetryEvent, TelemetrySink } from '../types'

const ACTIVE_FILE = 'events.jsonl'
const ROTATED_PREFIX = 'events-'
const ROTATED_SUFFIX = '.jsonl'
const DIR_MODE = 0o700

export interface LocalSinkOptions {
  dir: string
  logger: LoggerInterface
  /** Rotate the active segment once it grows past this many bytes. */
  maxFileBytes?: number
  /** Drop oldest rotated segments once total WAL bytes exceed this. */
  maxTotalBytes?: number
  /** Background flush cadence; <= 0 disables the timer (tests drive flush()). */
  flushIntervalMs?: number
  /** In-memory backpressure cap: drop-oldest past this many buffered lines. */
  bufferMaxLines?: number
}

const DEFAULTS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  flushIntervalMs: 1000,
  bufferMaxLines: 10_000,
}

export class LocalSink implements TelemetrySink {
  private readonly dir: string
  private readonly logger: LoggerInterface
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly bufferMaxLines: number

  private buffer: string[] = []
  private droppedBuffer = 0
  private droppedSegments = 0
  private written = 0
  private activeBytes = 0
  private rotateSeq = 0
  private dirReady = false
  private initialized = false
  private closed = false
  private timer: ReturnType<typeof setInterval> | null = null
  /** Serializes drains so the timer and flush() never append concurrently. */
  private chain: Promise<void> = Promise.resolve()

  constructor(opts: LocalSinkOptions) {
    this.dir = opts.dir
    this.logger = opts.logger
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULTS.maxFileBytes
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULTS.maxTotalBytes
    this.bufferMaxLines = opts.bufferMaxLines ?? DEFAULTS.bufferMaxLines
    const interval = opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs
    if (interval > 0) {
      this.timer = setInterval(() => void this.enqueueDrain(), interval)
      // Don't let the WAL timer keep the process alive on its own.
      this.timer.unref?.()
    }
  }

  get activePath(): string {
    return join(this.dir, ACTIVE_FILE)
  }

  write(event: TelemetryEvent): void {
    if (this.closed) return
    this.buffer.push(JSON.stringify(event))
    if (this.buffer.length > this.bufferMaxLines) {
      this.buffer.shift()
      this.droppedBuffer++
      if (this.droppedBuffer % 1000 === 1) {
        this.logger.warn('Telemetry WAL buffer overflow, dropping oldest', {
          dropped: this.droppedBuffer,
          cap: this.bufferMaxLines,
        })
      }
    }
  }

  /** Flush buffered events to disk. Called on the timer and at shutdown. */
  async flush(): Promise<void> {
    await this.enqueueDrain()
  }

  /** Stop the timer and do a final drain. Safe to call once at shutdown. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.enqueueDrain()
    this.closed = true
    this.logger.info('Telemetry WAL closed', {
      written: this.written,
      droppedBuffer: this.droppedBuffer,
      droppedSegments: this.droppedSegments,
    })
  }

  /** Rotated segments oldest-first; the drain target for Fase 3 (excludes active). */
  async segments(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    return entries
      .filter((f) => f.startsWith(ROTATED_PREFIX) && f.endsWith(ROTATED_SUFFIX))
      .sort(bySegmentSeq)
      .map((f) => join(this.dir, f))
  }

  private enqueueDrain(): Promise<void> {
    this.chain = this.chain.then(() => this.drainOnce())
    return this.chain
  }

  private async drainOnce(): Promise<void> {
    if (this.buffer.length === 0) return
    try {
      await this.ensureInit()
      const lines = this.buffer
      this.buffer = []
      const data = `${lines.join('\n')}\n`
      const bytes = Buffer.byteLength(data, 'utf8')
      await appendFile(this.activePath, data, { mode: 0o600 })
      this.written += lines.length
      this.activeBytes += bytes
      if (this.activeBytes >= this.maxFileBytes) await this.rotate()
      await this.enforceTotalCap()
    } catch (error) {
      // Never throw out of a drain: telemetry must not crash the host.
      this.logger.warn('Telemetry WAL append failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true, mode: DIR_MODE })
      this.dirReady = true
    }
    // Resume an existing active segment + continue the rotation sequence.
    try {
      this.activeBytes = (await stat(this.activePath)).size
    } catch {
      this.activeBytes = 0
    }
    const segs = await this.segments()
    if (segs.length > 0) {
      const last = segs[segs.length - 1]
      this.rotateSeq = (segmentSeq(last) ?? 0) + 1
    }
    this.initialized = true
  }

  private async rotate(): Promise<void> {
    const target = join(
      this.dir,
      `${ROTATED_PREFIX}${String(this.rotateSeq).padStart(6, '0')}${ROTATED_SUFFIX}`,
    )
    this.rotateSeq++
    try {
      await rename(this.activePath, target)
    } catch (error) {
      this.logger.warn('Telemetry WAL rotate failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    this.activeBytes = 0
  }

  private async enforceTotalCap(): Promise<void> {
    const segs = await this.segments()
    if (segs.length === 0) return
    let total = this.activeBytes
    const sizes: Array<{ path: string; size: number }> = []
    for (const path of segs) {
      try {
        const size = (await stat(path)).size
        sizes.push({ path, size })
        total += size
      } catch {
        // already gone; skip
      }
    }
    // Drop oldest rotated segments (never the active one) until under the cap.
    let i = 0
    while (total > this.maxTotalBytes && i < sizes.length) {
      try {
        await unlink(sizes[i].path)
        total -= sizes[i].size
        this.droppedSegments++
        this.logger.warn(
          'Telemetry WAL over size cap, dropped oldest segment',
          {
            segment: sizes[i].path,
            droppedSegments: this.droppedSegments,
          },
        )
      } catch {
        // skip
      }
      i++
    }
  }
}

/** Extract the numeric seq from `events-000123.jsonl`, or null. */
function segmentSeq(path: string): number | null {
  const m = path.match(/events-(\d+)\.jsonl$/)
  return m ? Number.parseInt(m[1], 10) : null
}

function bySegmentSeq(a: string, b: string): number {
  return (segmentSeq(a) ?? 0) - (segmentSeq(b) ?? 0)
}
