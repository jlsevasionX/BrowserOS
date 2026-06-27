import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildMcpScopes,
  buildToolStats,
  mapMcpScope,
  mapToolStat,
} from './agent-activity'

function params() {
  const r = parseCommonParams({ device_id: 'd1' })
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('agent-activity builders', () => {
  test('tool stats query is scoped to agent.action with FINAL + filters', () => {
    const q = buildToolStats(params())
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain("type = 'agent.action'")
    expect(q.sql).toContain("JSONExtractString(payload, 'tool')")
    expect(q.sql).toContain('device_id = {device_id:String}')
    expect(q.params.device_id).toBe('d1')
  })

  test('mcp scopes query is scoped to agent.mcp_request', () => {
    const q = buildMcpScopes(params())
    expect(q.sql).toContain("type = 'agent.mcp_request'")
    expect(q.sql).toContain("JSONExtractString(payload, 'scope_id')")
  })

  test('mapToolStat coerces strings and computes error_rate', () => {
    const row = { tool: 'navigate', executions: '10', errors: '2', p50_ms: 5, p95_ms: 9 }
    expect(mapToolStat(row)).toEqual({
      tool: 'navigate',
      executions: 10,
      error_rate: 0.2,
      p50_ms: 5,
      p95_ms: 9,
    })
  })

  test('mapToolStat error_rate is 0 when no executions', () => {
    const row = { tool: 'x', executions: '0', errors: '0', p50_ms: 0, p95_ms: 0 }
    expect(mapToolStat(row).error_rate).toBe(0)
  })

  test('mapMcpScope coerces count', () => {
    expect(mapMcpScope({ scope_id: 's', requests: '7' })).toEqual({
      scope_id: 's',
      requests: 7,
    })
  })
})
