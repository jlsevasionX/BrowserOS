import { Hono } from 'hono'
import type { Envelope } from './envelope'
import { parseLine } from './envelope'
import type { StoreWriter } from './store/store-writer'

export interface AppOptions {
  store: StoreWriter
  token: string
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const ok = await opts.store.health()
    return c.json({ status: ok ? 'ok' : 'degraded', store: ok ? 'connected' : 'down' })
  })

  app.post('/v1/events', async (c) => {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${opts.token}`) return c.body(null, 401)

    const raw = await c.req.text()
    const valid: Envelope[] = []
    let lines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      lines++
      const r = parseLine(line)
      if (r.ok) valid.push(r.value)
    }
    if (lines > 0 && valid.length === 0) return c.body(null, 400)
    if (valid.length > 0) await opts.store.write(valid)
    return c.body(null, 204)
  })

  return app
}
