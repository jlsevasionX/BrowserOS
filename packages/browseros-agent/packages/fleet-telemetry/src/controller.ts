/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * CaptureController — owns the capture-layer lifecycle and the live CDP capture.
 *
 * Mechanism (ADR-0001, de-risked): arm ROOT auto-attach with pause-on-start on
 * the server's CDP connection so every target — including agent-untouched tabs,
 * workers, and brand-new side-channel tabs — is attached from byte 0. Subscribe
 * to Network.* globally via CdpBackend.onSessionEvent (one listener per event,
 * all sessions). On each attach, enable Network BEFORE releasing the debugger so
 * the initial document and early subresources are not missed. Re-arm on CDP
 * reconnect (the connection epoch bumps; sessions and the auto-attach setting are
 * gone after a reconnect, but our event subscriptions persist on the backend).
 *
 * M2 scope: `network.request` at metadata depth. Bodies + redaction are M3.
 * Nested-target recursion (workers under a page) is deferred; root auto-attach
 * already covers pages/tabs and browser-level workers.
 */

import type {
  LoadingFailedEvent,
  LoadingFinishedEvent,
  RequestWillBeSentEvent,
  ResponseReceivedEvent,
} from '@browseros/cdp-protocol/domains/network'
import type { AttachedToTargetEvent } from '@browseros/cdp-protocol/domains/target'
import type { LoggerInterface } from '@browseros/shared/types/logger'
import type { TelemetryConfig } from './config'
import {
  buildEnvelope,
  buildNetworkPayload,
  type EventCorrelation,
  type NetworkRecord,
} from './normalizer'
import type {
  TelemetryCdp,
  TelemetryContext,
  TelemetryController,
  TelemetrySink,
} from './types'

/** How often we check the connection epoch to detect a reconnect. */
const EPOCH_POLL_MS = 3000
/** Bound the in-flight correlation map; drop-oldest past this (no silent loss). */
const MAX_INFLIGHT = 8192

interface Inflight {
  start: RequestWillBeSentEvent
  response?: ResponseReceivedEvent['response']
  correlation: EventCorrelation
}

interface SessionMeta {
  tabId: number | null
  targetType: string | null
}

export class CaptureController implements TelemetryController {
  private started = false
  private epoch = -1
  private epochTimer: ReturnType<typeof setInterval> | null = null
  private readonly unsubscribers: Array<() => void> = []
  /** Correlation buffer keyed by `${cdpSessionId}:${requestId}`. */
  private readonly inflight = new Map<string, Inflight>()
  private readonly sessionMeta = new Map<string, SessionMeta>()
  private droppedInflight = 0

  constructor(
    private readonly cdp: TelemetryCdp,
    private readonly config: TelemetryConfig,
    private readonly sink: TelemetrySink,
    private readonly logger: LoggerInterface,
    private readonly context: TelemetryContext,
    /** Browser-run id stamped as `session_id` on every envelope. */
    private readonly runId: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.subscribe()
    await this.armAutoAttach()
    this.epoch = this.cdp.connectionEpoch()
    this.epochTimer = setInterval(() => this.checkEpoch(), EPOCH_POLL_MS)

    this.logger.info('Fleet telemetry capture started', {
      captureLevel: this.config.captureLevel,
      epoch: this.epoch,
      stage: 'M2-network-metadata',
    })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    if (this.epochTimer) {
      clearInterval(this.epochTimer)
      this.epochTimer = null
    }
    for (const off of this.unsubscribers.splice(0)) off()
    this.inflight.clear()
    this.sessionMeta.clear()
    await this.sink.flush()
    this.logger.info('Fleet telemetry capture stopped', {
      droppedInflight: this.droppedInflight,
    })
  }

  /**
   * Subscribe once. The backend keeps these handlers across reconnects, so we
   * never re-subscribe — only the auto-attach setting needs re-arming.
   */
  private subscribe(): void {
    this.unsubscribers.push(
      this.cdp.Target.on('attachedToTarget', (p) => {
        void this.onAttached(p)
      }),
      this.cdp.onSessionEvent('Network.requestWillBeSent', (p, sid) =>
        this.onRequestWillBeSent(p as RequestWillBeSentEvent, sid),
      ),
      this.cdp.onSessionEvent('Network.responseReceived', (p, sid) =>
        this.onResponseReceived(p as ResponseReceivedEvent, sid),
      ),
      this.cdp.onSessionEvent('Network.loadingFinished', (p, sid) =>
        this.onLoadingFinished(p as LoadingFinishedEvent, sid),
      ),
      this.cdp.onSessionEvent('Network.loadingFailed', (p, sid) =>
        this.onLoadingFailed(p as LoadingFailedEvent, sid),
      ),
    )
  }

  private async armAutoAttach(): Promise<void> {
    await this.cdp.Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
  }

  private async onAttached(p: AttachedToTargetEvent): Promise<void> {
    const sid = p.sessionId
    this.sessionMeta.set(sid, {
      tabId: p.targetInfo.tabId ?? null,
      targetType: p.targetInfo.type ?? null,
    })
    const session = this.cdp.session(sid)
    try {
      // Enable Network BEFORE releasing the debugger so byte-0 is captured.
      await session.Network.enable()
    } catch (error) {
      this.logger.debug('Network.enable failed for session', {
        sid,
        error: errMsg(error),
      })
    }
    if (p.waitingForDebugger) {
      try {
        await session.Runtime.runIfWaitingForDebugger()
      } catch (error) {
        this.logger.debug('runIfWaitingForDebugger failed', {
          sid,
          error: errMsg(error),
        })
      }
    }
  }

  private onRequestWillBeSent(p: RequestWillBeSentEvent, sid: string): void {
    const key = `${sid}:${p.requestId}`
    // A redirect reuses the requestId: the prior hop completed with this
    // redirectResponse. Finalize and emit it before starting the new hop.
    if (p.redirectResponse) {
      const prior = this.inflight.get(key)
      if (prior) {
        this.emit(prior.correlation, {
          start: prior.start,
          response: p.redirectResponse,
          outcome: 'ok',
        })
      }
    }
    this.inflight.set(key, {
      start: p,
      correlation: this.correlate(sid, p.frameId ?? null),
    })
    this.enforceCap()
  }

  private onResponseReceived(p: ResponseReceivedEvent, sid: string): void {
    const f = this.inflight.get(`${sid}:${p.requestId}`)
    if (f) f.response = p.response
  }

  private onLoadingFinished(p: LoadingFinishedEvent, sid: string): void {
    const key = `${sid}:${p.requestId}`
    const f = this.inflight.get(key)
    if (!f) return
    this.inflight.delete(key)
    this.emit(f.correlation, {
      start: f.start,
      response: f.response,
      encodedDataLength: p.encodedDataLength,
      outcome: 'ok',
    })
  }

  private onLoadingFailed(p: LoadingFailedEvent, sid: string): void {
    const key = `${sid}:${p.requestId}`
    const f = this.inflight.get(key)
    if (!f) return
    this.inflight.delete(key)
    this.emit(f.correlation, {
      start: f.start,
      response: f.response,
      outcome: p.canceled ? 'canceled' : 'failed',
      errorText: p.errorText,
      blockedReason: p.blockedReason,
    })
  }

  private correlate(sid: string, frameId: string | null): EventCorrelation {
    const meta = this.sessionMeta.get(sid)
    return {
      tab_id: meta?.tabId ?? null,
      target_type: meta?.targetType ?? null,
      frame_id: frameId,
    }
  }

  private emit(correlation: EventCorrelation, record: NetworkRecord): void {
    const event = buildEnvelope({
      context: this.context,
      sessionId: this.runId,
      correlation,
      type: 'network.request',
      payload: buildNetworkPayload(record),
      ts: Date.now(),
      eventId: crypto.randomUUID(),
    })
    this.sink.write(event)
  }

  private enforceCap(): void {
    while (this.inflight.size > MAX_INFLIGHT) {
      const oldest = this.inflight.keys().next().value
      if (oldest === undefined) break
      this.inflight.delete(oldest)
      this.droppedInflight++
    }
    // Surface backpressure on the first drop and then every 1k after.
    if (this.droppedInflight > 0 && this.droppedInflight % 1000 === 1) {
      this.logger.warn('Telemetry inflight buffer overflow, dropping oldest', {
        dropped: this.droppedInflight,
        cap: MAX_INFLIGHT,
      })
    }
  }

  private checkEpoch(): void {
    const current = this.cdp.connectionEpoch()
    if (current === this.epoch) return
    this.logger.info('CDP reconnect detected, re-arming telemetry capture', {
      from: this.epoch,
      to: current,
    })
    // Sessions and the auto-attach setting are gone after a reconnect; the old
    // inflight requestIds are stale. Subscriptions persist on the backend.
    this.inflight.clear()
    this.sessionMeta.clear()
    this.armAutoAttach()
      .then(() => {
        this.epoch = current
      })
      .catch((error) => {
        // Leave this.epoch unchanged so the next tick retries the re-arm.
        this.logger.warn('Re-arm auto-attach failed; will retry', {
          error: errMsg(error),
        })
      })
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
