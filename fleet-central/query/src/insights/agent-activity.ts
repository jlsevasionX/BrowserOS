import type { QueryParams } from '../params'
import { commonFilter } from '../sql'

export interface InsightQuery {
  sql: string
  params: Record<string, unknown>
}

export interface ToolStat {
  tool: string
  executions: number
  error_rate: number
  p50_ms: number
  p95_ms: number
}

export interface McpScope {
  scope_id: string
  requests: number
}

export function buildToolStats(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'tool') AS tool,
           count() AS executions,
           countIf(JSONExtractString(payload, 'result') = 'error') AS errors,
           quantile(0.5)(JSONExtractFloat(payload, 'duration_ms')) AS p50_ms,
           quantile(0.95)(JSONExtractFloat(payload, 'duration_ms')) AS p95_ms
    FROM fleet.events FINAL
    WHERE type = 'agent.action'
      ${f.sql}
    GROUP BY tool
    ORDER BY executions DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildMcpScopes(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'scope_id') AS scope_id,
           count() AS requests
    FROM fleet.events FINAL
    WHERE type = 'agent.mcp_request'
      ${f.sql}
    GROUP BY scope_id
    ORDER BY requests DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function mapToolStat(row: Record<string, unknown>): ToolStat {
  const executions = Number(row.executions)
  const errors = Number(row.errors)
  return {
    tool: String(row.tool),
    executions,
    error_rate: executions ? errors / executions : 0,
    p50_ms: Number(row.p50_ms),
    p95_ms: Number(row.p95_ms),
  }
}

export function mapMcpScope(row: Record<string, unknown>): McpScope {
  return { scope_id: String(row.scope_id), requests: Number(row.requests) }
}
