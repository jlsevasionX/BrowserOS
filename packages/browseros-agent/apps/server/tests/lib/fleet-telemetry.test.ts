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
