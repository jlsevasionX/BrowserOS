/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * M1 sink: counts and debug-logs events instead of persisting them. The real
 * on-disk WAL (M4) drops in behind this same TelemetrySink interface.
 */

import type { LoggerInterface } from '@browseros/shared/types/logger'
import type { TelemetryEvent, TelemetrySink } from '../types'

export class NoopSink implements TelemetrySink {
  private count = 0

  constructor(private readonly logger: LoggerInterface) {}

  write(event: TelemetryEvent): void {
    this.count++
    this.logger.debug('telemetry event (noop sink)', {
      type: event.type,
      ts: event.ts,
      seq: this.count,
    })
  }

  async flush(): Promise<void> {
    this.logger.debug('telemetry noop sink flush', { total: this.count })
  }
}
