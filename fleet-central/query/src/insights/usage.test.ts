import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildNavSeries,
  buildTopHosts,
  mapHostCount,
  mapNavBucket,
  parseBucket,
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
  })

  test('nav series buckets by day', () => {
    const q = buildNavSeries(params(), 'day')
    expect(q.sql).toContain('toStartOfDay(ts)')
  })

  test('parseBucket defaults to hour, accepts day', () => {
    expect(parseBucket(undefined)).toBe('hour')
    expect(parseBucket('day')).toBe('day')
    expect(parseBucket('garbage')).toBe('hour')
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
