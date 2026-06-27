import { Hono } from 'hono'
import type { QueryReader } from './reader/reader'

export interface AppOptions {
  reader: QueryReader
  token: string
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const ok = await opts.reader.health()
    return c.json({
      status: ok ? 'ok' : 'degraded',
      store: ok ? 'connected' : 'down',
    })
  })

  // Bearer auth for every /v1 route.
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${opts.token}`) return c.body(null, 401)
    await next()
  })

  return app
}
