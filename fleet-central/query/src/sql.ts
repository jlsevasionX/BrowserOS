import type { QueryParams } from './params'

/**
 * Shared WHERE fragment: time range (always) + optional exact filters.
 * Returns an SQL string beginning with `AND ...` and the bound params.
 * Callers prepend their own `WHERE type=...`.
 */
export function commonFilter(p: QueryParams): {
  sql: string
  params: Record<string, unknown>
} {
  const clauses: string[] = [
    'AND ts BETWEEN fromUnixTimestamp64Milli({from:Int64}) AND fromUnixTimestamp64Milli({to:Int64})',
  ]
  const params: Record<string, unknown> = { from: p.from, to: p.to }

  const exact: Array<[keyof QueryParams, string]> = [
    ['device_id', 'device_id'],
    ['session_id', 'session_id'],
    ['install_id', 'install_id'],
    ['channel', 'channel'],
    ['os', 'os'],
  ]
  for (const [key, col] of exact) {
    const v = p[key]
    if (v !== undefined) {
      clauses.push(`AND ${col} = {${col}:String}`)
      params[col] = v
    }
  }

  return { sql: clauses.join('\n  '), params }
}
