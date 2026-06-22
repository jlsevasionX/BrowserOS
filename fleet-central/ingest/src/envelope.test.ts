import { describe, expect, test } from 'bun:test'
import { parseLine } from './envelope'

// A representative event exactly as the device emits it (see fleet-telemetry/src/types.ts).
const DEVICE_EVENT = {
  schema_version: 0,
  event_id: 'e1',
  ts: 1_700_000_000_000,
  install_id: 'i',
  device_id: null,
  company_id: null,
  user_id: null,
  session_id: 'run',
  browseros_version: '1.2.3',
  chromium_version: '120.0.0',
  os: 'macos',
  channel: 'dev',
  tab_id: null,
  frame_id: null,
  target_type: null,
  type: 'network.request',
  payload: { method: 'GET', status: 200 },
}

describe('parseLine', () => {
  test('accepts a real device envelope', () => {
    const r = parseLine(JSON.stringify(DEVICE_EVENT))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.event_id).toBe('e1')
  })
  test('rejects non-JSON', () => {
    expect(parseLine('not json').ok).toBe(false)
  })
  test('rejects a missing required field', () => {
    const { event_id, ...rest } = DEVICE_EVENT
    expect(parseLine(JSON.stringify(rest)).ok).toBe(false)
  })
})
