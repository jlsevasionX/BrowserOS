import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import {
  buildMcpScopes,
  buildToolStats,
  mapMcpScope,
  mapToolStat,
} from './insights/agent-activity'
import {
  buildErrorCount,
  buildSlowest,
  buildStatusFamilies,
  buildTopFailingHosts,
  mapErrorCount,
  mapFailingHost,
  mapSlowRequest,
  mapStatusFamily,
} from './insights/health'
import {
  buildNavSeries,
  buildTopHosts,
  mapHostCount,
  mapNavBucket,
  parseBucket,
} from './insights/usage'
import {
  buildEventById,
  buildEventSearch,
  buildMetaFacets,
  mapEventRow,
  mapFullEvent,
} from './insights/search'
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

  app.get('/v1/insights/health', async (c) => {
    const started = Date.now()
    const parsed = parseCommonParams(c.req.query())
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const p = parsed.value
    try {
      const sf = buildStatusFamilies(p)
      const fh = buildTopFailingHosts(p)
      const sl = buildSlowest(p)
      const ec = buildErrorCount(p)
      const [sfRows, fhRows, slRows, ecRows] = await Promise.all([
        opts.reader.query<Record<string, unknown>>(sf.sql, sf.params),
        opts.reader.query<Record<string, unknown>>(fh.sql, fh.params),
        opts.reader.query<Record<string, unknown>>(sl.sql, sl.params),
        opts.reader.query<Record<string, unknown>>(ec.sql, ec.params),
      ])
      const data = {
        status_families: sfRows.map(mapStatusFamily),
        top_failing_hosts: fhRows.map(mapFailingHost),
        slowest: slRows.map(mapSlowRequest),
        error_count: mapErrorCount(ecRows),
      }
      return c.json({ data, meta: buildMeta(p, sfRows.length, started) })
    } catch {
      return c.json({ error: 'store_unavailable' }, 503)
    }
  })

  app.get('/v1/events', async (c) => {
    const started = Date.now()
    const parsed = parseCommonParams(c.req.query())
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const p = parsed.value
    try {
      const q = buildEventSearch(p, {
        type: c.req.query('type'),
        host: c.req.query('host'),
        q: c.req.query('q'),
      })
      const rows = await opts.reader.query<Record<string, unknown>>(q.sql, q.params)
      return c.json({ data: rows.map(mapEventRow), meta: buildMeta(p, rows.length, started) })
    } catch {
      return c.json({ error: 'store_unavailable' }, 503)
    }
  })

  app.get('/v1/events/:event_id', async (c) => {
    try {
      const q = buildEventById(c.req.param('event_id'))
      const rows = await opts.reader.query<Record<string, unknown>>(q.sql, q.params)
      if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
      return c.json({ data: mapFullEvent(rows[0]) })
    } catch {
      return c.json({ error: 'store_unavailable' }, 503)
    }
  })

  app.get('/v1/meta', async (c) => {
    try {
      const f = buildMetaFacets()
      const [types, devices, channels, oses, range] = await Promise.all([
        opts.reader.query<Record<string, unknown>>(f.types.sql, f.types.params),
        opts.reader.query<Record<string, unknown>>(f.devices.sql, f.devices.params),
        opts.reader.query<Record<string, unknown>>(f.channels.sql, f.channels.params),
        opts.reader.query<Record<string, unknown>>(f.oses.sql, f.oses.params),
        opts.reader.query<Record<string, unknown>>(f.range.sql, f.range.params),
      ])
      return c.json({
        data: {
          types: types.map((r) => ({ type: String(r.type), count: Number(r.count) })),
          devices: devices.map((r) => String(r.device_id)),
          channels: channels.map((r) => String(r.channel)),
          oses: oses.map((r) => String(r.os)),
          range: range.length
            ? { from: Number(range[0].min_ts), to: Number(range[0].max_ts) }
            : { from: null, to: null },
        },
      })
    } catch {
      return c.json({ error: 'store_unavailable' }, 503)
    }
  })

  app.use('/*', serveStatic({ root: './public' }))

  return app
}
