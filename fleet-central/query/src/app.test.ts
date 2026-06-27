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

describe('GET /v1/insights/usage', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('shapes {data:{top_hosts,navigations}, meta}', async () => {
    const reader = new MemoryReader(
      [{ host: 'a.com', requests: '9' }],
      [{ bucket: '2023-11-14 22:00:00', navigations: '3' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/usage?bucket=day', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.top_hosts[0]).toEqual({ host: 'a.com', requests: 9 })
    expect(body.data.navigations[0]).toEqual({
      bucket: '2023-11-14 22:00:00', navigations: 3,
    })
  })

  test('503 when the reader throws', async () => {
    const reader = new MemoryReader()
    reader.failQueries()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/usage', { headers: auth })
    expect(res.status).toBe(503)
  })
})

describe('GET /v1/insights/health', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('shapes the full health object', async () => {
    const reader = new MemoryReader(
      [{ status_family: '2xx', count: '5' }],
      [{ host: 'bad.com', failures: '3' }],
      [{ url: 'http://slow', total_ms: 900 }],
      [{ c: '2' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/health', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.status_families[0]).toEqual({ status_family: '2xx', count: 5 })
    expect(body.data.top_failing_hosts[0]).toEqual({ host: 'bad.com', failures: 3 })
    expect(body.data.slowest[0]).toEqual({ url: 'http://slow', total_ms: 900 })
    expect(body.data.error_count).toBe(2)
  })

  test('503 when the reader throws', async () => {
    const reader = new MemoryReader()
    reader.failQueries()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/health', { headers: auth })
    expect(res.status).toBe(503)
  })
})
