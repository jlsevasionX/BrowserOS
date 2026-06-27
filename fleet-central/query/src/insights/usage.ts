import type { QueryParams } from '../params'
import { commonFilter } from '../sql'
import type { InsightQuery } from './agent-activity'

export interface HostCount {
  host: string
  requests: number
}

export interface NavBucket {
  bucket: string
  navigations: number
}

export function parseBucket(v: string | undefined): 'hour' | 'day' {
  return v === 'day' ? 'day' : 'hour'
}

export function buildTopHosts(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'host') AS host,
           count() AS requests
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      ${f.sql}
    GROUP BY host
    ORDER BY requests DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildNavSeries(p: QueryParams, bucket: 'hour' | 'day'): InsightQuery {
  const f = commonFilter(p)
  const fn = bucket === 'day' ? 'toStartOfDay' : 'toStartOfHour'
  const sql = `
    SELECT formatDateTime(${fn}(ts), '%Y-%m-%d %H:%M:%S') AS bucket,
           count() AS navigations
    FROM fleet.events FINAL
    WHERE type = 'navigation'
      ${f.sql}
    GROUP BY bucket
    ORDER BY bucket ASC`
  return { sql, params: f.params }
}

export function mapHostCount(row: Record<string, unknown>): HostCount {
  return { host: String(row.host), requests: Number(row.requests) }
}

export function mapNavBucket(row: Record<string, unknown>): NavBucket {
  return { bucket: String(row.bucket), navigations: Number(row.navigations) }
}
