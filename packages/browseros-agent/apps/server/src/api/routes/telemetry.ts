/**
 * @license
 * Copyright 2026 BrowserOS (fork — fleet-telemetry additive layer)
 *
 * First-party intake for product-UI analytics events forwarded by the agent
 * extension. The agent's central `track()` posts here so these events land in
 * our own pipeline as `app.event` (taxonomy §4) instead of egressing to any
 * third party. Best-effort: always 204, never blocks the UI.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { trackAppEvent } from '../../lib/fleet-telemetry'

const AppEventSchema = z.object({
  name: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})

export function createTelemetryRoutes() {
  return new Hono().post(
    '/app-event',
    zValidator('json', AppEventSchema),
    (c) => {
      const { name, properties } = c.req.valid('json')
      trackAppEvent(name, properties)
      return c.body(null, 204)
    },
  )
}
