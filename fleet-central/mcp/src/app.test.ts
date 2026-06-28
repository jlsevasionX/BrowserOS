import { expect, test } from 'bun:test'
import { createApp } from './app'
import { FakeQueryClient } from './query-client'

test('GET /health reports connected when the query service pings ok', async () => {
  const app = createApp({ client: new FakeQueryClient(), token: 'secret' })
  const res = await app.request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok', query: 'connected' })
})

test('POST /mcp without a bearer token is 401', async () => {
  const app = createApp({ client: new FakeQueryClient(), token: 'secret' })
  const res = await app.request('/mcp', { method: 'POST' })
  expect(res.status).toBe(401)
})

test('POST /mcp with a wrong bearer token is 401', async () => {
  const app = createApp({ client: new FakeQueryClient(), token: 'secret' })
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer nope' },
  })
  expect(res.status).toBe(401)
})

test('POST /mcp with the right token reaches the transport (not 401)', async () => {
  const app = createApp({ client: new FakeQueryClient(), token: 'secret' })
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  expect(res.status).not.toBe(401)
})
