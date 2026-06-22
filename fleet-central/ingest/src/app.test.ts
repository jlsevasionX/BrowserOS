import { describe, expect, test } from 'bun:test'
import { createApp } from './app'
import { MemoryStore } from './store/store-writer'

const EVENT = {
  schema_version: 0, event_id: 'e1', ts: 1, install_id: 'i',
  device_id: null, company_id: null, user_id: null, session_id: 's',
  browseros_version: '1', chromium_version: '1', os: 'macos', channel: 'dev',
  tab_id: null, frame_id: null, target_type: null, type: 'navigation', payload: {},
}
const TOKEN = 'secret'

function req(body: string, token = TOKEN): Request {
  return new Request('http://x/v1/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' },
    body,
  })
}

describe('ingest app', () => {
  test('health reports store status', async () => {
    const app = createApp({ store: new MemoryStore(), token: TOKEN })
    const res = await app.request('http://x/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', store: 'connected' })
  })

  test('401 on a bad token', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const res = await app.request(req(`${JSON.stringify(EVENT)}\n`, 'wrong'))
    expect(res.status).toBe(401)
    expect(store.events).toHaveLength(0)
  })

  test('204 and stores valid events', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const body = `${JSON.stringify(EVENT)}\n${JSON.stringify({ ...EVENT, event_id: 'e2' })}\n`
    const res = await app.request(req(body))
    expect(res.status).toBe(204)
    expect(store.events.map((e) => e.event_id)).toEqual(['e1', 'e2'])
  })

  test('partial success: keeps valid lines, ignores garbage, returns 204', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const body = `${JSON.stringify(EVENT)}\nGARBAGE\n`
    const res = await app.request(req(body))
    expect(res.status).toBe(204)
    expect(store.events).toHaveLength(1)
  })

  test('400 when no line is parseable', async () => {
    const store = new MemoryStore()
    const app = createApp({ store, token: TOKEN })
    const res = await app.request(req('garbage\nmore garbage\n'))
    expect(res.status).toBe(400)
    expect(store.events).toHaveLength(0)
  })
})
