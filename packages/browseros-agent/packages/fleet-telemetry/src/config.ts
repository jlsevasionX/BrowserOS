/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Capture-layer configuration. Resolved from env at startup, default OFF so the
 * layer is inert in dev and in any build that hasn't explicitly opted in
 * (mirrors how the existing PostHog metrics stay dark without a key).
 */

import { z } from 'zod'

/** How much of each request/response we keep. Chosen scope: bodies (M3). */
export type CaptureLevel = 'metadata' | 'headers' | 'bodies'

const TelemetryConfigSchema = z.object({
  /** Master switch. Everything no-ops when false. */
  enabled: z.boolean(),
  captureLevel: z.enum(['metadata', 'headers', 'bodies']),
  /** Max stored body size before truncation; a sha256 is always retained. */
  bodyMaxBytes: z.number().int().positive(),
  /** Directory for the local WAL (M4). Empty = derive from the data dir. */
  walDir: z.string(),
  /** Central ingest base URL. Empty ⇒ Shipper inert (WAL-only). */
  ingestUrl: z.string(),
  ingestToken: z.string(),
  /** Ship-loop cadence in ms. */
  shipIntervalMs: z.number().int().positive(),
})

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: false,
  captureLevel: 'metadata',
  bodyMaxBytes: 64 * 1024,
  walDir: '',
  ingestUrl: '',
  ingestToken: '',
  shipIntervalMs: 15_000,
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

function parseLevel(value: string | undefined): CaptureLevel {
  return value === 'headers' || value === 'bodies' || value === 'metadata'
    ? value
    : DEFAULT_TELEMETRY_CONFIG.captureLevel
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Build a validated config from the environment. Recognized vars:
 * - BROWSEROS_TELEMETRY_ENABLED   ("true"/"1" → on; default off)
 * - BROWSEROS_TELEMETRY_LEVEL     ("metadata"|"headers"|"bodies")
 * - BROWSEROS_TELEMETRY_BODY_MAX  (bytes)
 * - BROWSEROS_TELEMETRY_WAL_DIR   (absolute path)
 */
export function resolveTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfig {
  return TelemetryConfigSchema.parse({
    enabled: parseBool(
      env.BROWSEROS_TELEMETRY_ENABLED,
      DEFAULT_TELEMETRY_CONFIG.enabled,
    ),
    captureLevel: parseLevel(env.BROWSEROS_TELEMETRY_LEVEL),
    bodyMaxBytes: parseInt10(
      env.BROWSEROS_TELEMETRY_BODY_MAX,
      DEFAULT_TELEMETRY_CONFIG.bodyMaxBytes,
    ),
    walDir: env.BROWSEROS_TELEMETRY_WAL_DIR ?? DEFAULT_TELEMETRY_CONFIG.walDir,
    ingestUrl:
      env.BROWSEROS_TELEMETRY_INGEST_URL ?? DEFAULT_TELEMETRY_CONFIG.ingestUrl,
    ingestToken:
      env.BROWSEROS_TELEMETRY_INGEST_TOKEN ??
      DEFAULT_TELEMETRY_CONFIG.ingestToken,
    shipIntervalMs: parseInt10(
      env.BROWSEROS_TELEMETRY_SHIP_INTERVAL_MS,
      DEFAULT_TELEMETRY_CONFIG.shipIntervalMs,
    ),
  })
}
