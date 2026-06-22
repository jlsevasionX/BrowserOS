/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Public structural contracts for the fleet-telemetry capture layer.
 *
 * This package is merge-isolated: it never imports server internals. It depends
 * only on the narrow shapes below plus the generated CDP types. The server's
 * CdpBackend already satisfies TelemetryCdp structurally (it implements the full
 * ProtocolApi via declaration merging), so the server passes `cdp` directly.
 * Keeping the coupling structural is what lets the layer survive upstream churn.
 */

import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import type { LoggerInterface } from '@browseros/shared/types/logger'

/** The per-session CDP surface the controller drives (Network + Page + debugger gate). */
export type TelemetrySessionApi = Pick<
  ProtocolApi,
  'Network' | 'Page' | 'Runtime'
>

/** The root-level Target surface: arm auto-attach + observe (de)attach events. */
export type TelemetryTargetApi = Pick<
  ProtocolApi['Target'],
  'setAutoAttach' | 'on'
>

/**
 * The slice of the server's CdpBackend the capture layer needs. CdpBackend
 * implements all of these, so the server passes `cdp` directly.
 */
export interface TelemetryCdp {
  /** Global per-session event hook: one listener fans out to ALL sessions. */
  onSessionEvent(
    event: string,
    handler: (params: unknown, sessionId: string) => void,
  ): () => void
  /** Bumps on every CDP reconnect; the controller re-arms when it changes. */
  connectionEpoch(): number
  /** Per-session API (Network.enable, Runtime.runIfWaitingForDebugger). */
  session(sessionId: string): TelemetrySessionApi
  /** Root Target domain for auto-attach + attach/detach events. */
  Target: TelemetryTargetApi
}

/**
 * Fleet attribution + build context stamped onto every envelope. Sourced from
 * the server at startup. Fields not yet wired (device/company/user) are
 * placeholders filled by fleet enrollment (Fase 5).
 */
export interface TelemetryContext {
  install_id: string
  browseros_version: string
  chromium_version: string
  os: 'macos' | 'windows' | 'linux'
  channel: 'dev' | 'dogfood' | 'prod'
}

/**
 * A normalized telemetry record — the taxonomy v0 common envelope. M2 fills the
 * `network.request` family; later milestones add the rest.
 */
export interface TelemetryEvent {
  schema_version: 0
  event_id: string
  /** Epoch millis (wall clock) at capture. */
  ts: number
  install_id: string
  device_id: string | null
  company_id: string | null
  user_id: string | null
  session_id: string
  browseros_version: string
  chromium_version: string
  os: TelemetryContext['os']
  channel: TelemetryContext['channel']
  tab_id: number | null
  frame_id: string | null
  target_type: string | null
  type: string
  payload: Record<string, unknown>
}

/**
 * Terminal destination for events. M2 keeps the no-op logging sink; M4 swaps in
 * the on-disk WAL behind this same interface.
 */
export interface TelemetrySink {
  write(event: TelemetryEvent): void
  /** Flush buffered events; called on graceful shutdown. */
  flush(): Promise<void>
  /** Release resources (timers, handles) at shutdown. Optional. */
  close?(): Promise<void>
}

/** Lifecycle handle the server holds. */
export interface TelemetryController {
  start(): Promise<void>
  stop(): Promise<void>
}

/** Everything the factory needs to construct a controller. */
export interface TelemetryDeps {
  cdp: TelemetryCdp
  logger: LoggerInterface
  context: TelemetryContext
  /**
   * Default WAL directory, resolved by the server from its data dir (keeps the
   * package free of server path logic). `config.walDir` (env) overrides it.
   */
  walDir?: string
}
