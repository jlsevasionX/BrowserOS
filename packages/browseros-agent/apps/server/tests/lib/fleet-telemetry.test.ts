/**
 * @license
 * Copyright 2026 BrowserOS (fork — fleet-telemetry additive layer)
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { TelemetryController } from '@fleet/telemetry/types'
import {
  argKeysOf,
  setFleetTelemetry,
  trackAgentAction,
  trackAppEvent,
  trackMcpRequest,
} from '../../src/lib/fleet-telemetry'

interface Tracked {
  type: string
  payload: Record<string, unknown>
}

function fakeController(sink: Tracked[]): TelemetryController {
  return {
    async start() {},
    async stop() {},
    track(type, payload) {
      sink.push({ type, payload })
    },
  }
}

afterEach(() => setFleetTelemetry(null))

describe('fleet-telemetry server accessor', () => {
  test('is a no-op when no controller is wired', () => {
    expect(() =>
      trackAgentAction({
        tool: 'click',
        source: 'browser',
        result: 'ok',
        durationMs: 5,
      }),
    ).not.toThrow()
  })

  test('forwards an agent.action with the taxonomy-shaped payload', () => {
    const tracked: Tracked[] = []
    setFleetTelemetry(fakeController(tracked))

    trackAgentAction({
      tool: 'navigate_page',
      source: 'legacy',
      result: 'error',
      durationMs: 42,
      argKeys: ['url'],
      error: 'boom',
    })

    expect(tracked).toHaveLength(1)
    expect(tracked[0].type).toBe('agent.action')
    expect(tracked[0].payload).toEqual({
      tool: 'navigate_page',
      source: 'legacy',
      result: 'error',
      duration_ms: 42,
      arg_keys: ['url'],
      error: 'boom',
    })
  })

  test('forwards an agent.mcp_request with the scope id', () => {
    const tracked: Tracked[] = []
    setFleetTelemetry(fakeController(tracked))

    trackMcpRequest({ scopeId: 'scope-7' })

    expect(tracked).toHaveLength(1)
    expect(tracked[0].type).toBe('agent.mcp_request')
    expect(tracked[0].payload).toEqual({ scope_id: 'scope-7' })
  })

  test('forwards an app.event with name + spread properties', () => {
    const tracked: Tracked[] = []
    setFleetTelemetry(fakeController(tracked))

    trackAppEvent('ui.message.like', { extension_version: '1.0.0', count: 2 })

    expect(tracked).toHaveLength(1)
    expect(tracked[0].type).toBe('app.event')
    expect(tracked[0].payload).toEqual({
      name: 'ui.message.like',
      extension_version: '1.0.0',
      count: 2,
    })
  })

  test('app.event tolerates missing properties', () => {
    const tracked: Tracked[] = []
    setFleetTelemetry(fakeController(tracked))
    trackAppEvent('ui.conversation.reset')
    expect(tracked[0].payload).toEqual({ name: 'ui.conversation.reset' })
  })

  test('argKeysOf returns only top-level key names', () => {
    expect(argKeysOf({ url: 'https://x.test', timeout: 5 })).toEqual([
      'url',
      'timeout',
    ])
    expect(argKeysOf(null)).toEqual([])
    expect(argKeysOf(['a', 'b'])).toEqual([])
    expect(argKeysOf('str')).toEqual([])
  })
})
