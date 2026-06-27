import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildNavSeries,
  buildTopHosts,
  mapHostCount,
  mapNavBucket,
  parseBucket,
  parseTop,
} from './usage'

function params() {
  const r = parseCommonParams({})
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('usage builders', () => {
  test('top hosts counts network.request by host', () => {
    const q = buildTopHosts(params())
    expect(q.sql).toContain("type = 'network.request'")
    expect(q.sql).toContain("JSONExtractString(payload, 'host')")
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain('ORDER BY requests DESC')
  })

  test('nav series buckets by hour', () => {
    const q = buildNavSeries(params(), 'hour')
    expect(q.sql).toContain('toStartOfHour(ts)')
    expect(q.sql).toContain("type = 'navigation'")
    expect(q.sql).toContain('%H:%i:%S')
    expect(q.sql).not.toContain('%M')
  })

  test('nav series buckets by day', () => {
    const q = buildNavSeries(params(), 'day')
    expect(q.sql).toContain('toStartOfDay(ts)')
    expect(q.sql).toContain('%H:%i:%S')
    expect(q.sql).not.toContain('%M')
  })

  test('parseBucket defaults to hour, accepts day', () => {
    expect(parseBucket(undefined)).toBe('hour')
    expect(parseBucket('day')).toBe('day')
    expect(parseBucket('garbage')).toBe('hour')
  })

  test('buildTopHosts with explicit top binds params.top and uses {top:UInt32}', () => {
    const q = buildTopHosts(params(), 5)
    expect(q.sql).toContain('LIMIT {top:UInt32}')
    expect(q.params.top).toBe(5)
  })

  test('buildTopHosts without explicit top falls back to p.limit', () => {
    const p = params()
    const q = buildTopHosts(p)
    expect(q.sql).toContain('LIMIT {top:UInt32}')
    expect(q.params.top).toBe(p.limit)
  })

  test('parseTop defaults to 20, parses positive ints, clamps to 1000, ignores garbage', () => {
    expect(parseTop(undefined)).toBe(20)
    expect(parseTop('')).toBe(20)
    expect(parseTop('5')).toBe(5)
    expect(parseTop('garbage')).toBe(20)
    expect(parseTop('99999')).toBe(1000)
    expect(parseTop('0')).toBe(1)
    expect(parseTop('-5')).toBe(1)
  })

  test('mappers coerce counts', () => {
    expect(mapHostCount({ host: 'a.com', requests: '12' })).toEqual({
      host: 'a.com', requests: 12,
    })
    expect(mapNavBucket({ bucket: '2023-11-14 22:00:00', navigations: '3' })).toEqual({
      bucket: '2023-11-14 22:00:00', navigations: 3,
    })
  })
})
