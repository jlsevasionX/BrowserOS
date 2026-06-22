/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Test doubles. A FakeCdp that lets tests drive attach/Network events through
 * the same surface CaptureController consumes, without a live browser.
 */

import type { LoggerInterface } from '@browseros/shared/types/logger'
import type {
  TelemetryCdp,
  TelemetryContext,
  TelemetryEvent,
  TelemetrySessionApi,
  TelemetrySink,
  TelemetryTargetApi,
} from './types'

export const silentLogger: LoggerInterface = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

export const testContext: TelemetryContext = {
  install_id: 'install-test',
  browseros_version: '1.2.3',
  chromium_version: '120.0.0',
  os: 'macos',
  channel: 'dev',
}

export class CollectingSink implements TelemetrySink {
  readonly events: TelemetryEvent[] = []
  write(event: TelemetryEvent): void {
    this.events.push(event)
  }
  async flush(): Promise<void> {}
}

type SessionHandler = (params: unknown, sessionId: string) => void
type TargetHandler = (params: unknown) => void

export class FakeCdp implements TelemetryCdp {
  private epoch = 1
  private sessionHandlers = new Map<string, SessionHandler[]>()
  private targetHandlers = new Map<string, TargetHandler[]>()
  autoAttachCalls = 0
  enabledSessions: string[] = []
  pageEnabledSessions: string[] = []
  releasedSessions: string[] = []
  /** Seed bodies keyed by requestId; absent ⇒ the CDP call rejects (cache miss). */
  readonly responseBodies = new Map<
    string,
    { body: string; base64Encoded: boolean }
  >()
  readonly postBodies = new Map<
    string,
    { postData: string; base64Encoded: boolean }
  >()

  readonly Target = {
    setAutoAttach: async () => {
      this.autoAttachCalls++
    },
    on: (event: string, handler: TargetHandler) => {
      const list = this.targetHandlers.get(event) ?? []
      list.push(handler)
      this.targetHandlers.set(event, list)
      return () => {}
    },
  } as unknown as TelemetryTargetApi

  connectionEpoch(): number {
    return this.epoch
  }

  bumpEpoch(): void {
    this.epoch++
  }

  onSessionEvent(event: string, handler: SessionHandler): () => void {
    const list = this.sessionHandlers.get(event) ?? []
    list.push(handler)
    this.sessionHandlers.set(event, list)
    return () => {}
  }

  session(sessionId: string): TelemetrySessionApi {
    return {
      Network: {
        enable: async () => {
          this.enabledSessions.push(sessionId)
        },
        getResponseBody: async ({ requestId }: { requestId: string }) => {
          const hit = this.responseBodies.get(requestId)
          if (!hit) throw new Error('No resource with given identifier found')
          return hit
        },
        getRequestPostData: async ({ requestId }: { requestId: string }) => {
          const hit = this.postBodies.get(requestId)
          if (!hit) throw new Error('No post data for given request')
          return hit
        },
      },
      Page: {
        enable: async () => {
          this.pageEnabledSessions.push(sessionId)
        },
      },
      Runtime: {
        runIfWaitingForDebugger: async () => {
          this.releasedSessions.push(sessionId)
        },
      },
    } as unknown as TelemetrySessionApi
  }

  /** Drive a per-session Network event into the controller. */
  emitSession(event: string, params: unknown, sessionId: string): void {
    for (const h of this.sessionHandlers.get(event) ?? []) h(params, sessionId)
  }

  /** Drive a root Target event (e.g. attachedToTarget) into the controller. */
  emitTarget(event: string, params: unknown): void {
    for (const h of this.targetHandlers.get(event) ?? []) h(params)
  }
}
