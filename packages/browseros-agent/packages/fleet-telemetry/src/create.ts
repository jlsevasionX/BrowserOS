/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Factory: the single entry point the server calls. Resolves config (default
 * OFF) and returns a controller. When disabled, returns an inert controller so
 * the server's start()/stop() calls are always safe to make unconditionally.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveTelemetryConfig, type TelemetryConfig } from './config'
import { CaptureController } from './controller'
import { LocalSink } from './sink/local-sink'
import type { TelemetryController, TelemetryDeps } from './types'

const INERT_CONTROLLER: TelemetryController = {
  async start() {},
  async stop() {},
  track() {},
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

  const walDir =
    config.walDir || deps.walDir || join(homedir(), '.browseros', 'telemetry')
  const sink = new LocalSink({ dir: walDir, logger: deps.logger })
  deps.logger.info('Fleet telemetry WAL', { dir: walDir })
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
