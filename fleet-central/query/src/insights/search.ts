import type { QueryParams } from '../params'
import { commonFilter } from '../sql'
import type { InsightQuery } from './agent-activity'

export interface EventRow {
  event_id: string
  ts: string
  type: string
  device_id: string | null
  session_id: string
  host: string | null
  url: string | null
  payload: unknown
}

function safeParse(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export function buildEventSearch(
  p: QueryParams,
  opts: { type?: string; host?: string; q?: string },
): InsightQuery {
  const f = commonFilter(p)
  const clauses: string[] = []
  const params: Record<string, unknown> = {
    ...f.params,
    limit: p.limit,
    offset: p.offset,
  }
  if (opts.type) {
    clauses.push('AND type = {type:String}')
    params.type = opts.type
  }
  if (opts.host) {
    clauses.push("AND JSONExtractString(payload, 'host') = {host:String}")
    params.host = opts.host
  }
  if (opts.q) {
    clauses.push(
      "AND (JSONExtractString(payload, 'url') ILIKE {q:String} OR JSONExtractString(payload, 'tool') ILIKE {q:String})",
    )
    params.q = `%${opts.q}%`
  }
  const sql = `
    SELECT event_id,
           formatDateTime(ts, '%Y-%m-%d %H:%M:%S.%f') AS ts,
           type, device_id, session_id,
           JSONExtractString(payload, 'host') AS host,
           JSONExtractString(payload, 'url') AS url,
           payload
    FROM fleet.events FINAL
    WHERE 1 = 1
      ${f.sql}
      ${clauses.join('\n      ')}
    ORDER BY ts DESC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}`
  return { sql, params }
}

export function buildEventById(eventId: string): InsightQuery {
  const sql = `
    SELECT * FROM fleet.events FINAL
    WHERE event_id = {event_id:String}
    LIMIT 1`
  return { sql, params: { event_id: eventId } }
}

export function buildMetaFacets(): {
  types: InsightQuery
  devices: InsightQuery
  channels: InsightQuery
  oses: InsightQuery
  range: InsightQuery
} {
  return {
    types: {
      sql: 'SELECT type, count() AS count FROM fleet.events FINAL GROUP BY type ORDER BY count DESC',
      params: {},
    },
    devices: {
      sql: 'SELECT DISTINCT device_id FROM fleet.events FINAL WHERE device_id IS NOT NULL',
      params: {},
    },
    channels: { sql: 'SELECT DISTINCT channel FROM fleet.events FINAL', params: {} },
    oses: { sql: 'SELECT DISTINCT os FROM fleet.events FINAL', params: {} },
    range: {
      sql: 'SELECT toUnixTimestamp64Milli(min(ts)) AS min_ts, toUnixTimestamp64Milli(max(ts)) AS max_ts FROM fleet.events FINAL',
      params: {},
    },
  }
}

export function mapEventRow(row: Record<string, unknown>): EventRow {
  return {
    event_id: String(row.event_id),
    ts: String(row.ts),
    type: String(row.type),
    device_id: row.device_id === null ? null : String(row.device_id),
    session_id: String(row.session_id),
    host: row.host ? String(row.host) : null,
    url: row.url ? String(row.url) : null,
    payload: safeParse(row.payload),
  }
}

export function mapFullEvent(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, payload: safeParse(row.payload) }
}
