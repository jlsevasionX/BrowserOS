/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Factory: the single entry point the server calls. Resolves config (default
 * OFF) and returns a controller. When disabled, returns an inert controller so
 * the server's start()/stop() calls are always safe to make unconditionally.
 */

import { resolveTelemetryConfig, type TelemetryConfig } from './config'
import { CaptureController } from './controller'
import { NoopSink } from './sink/noop-sink'
import type { TelemetryController, TelemetryDeps } from './types'

const INERT_CONTROLLER: TelemetryController = {
  async start() {},
  async stop() {},
}

/**
 * Construct the telemetry capture layer. Pass an explicit config to override
 * env resolution (tests); otherwise it reads BROWSEROS_TELEMETRY_* from env.
 */
export function createTelemetry(
  deps: TelemetryDeps,
  config: TelemetryConfig = resolveTelemetryConfig(),
): TelemetryController {
  if (!config.enabled) {
    deps.logger.debug(
      'Fleet telemetry disabled (set BROWSEROS_TELEMETRY_ENABLED=true)',
    )
    return INERT_CONTROLLER
  }

  const sink = new NoopSink(deps.logger)
  const runId = crypto.randomUUID()
  return new CaptureController(
    deps.cdp,
    config,
    sink,
    deps.logger,
    deps.context,
    runId,
  )
}
