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
      this.logger.warn('Telemetry shipper pass failed', {
        error: errMsg(error),
      })
    } finally {
      this.running = false
    }
  }

  /** @returns true to continue the batch, false to stop it (outage/auth). */
  private async shipOne(path: string): Promise<boolean> {
    let body: Buffer
    try {
      body = await readFile(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.logger.warn('Telemetry segment read failed', {
          path,
          error: errMsg(error),
        })
      }
      return true // file vanished (cap eviction) — skip, keep going
    }
    let status: number
    try {
      status = await this.transport.send(body)
    } catch (error) {
      this.failures++
      this.logger.warn('Telemetry ship transport error', {
        error: errMsg(error),
      })
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
      // Buffer is a valid body in Bun/Node at runtime; the DOM BodyInit type omits it.
      body: body as unknown as BodyInit,
    })
    return res.status
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
