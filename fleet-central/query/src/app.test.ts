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
