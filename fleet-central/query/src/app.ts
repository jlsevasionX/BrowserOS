import { Hono } from 'hono'
import {
  buildMcpScopes,
  buildToolStats,
  mapMcpScope,
  mapToolStat,
} from './insights/agent-activity'
import {
  buildNavSeries,
  buildTopHosts,
  mapHostCount,
  mapNavBucket,
  parseBucket,
} from './insights/usage'
import { parseCommonParams } from './params'
import { buildMeta } from './response'
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

  app.get('/v1/insights/agent-activity', async (c) => {
    const started = Date.now()
    const parsed = parseCommonParams(c.req.query())
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const p = parsed.value
    try {
      const tq = buildToolStats(p)
      const mq = buildMcpScopes(p)
      const [toolRows, mcpRows] = await Promise.all([
        opts.reader.query<Record<string, unknown>>(tq.sql, tq.params),
        opts.reader.query<Record<string, unknown>>(mq.sql, mq.params),
      ])
      const data = { tools: toolRows.map(mapToolStat), mcp_scopes: mcpRows.map(mapMcpScope) }
      return c.json({ data, meta: buildMeta(p, toolRows.length, started) })
    } catch {
      return c.json({ error: 'store_unavailable' }, 503)
    }
  })

  app.get('/v1/insights/usage', async (c) => {
    const started = Date.now()
    const parsed = parseCommonParams(c.req.query())
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const p = parsed.value
    const bucket = parseBucket(c.req.query('bucket'))
    try {
      const hq = buildTopHosts(p)
      const nq = buildNavSeries(p, bucket)
      const [hostRows, navRows] = await Promise.all([
        opts.reader.query<Record<string, unknown>>(hq.sql, hq.params),
        opts.reader.query<Record<string, unknown>>(nq.sql, nq.params),
      ])
      const data = {
        top_hosts: hostRows.map(mapHostCount),
        navigations: navRows.map(mapNavBucket),
      }
      return c.json({ data, meta: buildMeta(p, hostRows.length, started) })
    } catch {
      return c.json({ error: 'store_unavailable' }, 503)
    }
  })

  return app
}
