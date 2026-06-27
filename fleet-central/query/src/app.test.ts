import { describe, expect, test } from 'bun:test'
import { createApp } from './app'
import { MemoryReader } from './reader/reader'

const TOKEN = 'secret'

describe('query app — skeleton', () => {
  test('health reports store status', async () => {
    const app = createApp({ reader: new MemoryReader(), token: TOKEN })
    const res = await app.request('http://x/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', store: 'connected' })
  })

  test('health degraded when store is unhealthy', async () => {
    const reader = new MemoryReader()
    reader.setUnhealthy()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/health')
    expect(await res.json()).toEqual({ status: 'degraded', store: 'down' })
  })

  test('401 on a missing/bad token for /v1 routes', async () => {
    const app = createApp({ reader: new MemoryReader(), token: TOKEN })
    const res = await app.request('http://x/v1/meta', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /v1/insights/agent-activity', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('shapes {data:{tools,mcp_scopes}, meta}', async () => {
    const reader = new MemoryReader(
      [{ tool: 'navigate', executions: '4', errors: '1', p50_ms: 3, p95_ms: 8 }],
      [{ scope_id: 's1', requests: '2' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/agent-activity', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.tools[0]).toEqual({
      tool: 'navigate', executions: 4, error_rate: 0.25, p50_ms: 3, p95_ms: 8,
    })
    expect(body.data.mcp_scopes[0]).toEqual({ scope_id: 's1', requests: 2 })
    expect(body.meta.row_count).toBe(1)
  })

  test('400 on bad params', async () => {
    const app = createApp({ reader: new MemoryReader(), token: TOKEN })
    const res = await app.request('http://x/v1/insights/agent-activity?from=banana', {
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  test('503 when the reader throws', async () => {
    const reader = new MemoryReader()
    reader.failQueries()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/agent-activity', { headers: auth })
    expect(res.status).toBe(503)
  })
})
