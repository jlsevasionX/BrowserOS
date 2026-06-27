import { afterEach, expect, test } from 'bun:test'
import { HttpQueryClient, QueryClientError } from './query-client'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(handler: (url: string, init: RequestInit) => Response): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return { calls }
}

test('usage builds path + querystring + bearer header', async () => {
  const spy = stubFetch(() => new Response(JSON.stringify({ data: { top_hosts: [] }, meta: {} }), { status: 200 }))
  const c = new HttpQueryClient({ baseUrl: 'http://q:9401', token: 'tok' })
  const r = await c.usage({ top: 3, bucket: 'hour', from: '123' })
  expect(spy.calls[0].url).toBe('http://q:9401/v1/insights/usage?top=3&bucket=hour&from=123')
  expect((spy.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  expect(r.data).toEqual({ top_hosts: [] })
})

test('getEvent encodes the id', async () => {
  const spy = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
  const c = new HttpQueryClient({ baseUrl: 'http://q:9401', token: 'tok' })
  await c.getEvent('a/b id')
  expect(spy.calls[0].url).toBe('http://q:9401/v1/events/a%2Fb%20id')
})

test('non-2xx throws QueryClientError with status + sanitized message', async () => {
  stubFetch(() => new Response('invalid `from`', { status: 400 }))
  const c = new HttpQueryClient({ baseUrl: 'http://q:9401', token: 'tok' })
  const err = await c.usage({}).catch((e) => e)
  expect(err).toBeInstanceOf(QueryClientError)
  expect(err.status).toBe(400)
  expect(err.message).toContain('query API returned 400')
  expect(err.message).not.toContain('tok')
})

test('unreachable maps to a clear error', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  const c = new HttpQueryClient({ baseUrl: 'http://q:9401', token: 'tok' })
  const err = await c.meta().catch((e) => e)
  expect(err).toBeInstanceOf(QueryClientError)
  expect(err.status).toBe('unreachable')
  expect(err.message).toBe('telemetry query service unavailable')
})
