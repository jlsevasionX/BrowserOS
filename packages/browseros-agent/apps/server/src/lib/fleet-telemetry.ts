/**
 * @license
 * Copyright 2026 BrowserOS (fork — fleet-telemetry additive layer)
 *
 * Thin server-side accessor for the @fleet/telemetry capture layer. Holds the
 * controller handle (set once by main.ts) and exposes typed `track*` helpers so
 * server-originated families — agent.action and friends — can be emitted from
 * choke points (tool-adapter.ts) the same idiomatic way `metrics`/`logger` are
 * imported, without threading the handle through every call site. No-op until
 * the handle is set and a no-op when telemetry is disabled (inert controller).
 */

import type { TelemetryController } from '@fleet/telemetry/types'

let handle: TelemetryController | null = null

/** Wire the live controller (or null to clear) — called from main.ts lifecycle. */
export function setFleetTelemetry(
  controller: TelemetryController | null,
): void {
  handle = controller
}

export interface AgentActionEvent {
  /** Tool name, e.g. `navigate_page`. */
  tool: string
  source: 'browser' | 'legacy' | 'mcp'
  result: 'ok' | 'error'
  durationMs: number
  /** Top-level argument key names only (no values — values may be sensitive). */
  argKeys?: string[]
  error?: string | null
}

/** Emit an `agent.action` (taxonomy v0) for a single tool execution. */
export function trackAgentAction(event: AgentActionEvent): void {
  if (!handle) return
  handle.track('agent.action', {
    tool: event.tool,
    source: event.source,
    result: event.result,
    duration_ms: event.durationMs,
    arg_keys: event.argKeys ?? null,
    error: event.error ?? null,
  })
}

/** Top-level key names of a tool's params object (safe, value-free signal). */
export function argKeysOf(params: unknown): string[] {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? Object.keys(params as Record<string, unknown>)
    : []
}
