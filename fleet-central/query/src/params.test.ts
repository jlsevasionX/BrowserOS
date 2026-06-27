import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from './params'

describe('parseCommonParams', () => {
  test('defaults: last 24h, limit 100, offset 0', () => {
    const r = parseCommonParams({})
    if (!r.ok) throw new Error(r.error)
    expect(r.value.limit).toBe(100)
    expect(r.value.offset).toBe(0)
    expect(r.value.to - r.value.from).toBe(86_400_000)
  })

  test('parses epoch-ms strings', () => {
    const r = parseCommonParams({ from: '1700000000000', to: '1700086400000' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.from).toBe(1_700_000_000_000)
    expect(r.value.to).toBe(1_700_086_400_000)
  })

  test('parses ISO timestamps', () => {
    const r = parseCommonParams({ from: '2023-11-14T22:13:20.000Z' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.from).toBe(1_700_000_000_000)
  })

  test('clamps limit to 1000 max', () => {
    const r = parseCommonParams({ limit: '99999' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.limit).toBe(1000)
  })

  test('passes through optional exact filters', () => {
    const r = parseCommonParams({ device_id: 'd1', channel: 'prod', os: 'macos' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.device_id).toBe('d1')
    expect(r.value.channel).toBe('prod')
    expect(r.value.os).toBe('macos')
  })

  test('rejects non-numeric/non-ISO time', () => {
    const r = parseCommonParams({ from: 'banana' })
    expect(r.ok).toBe(false)
  })

  test('rejects from > to', () => {
    const r = parseCommonParams({ from: '2000', to: '1000' })
    expect(r.ok).toBe(false)
  })

  test('clamps offset to UInt32 max (4294967295)', () => {
    const r = parseCommonParams({ offset: '99999999999' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.offset).toBe(4294967295)
  })
})
