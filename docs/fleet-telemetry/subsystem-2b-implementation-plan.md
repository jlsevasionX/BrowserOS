# Subsystem #2b — MCP tool layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `fleet-central/mcp/` — a central MCP service that exposes the #2a Query-API as 6 thin, read-only tools any agent can call to investigate fleet telemetry.

**Architecture:** A stateless Bun + Hono service (sibling to `ingest`/`query`). It is a pure HTTP adapter: MCP tool calls → HTTP GETs against the #2a Query-API (`http://query:9401`, Bearer `QUERY_TOKEN`) → the `{data, meta}` JSON returned verbatim as the tool result. No store, no LLM, no writes. StreamableHTTP transport, bearer-gated with `MCP_TOKEN`, on `:9402`.

**Tech Stack:** Bun, Hono `^4.12.3`, `@modelcontextprotocol/sdk` `^1.27.1`, `@hono/mcp` `^0.2.3`, zod `^3.24.2`, ClickHouse only indirectly (never touched by this service).

**Spec:** `docs/fleet-telemetry/subsystem-2b-mcp-design.md`

## Global Constraints

- `fleet-central/mcp/` is **standalone** — NOT a Bun-workspace member. It mirrors `fleet-central/query/`'s shape and conventions exactly.
- Extensionless TypeScript imports (`./query-client`, not `./query-client.ts`).
- kebab-case filenames. Keep comments minimal (constraints/invariants only).
- Pin deps to the versions already used in the monorepo: `@modelcontextprotocol/sdk@^1.27.1`, `@hono/mcp@^0.2.3`, `hono@^4.12.3`, `zod@^3.24.2`.
- **Pure adapter:** no `@clickhouse/client` dependency, no SQL, no writes. The only outbound calls are HTTP GETs to the Query-API.
- Service port: **9402**. Query-API base default: `http://query:9401`.
- **Commit `bun.lock`** and use `bun install --frozen-lockfile` in the Dockerfile (reproducible builds — the #2a follow-up done right from day one).
- All 6 tools are 1:1 with #2a endpoints, prefixed `fleet_`. No composite tools.
- Tests run with `bun test`; typecheck with `tsc --noEmit`. Both must be green before each commit.
- Run all commands from `fleet-central/mcp/` unless stated otherwise.

---

### Task 1: Scaffold the package + the `QueryClient` HTTP adapter + param serialization

**Files:**
- Create: `fleet-central/mcp/package.json`
- Create: `fleet-central/mcp/tsconfig.json`
- Create: `fleet-central/mcp/src/params.ts`
- Create: `fleet-central/mcp/src/query-client.ts`
- Test: `fleet-central/mcp/src/params.test.ts`
- Test: `fleet-central/mcp/src/query-client.test.ts`

**Interfaces:**
- Produces:
  - `buildQuery(args: Record<string, unknown>): string` — serializes defined args to `?k=v&...` (empty string when none).
  - `interface QueryResult { data: unknown; meta?: unknown }`
  - `class QueryClientError extends Error { status: number | 'unreachable' }`
  - `interface QueryClient` with methods `meta()`, `usage(args)`, `agentActivity(args)`, `health(args)`, `searchEvents(args)`, `getEvent(id: string)` — all `=> Promise<QueryResult>` — plus `ping(): Promise<boolean>`.
  - `class HttpQueryClient implements QueryClient` (ctor `{ baseUrl: string; token: string; timeoutMs?: number }`).
  - `class FakeQueryClient implements QueryClient` (test double: `queue(r)`, `fail(e)`, `calls`).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fleet-mcp",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "start": "bun src/index.ts"
  },
  "dependencies": {
    "@hono/mcp": "^0.2.3",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "hono": "^4.12.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (identical to `query/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install deps (creates `bun.lock`)**

Run: `cd fleet-central/mcp && bun install`
Expected: dependencies resolved; `bun.lock` created.

- [ ] **Step 4: Write the failing param test** — `src/params.test.ts`

```ts
import { expect, test } from 'bun:test'
import { buildQuery } from './params'

test('omits undefined/null/empty and prefixes with ?', () => {
  expect(buildQuery({ top: 3, bucket: 'hour', host: undefined, q: '' })).toBe('?top=3&bucket=hour')
})

test('returns empty string when nothing to serialize', () => {
  expect(buildQuery({})).toBe('')
  expect(buildQuery({ a: undefined })).toBe('')
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `bun test src/params.test.ts`
Expected: FAIL — `Cannot find module './params'`.

- [ ] **Step 6: Implement `src/params.ts`**

```ts
/** Serializes defined args to a `?k=v&...` querystring. Skips undefined/null/''. */
export function buildQuery(args: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
```

- [ ] **Step 7: Run the param test — expect PASS**

Run: `bun test src/params.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Write the failing query-client test** — `src/query-client.test.ts`

```ts
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
  }) as typeof fetch
  const c = new HttpQueryClient({ baseUrl: 'http://q:9401', token: 'tok' })
  const err = await c.meta().catch((e) => e)
  expect(err).toBeInstanceOf(QueryClientError)
  expect(err.status).toBe('unreachable')
  expect(err.message).toBe('telemetry query service unavailable')
})
```

- [ ] **Step 9: Run it to verify it fails**

Run: `bun test src/query-client.test.ts`
Expected: FAIL — `Cannot find module './query-client'`.

- [ ] **Step 10: Implement `src/query-client.ts`**

```ts
import { buildQuery } from './params'

export interface QueryResult {
  data: unknown
  meta?: unknown
}

export class QueryClientError extends Error {
  constructor(
    readonly status: number | 'unreachable',
    message: string,
  ) {
    super(message)
    this.name = 'QueryClientError'
  }
}

/** Read-only access to the #2a Query-API. `health()` is the insight; `ping()` is liveness. */
export interface QueryClient {
  meta(): Promise<QueryResult>
  usage(args: Record<string, unknown>): Promise<QueryResult>
  agentActivity(args: Record<string, unknown>): Promise<QueryResult>
  health(args: Record<string, unknown>): Promise<QueryResult>
  searchEvents(args: Record<string, unknown>): Promise<QueryResult>
  getEvent(id: string): Promise<QueryResult>
  ping(): Promise<boolean>
}

export interface HttpQueryClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
}

export class HttpQueryClient implements QueryClient {
  constructor(private readonly opts: HttpQueryClientOptions) {}

  private async get(path: string): Promise<QueryResult> {
    let res: Response
    try {
      res = await fetch(`${this.opts.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      })
    } catch {
      throw new QueryClientError('unreachable', 'telemetry query service unavailable')
    }
    const text = await res.text()
    if (!res.ok) {
      throw new QueryClientError(res.status, `query API returned ${res.status}: ${text}`)
    }
    return JSON.parse(text) as QueryResult
  }

  meta(): Promise<QueryResult> {
    return this.get('/v1/meta')
  }
  usage(args: Record<string, unknown>): Promise<QueryResult> {
    return this.get(`/v1/insights/usage${buildQuery(args)}`)
  }
  agentActivity(args: Record<string, unknown>): Promise<QueryResult> {
    return this.get(`/v1/insights/agent-activity${buildQuery(args)}`)
  }
  health(args: Record<string, unknown>): Promise<QueryResult> {
    return this.get(`/v1/insights/health${buildQuery(args)}`)
  }
  searchEvents(args: Record<string, unknown>): Promise<QueryResult> {
    return this.get(`/v1/events${buildQuery(args)}`)
  }
  getEvent(id: string): Promise<QueryResult> {
    return this.get(`/v1/events/${encodeURIComponent(id)}`)
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

/** In-memory test double. Queues one result per call; records calls. */
export class FakeQueryClient implements QueryClient {
  readonly calls: Array<{ method: string; arg: unknown }> = []
  private readonly results: QueryResult[] = []
  private err?: Error

  queue(r: QueryResult): void {
    this.results.push(r)
  }
  fail(e: Error): void {
    this.err = e
  }
  private next(method: string, arg: unknown): Promise<QueryResult> {
    this.calls.push({ method, arg })
    if (this.err) return Promise.reject(this.err)
    return Promise.resolve(this.results.shift() ?? { data: null })
  }
  meta() {
    return this.next('meta', undefined)
  }
  usage(a: Record<string, unknown>) {
    return this.next('usage', a)
  }
  agentActivity(a: Record<string, unknown>) {
    return this.next('agentActivity', a)
  }
  health(a: Record<string, unknown>) {
    return this.next('health', a)
  }
  searchEvents(a: Record<string, unknown>) {
    return this.next('searchEvents', a)
  }
  getEvent(id: string) {
    return this.next('getEvent', id)
  }
  ping() {
    return Promise.resolve(true)
  }
}
```

- [ ] **Step 11: Run the query-client test — expect PASS**

Run: `bun test src/query-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 12: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
cd ../..   # back to repo root (BrowserOS/)
git add fleet-central/mcp/package.json fleet-central/mcp/tsconfig.json fleet-central/mcp/bun.lock \
  fleet-central/mcp/src/params.ts fleet-central/mcp/src/params.test.ts \
  fleet-central/mcp/src/query-client.ts fleet-central/mcp/src/query-client.test.ts
git commit -m "feat(fleet-mcp): scaffold package + QueryClient HTTP adapter"
```

---

### Task 2: The 6-tool registry

**Files:**
- Create: `fleet-central/mcp/src/tools.ts`
- Test: `fleet-central/mcp/src/tools.test.ts`

**Interfaces:**
- Consumes: `QueryClient`, `QueryResult` from `./query-client`.
- Produces:
  - `interface ToolDef { name: string; description: string; inputSchema: ZodRawShape; handler: (client: QueryClient, args: Record<string, unknown>) => Promise<QueryResult> }`
  - `const TOOLS: ToolDef[]` — exactly the 6 tools, names: `fleet_meta`, `fleet_usage`, `fleet_agent_activity`, `fleet_health`, `fleet_search_events`, `fleet_get_event`.

- [ ] **Step 1: Write the failing test** — `src/tools.test.ts`

```ts
import { expect, test } from 'bun:test'
import { FakeQueryClient } from './query-client'
import { TOOLS } from './tools'

test('exposes exactly the six fleet_ tools', () => {
  expect(TOOLS.map((t) => t.name).sort()).toEqual([
    'fleet_agent_activity',
    'fleet_get_event',
    'fleet_health',
    'fleet_meta',
    'fleet_search_events',
    'fleet_usage',
  ])
  for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(10)
})

test('usage handler calls client.usage with passed args', async () => {
  const fake = new FakeQueryClient()
  fake.queue({ data: { top_hosts: [{ host: 'a' }] } })
  const usage = TOOLS.find((t) => t.name === 'fleet_usage')!
  const r = await usage.handler(fake, { top: 5, bucket: 'day' })
  expect(fake.calls[0]).toEqual({ method: 'usage', arg: { top: 5, bucket: 'day' } })
  expect(r.data).toEqual({ top_hosts: [{ host: 'a' }] })
})

test('get_event handler forwards the id', async () => {
  const fake = new FakeQueryClient()
  fake.queue({ data: { event_id: 'x' } })
  const get = TOOLS.find((t) => t.name === 'fleet_get_event')!
  await get.handler(fake, { id: 'x' })
  expect(fake.calls[0]).toEqual({ method: 'getEvent', arg: 'x' })
})

test('meta handler takes no params', async () => {
  const fake = new FakeQueryClient()
  fake.queue({ data: { types: [] } })
  const meta = TOOLS.find((t) => t.name === 'fleet_meta')!
  await meta.handler(fake, {})
  expect(fake.calls[0]).toEqual({ method: 'meta', arg: undefined })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/tools.test.ts`
Expected: FAIL — `Cannot find module './tools'`.

- [ ] **Step 3: Implement `src/tools.ts`**

```ts
import { type ZodRawShape, z } from 'zod'
import type { QueryClient, QueryResult } from './query-client'

export interface ToolDef {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: (client: QueryClient, args: Record<string, unknown>) => Promise<QueryResult>
}

// Common filters shared by every tool except fleet_get_event. Mirrors the #2a
// contract: ISO or epoch-ms times (default last 24h), exact-match facets, paging.
const common: ZodRawShape = {
  from: z.string().optional().describe('Start time (ISO-8601 or epoch-ms). Default: 24h ago.'),
  to: z.string().optional().describe('End time (ISO-8601 or epoch-ms). Default: now.'),
  device_id: z.string().optional(),
  session_id: z.string().optional(),
  install_id: z.string().optional(),
  channel: z.string().optional(),
  os: z.string().optional(),
  limit: z.number().int().optional().describe('Max rows (<=1000).'),
  offset: z.number().int().optional(),
}

export const TOOLS: ToolDef[] = [
  {
    name: 'fleet_meta',
    description:
      'Start here. Returns the available event types (+counts), device ids, channels, oses, and the captured time range. Use it to discover what to query before calling the other tools.',
    inputSchema: {},
    handler: (c) => c.meta(),
  },
  {
    name: 'fleet_usage',
    description:
      'Fleet usage: the most-visited hosts and a navigation time series. Use to answer "what is used most" / "how much browsing over time".',
    inputSchema: {
      ...common,
      top: z.number().int().optional().describe('How many top hosts to return.'),
      bucket: z.enum(['hour', 'day']).optional().describe('Time-series bucket. Default: hour.'),
    },
    handler: (c, a) => c.usage(a),
  },
  {
    name: 'fleet_agent_activity',
    description:
      'Agent tool activity: per-tool execution counts, error rate, p50/p95 latency, plus MCP scope request counts. Use to answer "which agent tool fails most / is slowest".',
    inputSchema: { ...common },
    handler: (c, a) => c.agentActivity(a),
  },
  {
    name: 'fleet_health',
    description:
      'Network health: HTTP status families (2xx..5xx/failed), top failing hosts, slowest requests, and total error count. Use to answer "what is failing / slow".',
    inputSchema: { ...common },
    handler: (c, a) => c.health(a),
  },
  {
    name: 'fleet_search_events',
    description:
      'Raw event search across the captured telemetry. Filter by type/host and a free-text query; supports paging. Use to drill into specific events.',
    inputSchema: {
      ...common,
      type: z.string().optional().describe('Event type, e.g. network.request, navigation, agent.action.'),
      host: z.string().optional(),
      q: z.string().optional().describe('Free-text match (e.g. a URL fragment).'),
    },
    handler: (c, a) => c.searchEvents(a),
  },
  {
    name: 'fleet_get_event',
    description: 'Fetch the full detail of a single event by its event_id (from fleet_search_events).',
    inputSchema: { id: z.string().describe('The event_id to fetch.') },
    handler: (c, a) => c.getEvent(String(a.id)),
  },
]
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test src/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
cd ../..
git add fleet-central/mcp/src/tools.ts fleet-central/mcp/src/tools.test.ts
git commit -m "feat(fleet-mcp): the six 1:1 query tools"
```

---

### Task 3: MCP server factory + in-memory integration test

**Files:**
- Create: `fleet-central/mcp/src/server.ts`
- Test: `fleet-central/mcp/src/server.test.ts`

**Interfaces:**
- Consumes: `TOOLS` from `./tools`; `QueryClient`, `QueryClientError`, `FakeQueryClient` from `./query-client`.
- Produces: `createMcpServer(client: QueryClient): McpServer` — registers all `TOOLS`; each tool result is returned as `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`; a thrown error becomes `{ content: [{ type: 'text', text: message }], isError: true }`.

- [ ] **Step 1: Write the failing test** — `src/server.test.ts`

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, test } from 'bun:test'
import { FakeQueryClient, QueryClientError } from './query-client'
import { createMcpServer } from './server'

async function connect(fake: FakeQueryClient) {
  const server = createMcpServer(fake)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

test('lists all six tools over a real MCP session', async () => {
  const client = await connect(new FakeQueryClient())
  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name).sort()).toEqual([
    'fleet_agent_activity',
    'fleet_get_event',
    'fleet_health',
    'fleet_meta',
    'fleet_search_events',
    'fleet_usage',
  ])
})

test('calling a tool returns the query JSON as text content', async () => {
  const fake = new FakeQueryClient()
  fake.queue({ data: { types: [{ type: 'navigation', count: 3 }] } })
  const client = await connect(fake)
  const res = await client.callTool({ name: 'fleet_meta', arguments: {} })
  const text = (res.content as Array<{ type: string; text: string }>)[0].text
  expect(JSON.parse(text)).toEqual({ data: { types: [{ type: 'navigation', count: 3 }] } })
  expect(res.isError).toBeFalsy()
})

test('a QueryClientError becomes an isError tool result', async () => {
  const fake = new FakeQueryClient()
  fake.fail(new QueryClientError('unreachable', 'telemetry query service unavailable'))
  const client = await connect(fake)
  const res = await client.callTool({ name: 'fleet_usage', arguments: {} })
  expect(res.isError).toBe(true)
  const text = (res.content as Array<{ type: string; text: string }>)[0].text
  expect(text).toBe('telemetry query service unavailable')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/server.test.ts`
Expected: FAIL — `Cannot find module './server'`.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { QueryClient } from './query-client'
import { TOOLS } from './tools'

const INSTRUCTIONS =
  'Read-only access to fleet telemetry. Call fleet_meta first to discover what is available, ' +
  'then use the insight tools (fleet_usage, fleet_agent_activity, fleet_health) and ' +
  'fleet_search_events / fleet_get_event to drill in. All times default to the last 24h.'

export function createMcpServer(client: QueryClient): McpServer {
  const server = new McpServer(
    { name: 'fleet_mcp', title: 'Fleet telemetry MCP server', version: '0.0.1' },
    { instructions: INSTRUCTIONS },
  )

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(client, args ?? {})
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          return { content: [{ type: 'text' as const, text }], isError: true }
        }
      },
    )
  }

  return server
}
```

> Note: `server.registerTool` with `inputSchema` as a `ZodRawShape` makes the SDK validate
> client args before the handler runs (bad params → SDK error to the client, handler not called).

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test src/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all green (params + query-client + tools + server).

- [ ] **Step 6: Commit**

```bash
cd ../..
git add fleet-central/mcp/src/server.ts fleet-central/mcp/src/server.test.ts
git commit -m "feat(fleet-mcp): MCP server factory registering the tools"
```

---

### Task 4: HTTP app — `/health`, bearer-gated `/mcp` StreamableHTTP mount

**Files:**
- Create: `fleet-central/mcp/src/app.ts`
- Test: `fleet-central/mcp/src/app.test.ts`

**Interfaces:**
- Consumes: `createMcpServer` from `./server`; `QueryClient`, `FakeQueryClient` from `./query-client`.
- Produces: `createApp(opts: { client: QueryClient; token: string }): Hono` — `GET /health` (unauthenticated, probes `client.ping()`), `POST /mcp` (Bearer `token`, mounts a per-request `StreamableHTTPTransport`).

- [ ] **Step 1: Write the failing test** — `src/app.test.ts`

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/app.test.ts`
Expected: FAIL — `Cannot find module './app'`.

- [ ] **Step 3: Implement `src/app.ts`**

```ts
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
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test src/app.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add fleet-central/mcp/src/app.ts fleet-central/mcp/src/app.test.ts
git commit -m "feat(fleet-mcp): HTTP app with /health + bearer-gated /mcp"
```

---

### Task 5: Startup entrypoint, Docker, compose wiring, env, E2E smoke

**Files:**
- Create: `fleet-central/mcp/src/index.ts`
- Create: `fleet-central/mcp/Dockerfile`
- Create: `fleet-central/mcp/.dockerignore`
- Modify: `fleet-central/docker-compose.yml`
- Modify: `fleet-central/.env.example`

**Interfaces:**
- Consumes: `createApp` from `./app`; `HttpQueryClient` from `./query-client`.
- Produces: a runnable service on `:9402`; a `mcp` compose service depending on a healthy `query`.

- [ ] **Step 1: Implement `src/index.ts`** (mirrors `query/src/index.ts`)

```ts
import { createApp } from './app'
import { HttpQueryClient } from './query-client'

const port = Number(process.env.MCP_PORT ?? 9402)
const token = process.env.MCP_TOKEN
if (!token) {
  console.error('MCP_TOKEN is required')
  process.exit(1)
}
const queryToken = process.env.QUERY_TOKEN
if (!queryToken) {
  console.error('QUERY_TOKEN is required')
  process.exit(1)
}

const client = new HttpQueryClient({
  baseUrl: process.env.QUERY_BASE_URL ?? 'http://query:9401',
  token: queryToken,
})

const app = createApp({ client, token })
console.log(`fleet-mcp listening on :${port}`)
export default { port, fetch: app.fetch }
```

- [ ] **Step 2: Verify startup env-guard works**

Run: `cd fleet-central/mcp && MCP_TOKEN= QUERY_TOKEN=x bun src/index.ts`
Expected: prints `MCP_TOKEN is required`, exits non-zero.

Run: `MCP_TOKEN=t QUERY_TOKEN=q MCP_PORT=9402 bun src/index.ts`
Expected: prints `fleet-mcp listening on :9402` (Ctrl-C to stop).

- [ ] **Step 3: Create `.dockerignore`** (identical to `query/.dockerignore`)

```
node_modules
*.test.ts
```

- [ ] **Step 4: Create `Dockerfile`** (mirrors `query/Dockerfile`; frozen lockfile + 9402)

```dockerfile
FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 9402
CMD ["bun", "src/index.ts"]
```

- [ ] **Step 5: Add the `mcp` service to `fleet-central/docker-compose.yml`**

Insert after the `query:` service block (before the `volumes:` key):

```yaml
  mcp:
    build: ./mcp
    restart: unless-stopped
    depends_on:
      query:
        condition: service_started
    environment:
      MCP_PORT: 9402
      MCP_TOKEN: ${MCP_TOKEN:?set MCP_TOKEN in .env}
      QUERY_BASE_URL: http://query:9401
      QUERY_TOKEN: ${QUERY_TOKEN:?set QUERY_TOKEN in .env}
    ports:
      - "${MCP_PORT:-9402}:9402"
```

- [ ] **Step 6: Add env to `fleet-central/.env.example`**

Append:

```
# MCP tool layer (agentic access to the Query-API)
MCP_TOKEN=change-me-mcp
MCP_PORT=9402
```

- [ ] **Step 7: Build the image**

Run: `cd fleet-central && docker compose build mcp`
Expected: build succeeds (`bun install --frozen-lockfile` resolves from the committed `bun.lock`).

- [ ] **Step 8: Bring up the full stack**

Run: `cd fleet-central && docker compose up -d --build`
Expected: clickhouse healthy, ingest/query/mcp `Up`.

- [ ] **Step 9: Smoke `/health` + bearer**

```bash
cd fleet-central
T=$(grep '^MCP_TOKEN=' .env | cut -d= -f2)
curl -s localhost:9402/health                                   # {"status":"ok","query":"connected"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:9402/mcp   # 401
curl -s -X POST localhost:9402/mcp \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400   # lists the 6 fleet_ tools
```
Expected: health ok; bare POST → 401; authed `tools/list` returns the 6 tools.

- [ ] **Step 10: E2E via Claude Code (acceptance)**

Add the server to Claude Code as an HTTP MCP server (`http://localhost:9402/mcp`, header
`Authorization: Bearer <MCP_TOKEN>`), then ask a real fleet question against the live
sample, e.g. *"using the fleet tools, which hosts are used most and which agent tool fails
most?"*. Expected: the agent calls `fleet_meta` → `fleet_usage` / `fleet_agent_activity`
and answers from the ~948-row sample. (If the Chrome extension/agent isn't connected, the
authed `tools/list` + a manual `tools/call` curl from Step 9 is the fallback acceptance.)

- [ ] **Step 11: Final commit**

```bash
cd ..   # repo root (BrowserOS/)
git add fleet-central/mcp/src/index.ts fleet-central/mcp/Dockerfile fleet-central/mcp/.dockerignore \
  fleet-central/docker-compose.yml fleet-central/.env.example
git commit -m "feat(fleet-mcp): entrypoint, Docker, compose service, env"
```

---

## Self-Review

**Spec coverage:**
- §2 architecture (pure HTTP adapter, two-secret two-hop) → Tasks 1, 4, 5. ✓
- §3 tool surface (6 tools, common params, rich descriptions, no composites) → Task 2. ✓
- §4 components (index/app/query-client/tools/server; `params.ts` folded into Task 1) → Tasks 1–5. ✓
- §5 data flow & error handling (401, zod validation by SDK, sanitized upstream errors, unreachable, `/health`) → Tasks 1 (errors), 3 (isError mapping), 4 (401 + health). ✓
- §6 testing (unit per tool, query-client w/ mocked fetch, app 401, MCP integration) → Tasks 1–4. ✓
- §7 deployment & config (compose service, env, `bun.lock` + `--frozen-lockfile`) → Tasks 1 (lockfile) + 5. ✓
- §8 acceptance (E2E via Claude Code) → Task 5 Step 10. ✓
- §9 non-goals — nothing in the plan adds a store/LLM/writes/composites. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `QueryClient` method set (`meta/usage/agentActivity/health/searchEvents/getEvent/ping`) is identical across `query-client.ts`, `FakeQueryClient`, `tools.ts` handlers, and the tests. `QueryResult`/`QueryClientError`/`ToolDef` names match across tasks. Tool names match between `tools.ts`, `tools.test.ts`, and `server.test.ts`.

**Note on `health`:** the `QueryClient.health(args)` method maps to `/v1/insights/health` (the insight); service liveness is the separate `ping()`. Intentional, documented in `query-client.ts`.
