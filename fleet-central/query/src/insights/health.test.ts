import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildErrorCount,
  buildSlowest,
  buildStatusFamilies,
  buildTopFailingHosts,
  mapErrorCount,
  mapFailingHost,
  mapSlowRequest,
  mapStatusFamily,
} from './health'

function params() {
  const r = parseCommonParams({})
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('health builders', () => {
  test('status families bucket the HTTP status', () => {
    const q = buildStatusFamilies(params())
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain("type = 'network.request'")
    expect(q.sql).toContain("JSONExtractInt(payload, 'status')")
    expect(q.sql).toContain('multiIf(')
  })

  test('top failing hosts filter to failed/4xx/5xx', () => {
    const q = buildTopFailingHosts(params())
    expect(q.sql).toContain("JSONExtractString(payload, 'host')")
    expect(q.sql).toContain('ORDER BY failures DESC')
  })

  test('slowest uses timing.total', () => {
    const q = buildSlowest(params())
    expect(q.sql).toContain("JSONExtractFloat(payload, 'timing', 'total')")
    expect(q.sql).toContain('ORDER BY total_ms DESC')
  })

  test('error count targets the error family', () => {
    const q = buildErrorCount(params())
    expect(q.sql).toContain("type = 'error'")
    expect(q.sql).toContain('count()')
  })

  test('mappers coerce values', () => {
    expect(mapStatusFamily({ status_family: '2xx', count: '5' })).toEqual({
      status_family: '2xx', count: 5,
    })
    expect(mapFailingHost({ host: 'a.com', failures: '2' })).toEqual({
      host: 'a.com', failures: 2,
    })
    expect(mapSlowRequest({ url: 'http://a', total_ms: 1234 })).toEqual({
      url: 'http://a', total_ms: 1234,
    })
    expect(mapErrorCount([{ c: '7' }])).toBe(7)
    expect(mapErrorCount([])).toBe(0)
  })
})
