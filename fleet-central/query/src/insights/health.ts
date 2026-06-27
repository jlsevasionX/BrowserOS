import type { QueryParams } from '../params'
import { commonFilter } from '../sql'
import type { InsightQuery } from './agent-activity'

export interface StatusFamily {
  status_family: string
  count: number
}
export interface FailingHost {
  host: string
  failures: number
}
export interface SlowRequest {
  url: string
  total_ms: number
}

export function buildStatusFamilies(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT multiIf(
             JSONExtractString(payload, 'outcome') = 'failed', 'failed',
             JSONExtractInt(payload, 'status') >= 500, '5xx',
             JSONExtractInt(payload, 'status') >= 400, '4xx',
             JSONExtractInt(payload, 'status') >= 300, '3xx',
             JSONExtractInt(payload, 'status') >= 200, '2xx',
             'other') AS status_family,
           count() AS count
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      ${f.sql}
    GROUP BY status_family
    ORDER BY count DESC`
  return { sql, params: f.params }
}

export function buildTopFailingHosts(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'host') AS host,
           count() AS failures
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      AND (JSONExtractString(payload, 'outcome') = 'failed'
           OR JSONExtractInt(payload, 'status') >= 400)
      ${f.sql}
    GROUP BY host
    ORDER BY failures DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildSlowest(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'url') AS url,
           JSONExtractFloat(payload, 'timing', 'total') AS total_ms
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      ${f.sql}
    ORDER BY total_ms DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildErrorCount(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT count() AS c
    FROM fleet.events FINAL
    WHERE type = 'error'
      ${f.sql}`
  return { sql, params: f.params }
}

export function mapStatusFamily(row: Record<string, unknown>): StatusFamily {
  return { status_family: String(row.status_family), count: Number(row.count) }
}
export function mapFailingHost(row: Record<string, unknown>): FailingHost {
  return { host: String(row.host), failures: Number(row.failures) }
}
export function mapSlowRequest(row: Record<string, unknown>): SlowRequest {
  return { url: String(row.url), total_ms: Number(row.total_ms) }
}
export function mapErrorCount(rows: Record<string, unknown>[]): number {
  return rows.length ? Number(rows[0].c) : 0
}
