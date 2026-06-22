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

import type { FrameNavigatedEvent } from '@browseros/cdp-protocol/domains/page'
import type {
  AttachedToTargetEvent,
  DetachedFromTargetEvent,
} from '@browseros/cdp-protocol/domains/target'
import type { LoggerInterface } from '@browseros/shared/types/logger'
import type { TelemetryConfig } from './config'
import { NetworkCapture } from './network-capture'
import {
  buildEnvelope,
  buildNavigationPayload,
  buildPageLifecyclePayload,
  type EventCorrelation,
} from './normalizer'
import type {
  TelemetryCdp,
  TelemetryContext,
  TelemetryController,
  TelemetryCorrelation,
  TelemetrySink,
} from './types'

/** How often we check the connection epoch to detect a reconnect. */
const EPOCH_POLL_MS = 3000
/** Target types we enable the Page domain on (frameNavigated comes from these). */
const PAGE_TARGET_TYPES = new Set(['page', 'iframe'])

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
  private readonly sessionMeta = new Map<string, SessionMeta>()
  /** The `network.request` family — correlation, body fetch, redaction. */
  private readonly network: NetworkCapture

  constructor(
    private readonly cdp: TelemetryCdp,
    private readonly config: TelemetryConfig,
    private readonly sink: TelemetrySink,
    private readonly logger: LoggerInterface,
    private readonly context: TelemetryContext,
    /** Browser-run id stamped as `session_id` on every envelope. */
    private readonly runId: string,
  ) {
    this.network = new NetworkCapture(
      cdp,
      config,
      logger,
      (sid, frameId) => this.correlate(sid, frameId),
      (type, correlation, payload) =>
        this.writeEvent(type, correlation, payload),
    )
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
    this.network.reset()
    this.sessionMeta.clear()
    await this.sink.flush()
    await this.sink.close?.()
    this.logger.info('Fleet telemetry capture stopped', this.network.stats)
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
      ...this.network.subscribe(),
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

  private correlate(sid: string, frameId: string | null): EventCorrelation {
    const meta = this.sessionMeta.get(sid)
    return {
      tab_id: meta?.tabId ?? null,
      target_type: meta?.targetType ?? null,
      frame_id: frameId,
    }
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

  private checkEpoch(): void {
    const current = this.cdp.connectionEpoch()
    if (current === this.epoch) return
    this.logger.info('CDP reconnect detected, re-arming telemetry capture', {
      from: this.epoch,
      to: current,
    })
    // Sessions and the auto-attach setting are gone after a reconnect; the old
    // inflight requestIds are stale. Subscriptions persist on the backend.
    this.network.reset()
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
