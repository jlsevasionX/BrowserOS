/**
 * @license
 * Copyright 2026 BrowserOS (fork — fleet-telemetry additive layer)
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { TelemetryController } from '@fleet/telemetry/types'
import { createTelemetryRoutes } from '../../../src/api/routes/telemetry'
import { setFleetTelemetry } from '../../../src/lib/fleet-telemetry'

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

describe('POST /telemetry/app-event', () => {
  test('forwards a valid event as app.event and returns 204', async () => {
    const tracked: Tracked[] = []
    setFleetTelemetry(fakeController(tracked))
    const app = createTelemetryRoutes()

    const res = await app.request('http://localhost/app-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ui.message.sent',
        properties: { len: 12 },
      }),
    })

    expect(res.status).toBe(204)
    expect(tracked).toHaveLength(1)
    expect(tracked[0].type).toBe('app.event')
    expect(tracked[0].payload).toEqual({ name: 'ui.message.sent', len: 12 })
  })

  test('rejects a body without a name', async () => {
    const app = createTelemetryRoutes()
    const res = await app.request('http://localhost/app-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { x: 1 } }),
    })
    expect(res.status).toBe(400)
  })
})
