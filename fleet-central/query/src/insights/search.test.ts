import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildEventById,
  buildEventSearch,
  buildMetaFacets,
  mapEventRow,
  mapFullEvent,
} from './search'

function params() {
  const r = parseCommonParams({})
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('search builders', () => {
  test('event search applies optional type/host/q + paging', () => {
    const q = buildEventSearch(params(), { type: 'navigation', host: 'a.com', q: 'login' })
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain('type = {type:String}')
    expect(q.sql).toContain("JSONExtractString(payload, 'host') = {host:String}")
    expect(q.sql).toContain('ORDER BY ts DESC')
    expect(q.sql).toContain('LIMIT {limit:UInt32} OFFSET {offset:UInt32}')
    expect(q.params.type).toBe('navigation')
    expect(q.params.host).toBe('a.com')
    expect(q.params.q).toBe('%login%')
  })

  test('event search omits absent optional filters', () => {
    const q = buildEventSearch(params(), {})
    expect(q.sql).not.toContain('type = {type:String}')
    expect(q.sql).not.toContain('host')
    expect(q.sql).not.toContain('ILIKE')
  })

  test('event-by-id binds the id', () => {
    const q = buildEventById('abc')
    expect(q.sql).toContain('event_id = {event_id:String}')
    expect(q.params.event_id).toBe('abc')
  })

  test('meta facets cover types/devices/channels/oses/range', () => {
    const f = buildMetaFacets()
    expect(f.types.sql).toContain('GROUP BY type')
    expect(f.devices.sql).toContain('DISTINCT device_id')
    expect(f.channels.sql).toContain('DISTINCT channel')
    expect(f.oses.sql).toContain('DISTINCT os')
    expect(f.range.sql).toContain('min(ts)')
    expect(f.range.sql).toContain('max(ts)')
  })

  test('mapEventRow surfaces key columns', () => {
    const row = {
      event_id: 'e1', ts: '2023-11-14 22:00:00.000', type: 'navigation',
      device_id: null, session_id: 's', host: 'a.com', url: 'http://a', payload: '{}',
    }
    expect(mapEventRow(row)).toEqual({
      event_id: 'e1', ts: '2023-11-14 22:00:00.000', type: 'navigation',
      device_id: null, session_id: 's', host: 'a.com', url: 'http://a', payload: {},
    })
  })

  test('mapFullEvent parses the payload JSON string', () => {
    const row = { event_id: 'e1', type: 'navigation', payload: '{"host":"a.com"}' }
    const full = mapFullEvent(row)
    expect(full.payload).toEqual({ host: 'a.com' })
  })
})
