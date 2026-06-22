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
 * Capture depth follows `config.captureLevel`: `metadata` (M2) | `headers` |
 * `bodies` (M3). Headers ride along in the buffered events; bodies are fetched on
 * the OWNING session at terminal success and pass through the mandatory Redactor.
 * Nested-target recursion (workers under a page) is deferred; root auto-attach
 * already covers pages/tabs and browser-level workers.
 */

import type {
  LoadingFailedEvent,
  LoadingFinishedEvent,
  RequestWillBeSentEvent,
  ResponseReceivedEvent,
} from '@browseros/cdp-protocol/domains/network'
import type { FrameNavigatedEvent } from '@browseros/cdp-protocol/domains/page'
import type {
  AttachedToTargetEvent,
  DetachedFromTargetEvent,
} from '@browseros/cdp-protocol/domains/target'
import type { LoggerInterface } from '@browseros/shared/types/logger'
import type { TelemetryConfig } from './config'
import {
  buildEnvelope,
  buildNavigationPayload,
  buildNetworkPayload,
  buildPageLifecyclePayload,
  type EventCorrelation,
  type NetworkRecord,
} from './normalizer'
import { Redactor } from './redactor'
import type {
  TelemetryCdp,
  TelemetryContext,
  TelemetryController,
  TelemetryCorrelation,
  TelemetrySink,
} from './types'

/** How often we check the connection epoch to detect a reconnect. */
const EPOCH_POLL_MS = 3000
/** Bound the in-flight correlation map; drop-oldest past this (no silent loss). */
const MAX_INFLIGHT = 8192
/** Target types we enable the Page domain on (frameNavigated comes from these). */
const PAGE_TARGET_TYPES = new Set(['page', 'iframe'])

interface Inflight {
  start: RequestWillBeSentEvent
  response?: ResponseReceivedEvent['response']
  correlation: EventCorrelation
}

interface SessionMeta {
  tabId: number | null
  targetType: string | null
  targetId: string | null
  url: string | null
  title: string | null
  openerId: string | null
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
  /** Count of body fetches that failed (cache/redirect/no-content — expected). */
  private bodyFail = 0
  private readonly redactor: Redactor

  constructor(
    private readonly cdp: TelemetryCdp,
    private readonly config: TelemetryConfig,
    private readonly sink: TelemetrySink,
    private readonly logger: LoggerInterface,
    private readonly context: TelemetryContext,
    /** Browser-run id stamped as `session_id` on every envelope. */
    private readonly runId: string,
  ) {
    this.redactor = new Redactor(config.bodyMaxBytes)
  }

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
      stage: 'M3-network',
    })
  }

  /**
   * Emit a server-originated event (no CDP correlation) onto the same pipeline.
   * Safe to call before start()/after stop() — it only shapes + writes.
   */
  track(
    type: string,
    payload: Record<string, unknown>,
    correlation: TelemetryCorrelation = {},
  ): void {
    this.writeEvent(
      type,
      {
        tab_id: correlation.tab_id ?? null,
        frame_id: correlation.frame_id ?? null,
        target_type: correlation.target_type ?? null,
      },
      payload,
    )
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
    await this.sink.close?.()
    this.logger.info('Fleet telemetry capture stopped', {
      droppedInflight: this.droppedInflight,
      bodyFail: this.bodyFail,
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
      this.cdp.Target.on('detachedFromTarget', (p) => {
        this.onDetached(p as DetachedFromTargetEvent)
      }),
      this.cdp.onSessionEvent('Page.frameNavigated', (p, sid) =>
        this.onFrameNavigated(p as FrameNavigatedEvent, sid),
      ),
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
    const info = p.targetInfo
    const meta: SessionMeta = {
      tabId: info.tabId ?? null,
      targetType: info.type ?? null,
      targetId: info.targetId ?? null,
      url: info.url || null,
      title: info.title || null,
      openerId: info.openerId ?? null,
    }
    this.sessionMeta.set(sid, meta)
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
    if (info.type && PAGE_TARGET_TYPES.has(info.type)) {
      try {
        // Page.enable gives us frameNavigated for the `navigation` family.
        await session.Page.enable()
      } catch (error) {
        this.logger.debug('Page.enable failed for session', {
          sid,
          error: errMsg(error),
        })
      }
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
    this.emitLifecycle('opened', meta)
  }

  private onDetached(p: DetachedFromTargetEvent): void {
    const sid = p.sessionId
    const meta = this.sessionMeta.get(sid)
    this.sessionMeta.delete(sid)
    this.emitLifecycle('closed', meta, p.targetId ?? null)
  }

  private emitLifecycle(
    action: 'opened' | 'closed',
    meta: SessionMeta | undefined,
    fallbackTargetId: string | null = null,
  ): void {
    this.writeEvent(
      'page.lifecycle',
      {
        tab_id: meta?.tabId ?? null,
        frame_id: null,
        target_type: meta?.targetType ?? null,
      },
      buildPageLifecyclePayload({
        action,
        targetId: meta?.targetId ?? fallbackTargetId ?? '',
        targetType: meta?.targetType ?? null,
        url: meta?.url ?? null,
        title: meta?.title ?? null,
        openerId: meta?.openerId ?? null,
      }),
    )
  }

  private onFrameNavigated(p: FrameNavigatedEvent, sid: string): void {
    this.writeEvent(
      'navigation',
      this.correlate(sid, p.frame.id),
      buildNavigationPayload(p.frame, p.type),
    )
  }

  private onRequestWillBeSent(p: RequestWillBeSentEvent, sid: string): void {
    const key = `${sid}:${p.requestId}`
    // A redirect reuses the requestId: the prior hop completed with this
    // redirectResponse. Finalize and emit it before starting the new hop.
    if (p.redirectResponse) {
      const prior = this.inflight.get(key)
      if (prior) {
        // Redirect hops carry no fetchable body (the requestId is reused for the
        // final response), so headers only — never a body fetch.
        this.emit(sid, prior.correlation, {
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
    // Only the terminal success path fetches bodies — on the OWNING session.
    this.emit(
      sid,
      f.correlation,
      {
        start: f.start,
        response: f.response,
        encodedDataLength: p.encodedDataLength,
        outcome: 'ok',
      },
      true,
    )
  }

  private onLoadingFailed(p: LoadingFailedEvent, sid: string): void {
    const key = `${sid}:${p.requestId}`
    const f = this.inflight.get(key)
    if (!f) return
    this.inflight.delete(key)
    this.emit(sid, f.correlation, {
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

  /**
   * Build + redact + write. At `headers`/`bodies` level, headers (already in the
   * buffered events) are redacted inline. At `bodies` level on the terminal
   * success path, bodies are fetched on the owning session, redacted, then
   * written asynchronously (fetch must run before the resource is evicted).
   */
  private emit(
    sid: string,
    correlation: EventCorrelation,
    record: NetworkRecord,
    fetchBodies = false,
  ): void {
    if (this.config.captureLevel !== 'metadata') {
      record.requestHeaders = this.redactor.headers(
        record.start.request.headers,
      )
      if (record.response?.headers) {
        record.responseHeaders = this.redactor.headers(record.response.headers)
      }
    }
    if (fetchBodies && this.config.captureLevel === 'bodies') {
      void this.enrichAndWrite(sid, correlation, record)
      return
    }
    this.write(correlation, record)
  }

  /** Fetch request/response bodies on the OWNING session, redact, then write. */
  private async enrichAndWrite(
    sid: string,
    correlation: EventCorrelation,
    record: NetworkRecord,
  ): Promise<void> {
    const requestId = record.start.requestId
    const resourceType = record.start.type
    const req = record.start.request
    try {
      const session = this.cdp.session(sid)
      if (req.postData) {
        record.requestBody = this.redactor.body(
          req.postData,
          false,
          resourceType,
        )
      } else if (req.hasPostData) {
        try {
          const r = await session.Network.getRequestPostData({ requestId })
          record.requestBody = this.redactor.body(
            r.postData,
            r.base64Encoded ?? false,
            resourceType,
          )
        } catch (error) {
          this.bodyFail++
          this.logger.debug('getRequestPostData failed', {
            requestId,
            error: errMsg(error),
          })
        }
      }
      if (this.redactor.shouldCaptureBody(resourceType)) {
        try {
          const r = await session.Network.getResponseBody({ requestId })
          record.responseBody = this.redactor.body(
            r.body,
            r.base64Encoded,
            resourceType,
          )
        } catch (error) {
          // Expected for cached/redirected/no-content responses (de-risk: 34/40).
          this.bodyFail++
          this.logger.debug('getResponseBody failed', {
            requestId,
            error: errMsg(error),
          })
        }
      }
    } finally {
      this.write(correlation, record)
    }
  }

  private write(correlation: EventCorrelation, record: NetworkRecord): void {
    this.writeEvent('network.request', correlation, buildNetworkPayload(record))
  }

  /** Stamp the common envelope and hand a finished event to the sink. */
  private writeEvent(
    type: string,
    correlation: EventCorrelation,
    payload: Record<string, unknown>,
  ): void {
    const event = buildEnvelope({
      context: this.context,
      sessionId: this.runId,
      correlation,
      type,
      payload,
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
