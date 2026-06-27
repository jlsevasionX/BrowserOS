import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from './params'
import { commonFilter } from './sql'

function params(over: Record<string, string> = {}) {
  const r = parseCommonParams(over)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('commonFilter', () => {
  test('always binds the time range as Int64 epoch ms', () => {
    const p = params({ from: '1000', to: '2000' })
    const f = commonFilter(p)
    expect(f.sql).toContain('fromUnixTimestamp64Milli({from:Int64})')
    expect(f.sql).toContain('fromUnixTimestamp64Milli({to:Int64})')
    expect(f.params.from).toBe(1000)
    expect(f.params.to).toBe(2000)
  })

  test('binds optional exact filters only when present', () => {
    const f = commonFilter(params({ device_id: 'd1' }))
    expect(f.sql).toContain('device_id = {device_id:String}')
    expect(f.params.device_id).toBe('d1')
    expect(f.sql).not.toContain('channel =')
  })

  test('omits absent filters entirely', () => {
    const f = commonFilter(params({}))
    expect(f.sql).not.toContain('device_id')
    expect(f.sql).not.toContain('channel')
    expect(Object.keys(f.params).sort()).toEqual(['from', 'to'])
  })
})
