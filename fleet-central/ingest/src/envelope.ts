import { z } from 'zod'

/**
 * Mirrors the device's taxonomy-v0 TelemetryEvent (fleet-telemetry/src/types.ts).
 * Kept standalone so this service stays decoupled from the device package build;
 * envelope.test.ts pins it to a real device event so drift is caught.
 */
export const EnvelopeSchema = z.object({
  schema_version: z.literal(0),
  event_id: z.string().min(1),
  ts: z.number(),
  install_id: z.string(),
  device_id: z.string().nullable(),
  company_id: z.string().nullable(),
  user_id: z.string().nullable(),
  session_id: z.string(),
  browseros_version: z.string(),
  chromium_version: z.string(),
  os: z.enum(['macos', 'windows', 'linux']),
  channel: z.enum(['dev', 'dogfood', 'prod']),
  tab_id: z.number().nullable(),
  frame_id: z.string().nullable(),
  target_type: z.string().nullable(),
  type: z.string(),
  payload: z.record(z.unknown()),
})

export type Envelope = z.infer<typeof EnvelopeSchema>

export function parseLine(
  line: string,
): { ok: true; value: Envelope } | { ok: false } {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false }
  }
  const parsed = EnvelopeSchema.safeParse(json)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}
