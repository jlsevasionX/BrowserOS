/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * NetworkCapture — the `network.request` family: correlate the CDP Network
 * lifecycle (requestWillBeSent → responseReceived → loadingFinished/Failed) per
 * `${cdpSessionId}:${requestId}`, fetch + redact bodies on the OWNING session at
 * terminal success (ADR-0001 finding 3), and hand finished records to the
 * controller's envelope writer. Extracted from CaptureController to keep each
 * unit focused; the controller owns the lifecycle, correlation source, and the
 * other families.
 */

import type {
  LoadingFailedEvent,
  LoadingFinishedEvent,
  RequestWillBeSentEvent,
  ResponseReceivedEvent,
} from '@browseros/cdp-protocol/domains/network'
import type { LoggerInterface } from '@browseros/shared/types/logger'
import type { TelemetryConfig } from './config'
import {
  buildNetworkPayload,
  type EventCorrelation,
  type NetworkRecord,
} from './normalizer'
import { Redactor } from './redactor'
import type { TelemetryCdp } from './types'

/** Bound the in-flight correlation map; drop-oldest past this (no silent loss). */
const MAX_INFLIGHT = 8192

interface Inflight {
  start: RequestWillBeSentEvent
  response?: ResponseReceivedEvent['response']
  correlation: EventCorrelation
}

/** Resolve correlation (tab/target/frame) for a request on a given session. */
type Correlate = (sid: string, frameId: string | null) => EventCorrelation
/** Stamp the common envelope and write — supplied by the controller. */
type WriteEvent = (
  type: string,
  correlation: EventCorrelation,
  payload: Record<string, unknown>,
) => void

export class NetworkCapture {
  /** Correlation buffer keyed by `${cdpSessionId}:${requestId}`. */
  private readonly inflight = new Map<string, Inflight>()
  private droppedInflight = 0
  /** Count of body fetches that failed (cache/redirect/no-content — expected). */
  private bodyFail = 0
  private readonly redactor: Redactor

  constructor(
    private readonly cdp: TelemetryCdp,
    private readonly config: TelemetryConfig,
    private readonly logger: LoggerInterface,
    private readonly correlate: Correlate,
    private readonly writeEvent: WriteEvent,
  ) {
    this.redactor = new Redactor(config.bodyMaxBytes)
  }

  /** Subscribe to the Network lifecycle; returns unsubscribers for the owner. */
  subscribe(): Array<() => void> {
    return [
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
    ]
  }

  /** Drop the in-flight buffer (shutdown or reconnect — requestIds go stale). */
  reset(): void {
    this.inflight.clear()
  }

  get stats(): { droppedInflight: number; bodyFail: number } {
    return { droppedInflight: this.droppedInflight, bodyFail: this.bodyFail }
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
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
