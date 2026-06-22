/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_TELEMETRY_CONFIG, resolveTelemetryConfig } from './config'
import { createTelemetry } from './create'
import { FakeCdp, silentLogger, testContext } from './test-helpers'

const fakeCdp = new FakeCdp()

describe('resolveTelemetryConfig', () => {
  test('defaults to disabled when env is empty', () => {
    expect(resolveTelemetryConfig({})).toEqual(DEFAULT_TELEMETRY_CONFIG)
  })

  test('enables and parses overrides from env', () => {
    const cfg = resolveTelemetryConfig({
      BROWSEROS_TELEMETRY_ENABLED: 'true',
      BROWSEROS_TELEMETRY_LEVEL: 'bodies',
      BROWSEROS_TELEMETRY_BODY_MAX: '2048',
      BROWSEROS_TELEMETRY_WAL_DIR: '/tmp/wal',
    })
    expect(cfg).toEqual({
      enabled: true,
      captureLevel: 'bodies',
      bodyMaxBytes: 2048,
      walDir: '/tmp/wal',
      ingestUrl: '',
      ingestToken: '',
      shipIntervalMs: 15000,
    })
  })

  test('falls back on invalid level and body size', () => {
    const cfg = resolveTelemetryConfig({
      BROWSEROS_TELEMETRY_ENABLED: '1',
      BROWSEROS_TELEMETRY_LEVEL: 'nonsense',
      BROWSEROS_TELEMETRY_BODY_MAX: '-5',
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.captureLevel).toBe(DEFAULT_TELEMETRY_CONFIG.captureLevel)
    expect(cfg.bodyMaxBytes).toBe(DEFAULT_TELEMETRY_CONFIG.bodyMaxBytes)
  })

  test('resolves shipper config from env', () => {
    const c = resolveTelemetryConfig({
      BROWSEROS_TELEMETRY_ENABLED: 'true',
      BROWSEROS_TELEMETRY_INGEST_URL: 'https://t.example/',
      BROWSEROS_TELEMETRY_INGEST_TOKEN: 'secret',
      BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS: '5000',
    } as NodeJS.ProcessEnv)
    expect(c.ingestUrl).toBe('https://t.example/')
    expect(c.ingestToken).toBe('secret')
    expect(c.shipIntervalMs).toBe(5000)
  })

  test('shipper config defaults to inert (empty url, 15s interval)', () => {
    const c = resolveTelemetryConfig({} as NodeJS.ProcessEnv)
    expect(c.ingestUrl).toBe('')
    expect(c.shipIntervalMs).toBe(15000)
  })
})

describe('createTelemetry', () => {
  test('returns an inert controller when disabled', async () => {
    const controller = createTelemetry(
      { cdp: fakeCdp, logger: silentLogger, context: testContext },
      { ...DEFAULT_TELEMETRY_CONFIG, enabled: false },
    )
    // start()/stop() must be safe to call unconditionally.
    await controller.start()
    await controller.stop()
  })

  test('builds a real controller when enabled', async () => {
    const controller = createTelemetry(
      { cdp: fakeCdp, logger: silentLogger, context: testContext },
      { ...DEFAULT_TELEMETRY_CONFIG, enabled: true },
    )
    await controller.start()
    await controller.stop()
  })
})
