import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import type { QueryClient } from './query-client'
import { createMcpServer } from './server'

export interface AppOptions {
  client: QueryClient
  token: string
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const ok = await opts.client.ping()
    return c.json({ status: ok ? 'ok' : 'degraded', query: ok ? 'connected' : 'down' })
  })

  app.use('/mcp', async (c, next) => {
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${opts.token}`) return c.body(null, 401)
    await next()
  })

  // Per-request server + transport: no shared state, no id collisions
  // (required by MCP SDK 1.26+; mirrors the monorepo /mcp route).
  app.post('/mcp', async (c) => {
    const server = createMcpServer(opts.client)
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(c)
  })

  return app
}
