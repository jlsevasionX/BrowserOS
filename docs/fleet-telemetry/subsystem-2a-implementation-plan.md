# Subsystem #2a — Query-API core + human UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only `query` service over ClickHouse `fleet.events` plus a minimal static dashboard, so a human can see fleet usage / agent activity / health and explore raw events.

**Architecture:** New `fleet-central/query/` Bun+Hono service, sibling to the existing `ingest` service and read-only. Fixed parameterized insight endpoints + a raw-search endpoint feed a static (no-build) dashboard served from the same service. All SQL is composed server-side; user values are passed only as ClickHouse `query_params`. A `QueryReader` seam (mirror of the ingest `StoreWriter`) keeps insights testable in-memory without Docker.

**Tech Stack:** Bun, Hono, `@clickhouse/client`, zod, `bun:test`. UI = vanilla JS + uPlot (vendored). Docker Compose for deploy.

**Spec:** `docs/fleet-telemetry/subsystem-2a-query-ui-design.md`.

## Global Constraints

- Runtime: **Bun** (mirror `fleet-central/ingest`); `tsc --noEmit` must pass with the same `tsconfig.json` shape (`strict`, `moduleResolution: bundler`, `types: ["bun"]`).
- Service is **strictly read-only** — it never INSERTs/writes to ClickHouse.
- All ClickHouse reads use **`FROM fleet.events FINAL`** (correct dedup over `ReplacingMergeTree`).
- User-supplied values go ONLY through `@clickhouse/client` `query_params` (`{name:Type}` bindings) — never string-interpolated into SQL.
- Time filters are bound as `Int64` epoch-ms and converted in SQL with `fromUnixTimestamp64Milli(...)`.
- Auth: `Authorization: Bearer <QUERY_TOKEN>` on every `/v1/*` route → `401` on mismatch (same shape as `ingest/src/app.ts`). `QUERY_TOKEN` is required at startup; the process exits if unset.
- Port: `QUERY_PORT` default **9401** (ingest is 9400).
- No external network egress from the UI — chart lib (uPlot) is **vendored** under `public/vendor/`, no CDN.
- Defaults: time range = last 24h; `limit` default 100, max 1000.
- Commit identity already configured in the repo; conventional-commit messages (a `commit-msg` hook enforces this).

---

### Task 1: Service skeleton + `QueryReader` seam + `/health` + auth

**Files:**
- Create: `fleet-central/query/package.json`
- Create: `fleet-central/query/tsconfig.json`
- Create: `fleet-central/query/src/reader/reader.ts`
- Create: `fleet-central/query/src/app.ts`
- Create: `fleet-central/query/src/index.ts`
- Test: `fleet-central/query/src/app.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface QueryReader { query<T = Record<string, unknown>>(sql: string, params: Record<string, unknown>): Promise<T[]>; health(): Promise<boolean>; close(): Promise<void> }` (in `reader/reader.ts`)
  - `class MemoryReader implements QueryReader` — constructor `(...results: unknown[][])` queues one result array per `query()` call (falls back to `[]`); records `calls: Array<{sql,params}>`; `failQueries()` makes `query()` throw and `health()` return false; `setUnhealthy()` makes only `health()` return false.
  - `function createApp(opts: { reader: QueryReader; token: string }): Hono` (in `app.ts`)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fleet-query",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "start": "bun src/index.ts"
  },
  "dependencies": {
    "@clickhouse/client": "^1.7.0",
    "hono": "^4.12.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (identical to `ingest/tsconfig.json`)

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

- [ ] **Step 3: Install deps**

Run: `cd fleet-central/query && bun install`
Expected: creates `bun.lock` and `node_modules`, exits 0.

- [ ] **Step 4: Write the reader seam**

`fleet-central/query/src/reader/reader.ts`:
```ts
/** Read-only access to the central store. ClickHouse today; swappable later. */
export interface QueryReader {
  query<T = Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]>
  health(): Promise<boolean>
  close(): Promise<void>
}

/** In-memory reader for unit tests (no Docker). One queued result per query() call. */
export class MemoryReader implements QueryReader {
  readonly calls: Array<{ sql: string; params: Record<string, unknown> }> = []
  private readonly queue: unknown[][]
  private throwOnQuery = false
  private healthy = true

  constructor(...results: unknown[][]) {
    this.queue = results
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    this.calls.push({ sql, params })
    if (this.throwOnQuery) throw new Error('reader down')
    return (this.queue.shift() ?? []) as T[]
  }

  async health(): Promise<boolean> {
    return !this.throwOnQuery && this.healthy
  }

  async close(): Promise<void> {}

  failQueries(): void {
    this.throwOnQuery = true
  }

  setUnhealthy(): void {
    this.healthy = false
  }
}
```

- [ ] **Step 5: Write the failing app test**

`fleet-central/query/src/app.test.ts`:
```ts
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
```

- [ ] **Step 6: Run the test, verify it fails**

Run: `cd fleet-central/query && bun test src/app.test.ts`
Expected: FAIL — `createApp` not found / module `./app` missing.

- [ ] **Step 7: Write `app.ts`** (minimal: health + auth middleware; `/v1/meta` returns 404 for now so the 401 test exercises only auth)

`fleet-central/query/src/app.ts`:
```ts
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
```

- [ ] **Step 8: Write `index.ts`**

`fleet-central/query/src/index.ts`:
```ts
import { createApp } from './app'
import { ClickHouseReader } from './reader/clickhouse-reader'

const port = Number(process.env.QUERY_PORT ?? 9401)
const token = process.env.QUERY_TOKEN
if (!token) {
  console.error('QUERY_TOKEN is required')
  process.exit(1)
}

const reader = new ClickHouseReader({
  url: process.env.CLICKHOUSE_URL ?? 'http://clickhouse:8123',
  database: process.env.CLICKHOUSE_DB ?? 'fleet',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
})

const app = createApp({ reader, token })
console.log(`fleet-query listening on :${port}`)
export default { port, fetch: app.fetch }
```

> Note: `index.ts` imports `ClickHouseReader`, created in Task 7. Until then, run/typecheck against `app.test.ts` only (the test uses `MemoryReader`). Do NOT `bun run start` until Task 7 lands.

- [ ] **Step 9: Run the test, verify it passes**

Run: `cd fleet-central/query && bun test src/app.test.ts`
Expected: PASS (3 tests). `/v1/meta` returns 401 with a bad token because the auth middleware runs before any (missing) route handler.

- [ ] **Step 10: Commit**

```bash
git add fleet-central/query/package.json fleet-central/query/tsconfig.json \
  fleet-central/query/bun.lock fleet-central/query/src/reader/reader.ts \
  fleet-central/query/src/app.ts fleet-central/query/src/index.ts \
  fleet-central/query/src/app.test.ts
git commit -m "feat(fleet-query): service skeleton + QueryReader seam + health/auth"
```

---

### Task 2: Common query params + shared SQL filter

**Files:**
- Create: `fleet-central/query/src/params.ts`
- Create: `fleet-central/query/src/sql.ts`
- Test: `fleet-central/query/src/params.test.ts`
- Test: `fleet-central/query/src/sql.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface QueryParams { from: number; to: number; device_id?: string; session_id?: string; install_id?: string; channel?: string; os?: string; limit: number; offset: number }`
  - `function parseCommonParams(q: Record<string, string | undefined>): { ok: true; value: QueryParams } | { ok: false; error: string }` (in `params.ts`)
  - `function commonFilter(p: QueryParams): { sql: string; params: Record<string, unknown> }` — returns the shared `AND ...` WHERE fragment (time range + optional exact filters) and the bound params (in `sql.ts`).

- [ ] **Step 1: Write the failing `params.test.ts`**

`fleet-central/query/src/params.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from './params'

describe('parseCommonParams', () => {
  test('defaults: last 24h, limit 100, offset 0', () => {
    const r = parseCommonParams({})
    if (!r.ok) throw new Error(r.error)
    expect(r.value.limit).toBe(100)
    expect(r.value.offset).toBe(0)
    expect(r.value.to - r.value.from).toBe(86_400_000)
  })

  test('parses epoch-ms strings', () => {
    const r = parseCommonParams({ from: '1700000000000', to: '1700086400000' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.from).toBe(1_700_000_000_000)
    expect(r.value.to).toBe(1_700_086_400_000)
  })

  test('parses ISO timestamps', () => {
    const r = parseCommonParams({ from: '2023-11-14T22:13:20.000Z' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.from).toBe(1_700_000_000_000)
  })

  test('clamps limit to 1000 max', () => {
    const r = parseCommonParams({ limit: '99999' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.limit).toBe(1000)
  })

  test('passes through optional exact filters', () => {
    const r = parseCommonParams({ device_id: 'd1', channel: 'prod', os: 'macos' })
    if (!r.ok) throw new Error(r.error)
    expect(r.value.device_id).toBe('d1')
    expect(r.value.channel).toBe('prod')
    expect(r.value.os).toBe('macos')
  })

  test('rejects non-numeric/non-ISO time', () => {
    const r = parseCommonParams({ from: 'banana' })
    expect(r.ok).toBe(false)
  })

  test('rejects from > to', () => {
    const r = parseCommonParams({ from: '2000', to: '1000' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd fleet-central/query && bun test src/params.test.ts`
Expected: FAIL — module `./params` missing.

- [ ] **Step 3: Write `params.ts`**

`fleet-central/query/src/params.ts`:
```ts
export interface QueryParams {
  from: number // epoch ms
  to: number // epoch ms
  device_id?: string
  session_id?: string
  install_id?: string
  channel?: string
  os?: string
  limit: number
  offset: number
}

const DAY_MS = 86_400_000
const MAX_LIMIT = 1000

/** Accepts epoch-ms (digits) or an ISO-8601 string. Returns epoch ms or null. */
function parseTime(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null
  if (/^\d+$/.test(v.trim())) return Number(v.trim())
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v.trim() === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function parseCommonParams(
  q: Record<string, string | undefined>,
): { ok: true; value: QueryParams } | { ok: false; error: string } {
  const now = Date.now()
  const toRaw = q.to
  const fromRaw = q.from

  const to = toRaw === undefined ? now : parseTime(toRaw)
  if (to === null) return { ok: false, error: 'invalid `to`' }
  const from = fromRaw === undefined ? to - DAY_MS : parseTime(fromRaw)
  if (from === null) return { ok: false, error: 'invalid `from`' }
  if (from > to) return { ok: false, error: '`from` must be <= `to`' }

  const opt = (k: string): string | undefined => {
    const v = q[k]
    return v === undefined || v.trim() === '' ? undefined : v
  }

  return {
    ok: true,
    value: {
      from,
      to,
      device_id: opt('device_id'),
      session_id: opt('session_id'),
      install_id: opt('install_id'),
      channel: opt('channel'),
      os: opt('os'),
      limit: clampInt(q.limit, 100, 1, MAX_LIMIT),
      offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    },
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd fleet-central/query && bun test src/params.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing `sql.test.ts`**

`fleet-central/query/src/sql.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from './params'
import { commonFilter } from './sql'

function params(over: Record<string, string> = {}) {
  const r = parseCommonParams(over)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('commonFilter', () => {
  test('always binds the time range as Int64 epoch ms', () => {
    const p = params({ from: '1000', to: '2000' })
    const f = commonFilter(p)
    expect(f.sql).toContain('fromUnixTimestamp64Milli({from:Int64})')
    expect(f.sql).toContain('fromUnixTimestamp64Milli({to:Int64})')
    expect(f.params.from).toBe(1000)
    expect(f.params.to).toBe(2000)
  })

  test('binds optional exact filters only when present', () => {
    const f = commonFilter(params({ device_id: 'd1' }))
    expect(f.sql).toContain('device_id = {device_id:String}')
    expect(f.params.device_id).toBe('d1')
    expect(f.sql).not.toContain('channel =')
  })

  test('omits absent filters entirely', () => {
    const f = commonFilter(params({}))
    expect(f.sql).not.toContain('device_id')
    expect(f.sql).not.toContain('channel')
    expect(Object.keys(f.params).sort()).toEqual(['from', 'to'])
  })
})
```

- [ ] **Step 6: Run it, verify it fails**

Run: `cd fleet-central/query && bun test src/sql.test.ts`
Expected: FAIL — module `./sql` missing.

- [ ] **Step 7: Write `sql.ts`**

`fleet-central/query/src/sql.ts`:
```ts
import type { QueryParams } from './params'

/**
 * Shared WHERE fragment: time range (always) + optional exact filters.
 * Returns an SQL string beginning with `AND ...` and the bound params.
 * Callers prepend their own `WHERE type=...`.
 */
export function commonFilter(p: QueryParams): {
  sql: string
  params: Record<string, unknown>
} {
  const clauses: string[] = [
    'AND ts BETWEEN fromUnixTimestamp64Milli({from:Int64}) AND fromUnixTimestamp64Milli({to:Int64})',
  ]
  const params: Record<string, unknown> = { from: p.from, to: p.to }

  const exact: Array<[keyof QueryParams, string]> = [
    ['device_id', 'device_id'],
    ['session_id', 'session_id'],
    ['install_id', 'install_id'],
    ['channel', 'channel'],
    ['os', 'os'],
  ]
  for (const [key, col] of exact) {
    const v = p[key]
    if (v !== undefined) {
      clauses.push(`AND ${col} = {${col}:String}`)
      params[col] = v
    }
  }

  return { sql: clauses.join('\n  '), params }
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `cd fleet-central/query && bun test src/sql.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add fleet-central/query/src/params.ts fleet-central/query/src/sql.ts \
  fleet-central/query/src/params.test.ts fleet-central/query/src/sql.test.ts
git commit -m "feat(fleet-query): common param parsing + shared SQL filter"
```

---

### Task 3: Response helper + agent-activity insight + route

**Files:**
- Create: `fleet-central/query/src/response.ts`
- Create: `fleet-central/query/src/insights/agent-activity.ts`
- Modify: `fleet-central/query/src/app.ts` (add the route)
- Test: `fleet-central/query/src/insights/agent-activity.test.ts`
- Test: `fleet-central/query/src/app.test.ts` (add a route test)

**Interfaces:**
- Consumes: `QueryParams`, `parseCommonParams` (Task 2); `commonFilter` (Task 2); `QueryReader` (Task 1).
- Produces:
  - `function buildMeta(params: QueryParams, rowCount: number, startedAt: number): { range: { from: number; to: number }; filters: Record<string, unknown>; row_count: number; elapsed_ms: number }` (in `response.ts`)
  - `interface InsightQuery { sql: string; params: Record<string, unknown> }`
  - `function buildToolStats(p: QueryParams): InsightQuery`
  - `function buildMcpScopes(p: QueryParams): InsightQuery`
  - `interface ToolStat { tool: string; executions: number; error_rate: number; p50_ms: number; p95_ms: number }`
  - `interface McpScope { scope_id: string; requests: number }`
  - `function mapToolStat(row: Record<string, unknown>): ToolStat`
  - `function mapMcpScope(row: Record<string, unknown>): McpScope`
  (all insight symbols in `insights/agent-activity.ts`)

- [ ] **Step 1: Write `response.ts`**

`fleet-central/query/src/response.ts`:
```ts
import type { QueryParams } from './params'

export function buildMeta(params: QueryParams, rowCount: number, startedAt: number) {
  return {
    range: { from: params.from, to: params.to },
    filters: {
      device_id: params.device_id ?? null,
      session_id: params.session_id ?? null,
      install_id: params.install_id ?? null,
      channel: params.channel ?? null,
      os: params.os ?? null,
    },
    row_count: rowCount,
    elapsed_ms: Date.now() - startedAt,
  }
}
```

- [ ] **Step 2: Write the failing `agent-activity.test.ts`**

`fleet-central/query/src/insights/agent-activity.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildMcpScopes,
  buildToolStats,
  mapMcpScope,
  mapToolStat,
} from './agent-activity'

function params() {
  const r = parseCommonParams({ device_id: 'd1' })
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('agent-activity builders', () => {
  test('tool stats query is scoped to agent.action with FINAL + filters', () => {
    const q = buildToolStats(params())
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain("type = 'agent.action'")
    expect(q.sql).toContain("JSONExtractString(payload, 'tool')")
    expect(q.sql).toContain('device_id = {device_id:String}')
    expect(q.params.device_id).toBe('d1')
  })

  test('mcp scopes query is scoped to agent.mcp_request', () => {
    const q = buildMcpScopes(params())
    expect(q.sql).toContain("type = 'agent.mcp_request'")
    expect(q.sql).toContain("JSONExtractString(payload, 'scope_id')")
  })

  test('mapToolStat coerces strings and computes error_rate', () => {
    const row = { tool: 'navigate', executions: '10', errors: '2', p50_ms: 5, p95_ms: 9 }
    expect(mapToolStat(row)).toEqual({
      tool: 'navigate',
      executions: 10,
      error_rate: 0.2,
      p50_ms: 5,
      p95_ms: 9,
    })
  })

  test('mapToolStat error_rate is 0 when no executions', () => {
    const row = { tool: 'x', executions: '0', errors: '0', p50_ms: 0, p95_ms: 0 }
    expect(mapToolStat(row).error_rate).toBe(0)
  })

  test('mapMcpScope coerces count', () => {
    expect(mapMcpScope({ scope_id: 's', requests: '7' })).toEqual({
      scope_id: 's',
      requests: 7,
    })
  })
})
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd fleet-central/query && bun test src/insights/agent-activity.test.ts`
Expected: FAIL — module `./agent-activity` missing.

- [ ] **Step 4: Write `insights/agent-activity.ts`**

`fleet-central/query/src/insights/agent-activity.ts`:
```ts
import type { QueryParams } from '../params'
import { commonFilter } from '../sql'

export interface InsightQuery {
  sql: string
  params: Record<string, unknown>
}

export interface ToolStat {
  tool: string
  executions: number
  error_rate: number
  p50_ms: number
  p95_ms: number
}

export interface McpScope {
  scope_id: string
  requests: number
}

export function buildToolStats(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'tool') AS tool,
           count() AS executions,
           countIf(JSONExtractString(payload, 'result') = 'error') AS errors,
           quantile(0.5)(JSONExtractFloat(payload, 'duration_ms')) AS p50_ms,
           quantile(0.95)(JSONExtractFloat(payload, 'duration_ms')) AS p95_ms
    FROM fleet.events FINAL
    WHERE type = 'agent.action'
      ${f.sql}
    GROUP BY tool
    ORDER BY executions DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildMcpScopes(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'scope_id') AS scope_id,
           count() AS requests
    FROM fleet.events FINAL
    WHERE type = 'agent.mcp_request'
      ${f.sql}
    GROUP BY scope_id
    ORDER BY requests DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function mapToolStat(row: Record<string, unknown>): ToolStat {
  const executions = Number(row.executions)
  const errors = Number(row.errors)
  return {
    tool: String(row.tool),
    executions,
    error_rate: executions ? errors / executions : 0,
    p50_ms: Number(row.p50_ms),
    p95_ms: Number(row.p95_ms),
  }
}

export function mapMcpScope(row: Record<string, unknown>): McpScope {
  return { scope_id: String(row.scope_id), requests: Number(row.requests) }
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `cd fleet-central/query && bun test src/insights/agent-activity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Add the route to `app.ts`**

Add this import at the top of `fleet-central/query/src/app.ts`:
```ts
import {
  buildMcpScopes,
  buildToolStats,
  mapMcpScope,
  mapToolStat,
} from './insights/agent-activity'
import { parseCommonParams } from './params'
import { buildMeta } from './response'
```

Add this route inside `createApp`, after the `app.use('/v1/*', ...)` auth middleware and before `return app`:
```ts
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
```

- [ ] **Step 7: Add a route test to `app.test.ts`**

Append to `fleet-central/query/src/app.test.ts`:
```ts
describe('GET /v1/insights/agent-activity', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('shapes {data:{tools,mcp_scopes}, meta}', async () => {
    const reader = new MemoryReader(
      [{ tool: 'navigate', executions: '4', errors: '1', p50_ms: 3, p95_ms: 8 }],
      [{ scope_id: 's1', requests: '2' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/agent-activity', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.tools[0]).toEqual({
      tool: 'navigate', executions: 4, error_rate: 0.25, p50_ms: 3, p95_ms: 8,
    })
    expect(body.data.mcp_scopes[0]).toEqual({ scope_id: 's1', requests: 2 })
    expect(body.meta.row_count).toBe(1)
  })

  test('400 on bad params', async () => {
    const app = createApp({ reader: new MemoryReader(), token: TOKEN })
    const res = await app.request('http://x/v1/insights/agent-activity?from=banana', {
      headers: auth,
    })
    expect(res.status).toBe(400)
  })

  test('503 when the reader throws', async () => {
    const reader = new MemoryReader()
    reader.failQueries()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/agent-activity', { headers: auth })
    expect(res.status).toBe(503)
  })
})
```

- [ ] **Step 8: Run the full suite, verify it passes**

Run: `cd fleet-central/query && bun test`
Expected: PASS (all tests so far: skeleton 3 + params 7 + sql 3 + agent-activity 5 + app-route 3).

- [ ] **Step 9: Commit**

```bash
git add fleet-central/query/src/response.ts \
  fleet-central/query/src/insights/agent-activity.ts \
  fleet-central/query/src/app.ts fleet-central/query/src/app.test.ts \
  fleet-central/query/src/insights/agent-activity.test.ts
git commit -m "feat(fleet-query): agent-activity insight + route"
```

---

### Task 4: Usage insight + route

**Files:**
- Create: `fleet-central/query/src/insights/usage.ts`
- Modify: `fleet-central/query/src/app.ts` (add the route)
- Test: `fleet-central/query/src/insights/usage.test.ts`
- Test: `fleet-central/query/src/app.test.ts` (add a route test)

**Interfaces:**
- Consumes: `QueryParams`, `commonFilter`, `parseCommonParams`, `buildMeta`, `InsightQuery`, `QueryReader`.
- Produces:
  - `function buildTopHosts(p: QueryParams): InsightQuery`
  - `function buildNavSeries(p: QueryParams, bucket: 'hour' | 'day'): InsightQuery`
  - `interface HostCount { host: string; requests: number }`
  - `interface NavBucket { bucket: string; navigations: number }`
  - `function mapHostCount(row: Record<string, unknown>): HostCount`
  - `function mapNavBucket(row: Record<string, unknown>): NavBucket`
  - `function parseBucket(v: string | undefined): 'hour' | 'day'` (default `'hour'`)

- [ ] **Step 1: Write the failing `usage.test.ts`**

`fleet-central/query/src/insights/usage.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildNavSeries,
  buildTopHosts,
  mapHostCount,
  mapNavBucket,
  parseBucket,
} from './usage'

function params() {
  const r = parseCommonParams({})
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('usage builders', () => {
  test('top hosts counts network.request by host', () => {
    const q = buildTopHosts(params())
    expect(q.sql).toContain("type = 'network.request'")
    expect(q.sql).toContain("JSONExtractString(payload, 'host')")
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain('ORDER BY requests DESC')
  })

  test('nav series buckets by hour', () => {
    const q = buildNavSeries(params(), 'hour')
    expect(q.sql).toContain('toStartOfHour(ts)')
    expect(q.sql).toContain("type = 'navigation'")
  })

  test('nav series buckets by day', () => {
    const q = buildNavSeries(params(), 'day')
    expect(q.sql).toContain('toStartOfDay(ts)')
  })

  test('parseBucket defaults to hour, accepts day', () => {
    expect(parseBucket(undefined)).toBe('hour')
    expect(parseBucket('day')).toBe('day')
    expect(parseBucket('garbage')).toBe('hour')
  })

  test('mappers coerce counts', () => {
    expect(mapHostCount({ host: 'a.com', requests: '12' })).toEqual({
      host: 'a.com', requests: 12,
    })
    expect(mapNavBucket({ bucket: '2023-11-14 22:00:00', navigations: '3' })).toEqual({
      bucket: '2023-11-14 22:00:00', navigations: 3,
    })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd fleet-central/query && bun test src/insights/usage.test.ts`
Expected: FAIL — module `./usage` missing.

- [ ] **Step 3: Write `insights/usage.ts`**

`fleet-central/query/src/insights/usage.ts`:
```ts
import type { QueryParams } from '../params'
import { commonFilter } from '../sql'
import type { InsightQuery } from './agent-activity'

export interface HostCount {
  host: string
  requests: number
}

export interface NavBucket {
  bucket: string
  navigations: number
}

export function parseBucket(v: string | undefined): 'hour' | 'day' {
  return v === 'day' ? 'day' : 'hour'
}

export function buildTopHosts(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'host') AS host,
           count() AS requests
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      ${f.sql}
    GROUP BY host
    ORDER BY requests DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildNavSeries(p: QueryParams, bucket: 'hour' | 'day'): InsightQuery {
  const f = commonFilter(p)
  const fn = bucket === 'day' ? 'toStartOfDay' : 'toStartOfHour'
  const sql = `
    SELECT formatDateTime(${fn}(ts), '%Y-%m-%d %H:%M:%S') AS bucket,
           count() AS navigations
    FROM fleet.events FINAL
    WHERE type = 'navigation'
      ${f.sql}
    GROUP BY bucket
    ORDER BY bucket ASC`
  return { sql, params: f.params }
}

export function mapHostCount(row: Record<string, unknown>): HostCount {
  return { host: String(row.host), requests: Number(row.requests) }
}

export function mapNavBucket(row: Record<string, unknown>): NavBucket {
  return { bucket: String(row.bucket), navigations: Number(row.navigations) }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd fleet-central/query && bun test src/insights/usage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the route to `app.ts`**

Add imports at the top of `app.ts`:
```ts
import {
  buildNavSeries,
  buildTopHosts,
  mapHostCount,
  mapNavBucket,
  parseBucket,
} from './insights/usage'
```

Add this route inside `createApp` (after the agent-activity route):
```ts
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
```

- [ ] **Step 6: Add a route test to `app.test.ts`**

Append to `app.test.ts`:
```ts
describe('GET /v1/insights/usage', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('shapes {data:{top_hosts,navigations}, meta}', async () => {
    const reader = new MemoryReader(
      [{ host: 'a.com', requests: '9' }],
      [{ bucket: '2023-11-14 22:00:00', navigations: '3' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/usage?bucket=day', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.top_hosts[0]).toEqual({ host: 'a.com', requests: 9 })
    expect(body.data.navigations[0]).toEqual({
      bucket: '2023-11-14 22:00:00', navigations: 3,
    })
  })

  test('503 when the reader throws', async () => {
    const reader = new MemoryReader()
    reader.failQueries()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/usage', { headers: auth })
    expect(res.status).toBe(503)
  })
})
```

- [ ] **Step 7: Run the full suite, verify it passes**

Run: `cd fleet-central/query && bun test`
Expected: PASS (adds usage 5 + app-route 2).

- [ ] **Step 8: Commit**

```bash
git add fleet-central/query/src/insights/usage.ts \
  fleet-central/query/src/insights/usage.test.ts \
  fleet-central/query/src/app.ts fleet-central/query/src/app.test.ts
git commit -m "feat(fleet-query): usage insight + route"
```

---

### Task 5: Health insight + route

**Files:**
- Create: `fleet-central/query/src/insights/health.ts`
- Modify: `fleet-central/query/src/app.ts` (add the route)
- Test: `fleet-central/query/src/insights/health.test.ts`
- Test: `fleet-central/query/src/app.test.ts` (add a route test)

**Interfaces:**
- Consumes: `QueryParams`, `commonFilter`, `parseCommonParams`, `buildMeta`, `InsightQuery`, `QueryReader`.
- Produces:
  - `function buildStatusFamilies(p: QueryParams): InsightQuery`
  - `function buildTopFailingHosts(p: QueryParams): InsightQuery`
  - `function buildSlowest(p: QueryParams): InsightQuery`
  - `function buildErrorCount(p: QueryParams): InsightQuery`
  - `interface StatusFamily { status_family: string; count: number }`
  - `interface FailingHost { host: string; failures: number }`
  - `interface SlowRequest { url: string; total_ms: number }`
  - `function mapStatusFamily(row): StatusFamily`, `mapFailingHost(row): FailingHost`, `mapSlowRequest(row): SlowRequest`, `mapErrorCount(rows: Record<string, unknown>[]): number`

- [ ] **Step 1: Write the failing `health.test.ts`**

`fleet-central/query/src/insights/health.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildErrorCount,
  buildSlowest,
  buildStatusFamilies,
  buildTopFailingHosts,
  mapErrorCount,
  mapFailingHost,
  mapSlowRequest,
  mapStatusFamily,
} from './health'

function params() {
  const r = parseCommonParams({})
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('health builders', () => {
  test('status families bucket the HTTP status', () => {
    const q = buildStatusFamilies(params())
    expect(q.sql).toContain("type = 'network.request'")
    expect(q.sql).toContain("JSONExtractInt(payload, 'status')")
    expect(q.sql).toContain('multiIf(')
  })

  test('top failing hosts filter to failed/4xx/5xx', () => {
    const q = buildTopFailingHosts(params())
    expect(q.sql).toContain("JSONExtractString(payload, 'host')")
    expect(q.sql).toContain('ORDER BY failures DESC')
  })

  test('slowest uses timing.total', () => {
    const q = buildSlowest(params())
    expect(q.sql).toContain("JSONExtractFloat(payload, 'timing', 'total')")
    expect(q.sql).toContain('ORDER BY total_ms DESC')
  })

  test('error count targets the error family', () => {
    const q = buildErrorCount(params())
    expect(q.sql).toContain("type = 'error'")
    expect(q.sql).toContain('count()')
  })

  test('mappers coerce values', () => {
    expect(mapStatusFamily({ status_family: '2xx', count: '5' })).toEqual({
      status_family: '2xx', count: 5,
    })
    expect(mapFailingHost({ host: 'a.com', failures: '2' })).toEqual({
      host: 'a.com', failures: 2,
    })
    expect(mapSlowRequest({ url: 'http://a', total_ms: 1234 })).toEqual({
      url: 'http://a', total_ms: 1234,
    })
    expect(mapErrorCount([{ c: '7' }])).toBe(7)
    expect(mapErrorCount([])).toBe(0)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd fleet-central/query && bun test src/insights/health.test.ts`
Expected: FAIL — module `./health` missing.

- [ ] **Step 3: Write `insights/health.ts`**

`fleet-central/query/src/insights/health.ts`:
```ts
import type { QueryParams } from '../params'
import { commonFilter } from '../sql'
import type { InsightQuery } from './agent-activity'

export interface StatusFamily {
  status_family: string
  count: number
}
export interface FailingHost {
  host: string
  failures: number
}
export interface SlowRequest {
  url: string
  total_ms: number
}

export function buildStatusFamilies(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT multiIf(
             JSONExtractString(payload, 'outcome') = 'failed', 'failed',
             JSONExtractInt(payload, 'status') >= 500, '5xx',
             JSONExtractInt(payload, 'status') >= 400, '4xx',
             JSONExtractInt(payload, 'status') >= 300, '3xx',
             JSONExtractInt(payload, 'status') >= 200, '2xx',
             'other') AS status_family,
           count() AS count
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      ${f.sql}
    GROUP BY status_family
    ORDER BY count DESC`
  return { sql, params: f.params }
}

export function buildTopFailingHosts(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'host') AS host,
           count() AS failures
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      AND (JSONExtractString(payload, 'outcome') = 'failed'
           OR JSONExtractInt(payload, 'status') >= 400)
      ${f.sql}
    GROUP BY host
    ORDER BY failures DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildSlowest(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT JSONExtractString(payload, 'url') AS url,
           JSONExtractFloat(payload, 'timing', 'total') AS total_ms
    FROM fleet.events FINAL
    WHERE type = 'network.request'
      ${f.sql}
    ORDER BY total_ms DESC
    LIMIT {limit:UInt32}`
  return { sql, params: { ...f.params, limit: p.limit } }
}

export function buildErrorCount(p: QueryParams): InsightQuery {
  const f = commonFilter(p)
  const sql = `
    SELECT count() AS c
    FROM fleet.events FINAL
    WHERE type = 'error'
      ${f.sql}`
  return { sql, params: f.params }
}

export function mapStatusFamily(row: Record<string, unknown>): StatusFamily {
  return { status_family: String(row.status_family), count: Number(row.count) }
}
export function mapFailingHost(row: Record<string, unknown>): FailingHost {
  return { host: String(row.host), failures: Number(row.failures) }
}
export function mapSlowRequest(row: Record<string, unknown>): SlowRequest {
  return { url: String(row.url), total_ms: Number(row.total_ms) }
}
export function mapErrorCount(rows: Record<string, unknown>[]): number {
  return rows.length ? Number(rows[0].c) : 0
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd fleet-central/query && bun test src/insights/health.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the route to `app.ts`**

Add imports at the top of `app.ts`:
```ts
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
```

Add this route inside `createApp` (after the usage route):
```ts
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
```

- [ ] **Step 6: Add a route test to `app.test.ts`**

Append to `app.test.ts`:
```ts
describe('GET /v1/insights/health', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('shapes the full health object', async () => {
    const reader = new MemoryReader(
      [{ status_family: '2xx', count: '5' }],
      [{ host: 'bad.com', failures: '3' }],
      [{ url: 'http://slow', total_ms: 900 }],
      [{ c: '2' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/health', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.status_families[0]).toEqual({ status_family: '2xx', count: 5 })
    expect(body.data.top_failing_hosts[0]).toEqual({ host: 'bad.com', failures: 3 })
    expect(body.data.slowest[0]).toEqual({ url: 'http://slow', total_ms: 900 })
    expect(body.data.error_count).toBe(2)
  })

  test('503 when the reader throws', async () => {
    const reader = new MemoryReader()
    reader.failQueries()
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/insights/health', { headers: auth })
    expect(res.status).toBe(503)
  })
})
```

- [ ] **Step 7: Run the full suite, verify it passes**

Run: `cd fleet-central/query && bun test`
Expected: PASS (adds health 5 + app-route 2).

- [ ] **Step 8: Commit**

```bash
git add fleet-central/query/src/insights/health.ts \
  fleet-central/query/src/insights/health.test.ts \
  fleet-central/query/src/app.ts fleet-central/query/src/app.test.ts
git commit -m "feat(fleet-query): health insight + route"
```

---

### Task 6: Raw search + event-by-id + meta facets

**Files:**
- Create: `fleet-central/query/src/insights/search.ts`
- Modify: `fleet-central/query/src/app.ts` (add 3 routes)
- Test: `fleet-central/query/src/insights/search.test.ts`
- Test: `fleet-central/query/src/app.test.ts` (add route tests)

**Interfaces:**
- Consumes: `QueryParams`, `commonFilter`, `parseCommonParams`, `buildMeta`, `InsightQuery`, `QueryReader`.
- Produces:
  - `function buildEventSearch(p: QueryParams, opts: { type?: string; host?: string; q?: string }): InsightQuery`
  - `function buildEventById(eventId: string): InsightQuery`
  - `function buildMetaFacets(): { types: InsightQuery; devices: InsightQuery; channels: InsightQuery; oses: InsightQuery; range: InsightQuery }`
  - `function mapEventRow(row: Record<string, unknown>): EventRow` where `interface EventRow { event_id: string; ts: string; type: string; device_id: string | null; session_id: string; host: string | null; url: string | null; payload: unknown }`
  - `function mapFullEvent(row: Record<string, unknown>): Record<string, unknown>` (parses the `payload` JSON string into an object)

- [ ] **Step 1: Write the failing `search.test.ts`**

`fleet-central/query/src/insights/search.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { parseCommonParams } from '../params'
import {
  buildEventById,
  buildEventSearch,
  buildMetaFacets,
  mapEventRow,
  mapFullEvent,
} from './search'

function params() {
  const r = parseCommonParams({})
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('search builders', () => {
  test('event search applies optional type/host/q + paging', () => {
    const q = buildEventSearch(params(), { type: 'navigation', host: 'a.com', q: 'login' })
    expect(q.sql).toContain('FROM fleet.events FINAL')
    expect(q.sql).toContain('type = {type:String}')
    expect(q.sql).toContain("JSONExtractString(payload, 'host') = {host:String}")
    expect(q.sql).toContain('ORDER BY ts DESC')
    expect(q.sql).toContain('LIMIT {limit:UInt32} OFFSET {offset:UInt32}')
    expect(q.params.type).toBe('navigation')
    expect(q.params.host).toBe('a.com')
    expect(q.params.q).toBe('%login%')
  })

  test('event search omits absent optional filters', () => {
    const q = buildEventSearch(params(), {})
    expect(q.sql).not.toContain('type = {type:String}')
    expect(q.sql).not.toContain('host')
    expect(q.sql).not.toContain('ILIKE')
  })

  test('event-by-id binds the id', () => {
    const q = buildEventById('abc')
    expect(q.sql).toContain('event_id = {event_id:String}')
    expect(q.params.event_id).toBe('abc')
  })

  test('meta facets cover types/devices/channels/oses/range', () => {
    const f = buildMetaFacets()
    expect(f.types.sql).toContain('GROUP BY type')
    expect(f.devices.sql).toContain('DISTINCT device_id')
    expect(f.channels.sql).toContain('DISTINCT channel')
    expect(f.oses.sql).toContain('DISTINCT os')
    expect(f.range.sql).toContain('min(ts)')
    expect(f.range.sql).toContain('max(ts)')
  })

  test('mapEventRow surfaces key columns', () => {
    const row = {
      event_id: 'e1', ts: '2023-11-14 22:00:00.000', type: 'navigation',
      device_id: null, session_id: 's', host: 'a.com', url: 'http://a', payload: '{}',
    }
    expect(mapEventRow(row)).toEqual({
      event_id: 'e1', ts: '2023-11-14 22:00:00.000', type: 'navigation',
      device_id: null, session_id: 's', host: 'a.com', url: 'http://a', payload: {},
    })
  })

  test('mapFullEvent parses the payload JSON string', () => {
    const row = { event_id: 'e1', type: 'navigation', payload: '{"host":"a.com"}' }
    const full = mapFullEvent(row)
    expect(full.payload).toEqual({ host: 'a.com' })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd fleet-central/query && bun test src/insights/search.test.ts`
Expected: FAIL — module `./search` missing.

- [ ] **Step 3: Write `insights/search.ts`**

`fleet-central/query/src/insights/search.ts`:
```ts
import type { QueryParams } from '../params'
import { commonFilter } from '../sql'
import type { InsightQuery } from './agent-activity'

export interface EventRow {
  event_id: string
  ts: string
  type: string
  device_id: string | null
  session_id: string
  host: string | null
  url: string | null
  payload: unknown
}

function safeParse(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export function buildEventSearch(
  p: QueryParams,
  opts: { type?: string; host?: string; q?: string },
): InsightQuery {
  const f = commonFilter(p)
  const clauses: string[] = []
  const params: Record<string, unknown> = {
    ...f.params,
    limit: p.limit,
    offset: p.offset,
  }
  if (opts.type) {
    clauses.push('AND type = {type:String}')
    params.type = opts.type
  }
  if (opts.host) {
    clauses.push("AND JSONExtractString(payload, 'host') = {host:String}")
    params.host = opts.host
  }
  if (opts.q) {
    clauses.push(
      "AND (JSONExtractString(payload, 'url') ILIKE {q:String} OR JSONExtractString(payload, 'tool') ILIKE {q:String})",
    )
    params.q = `%${opts.q}%`
  }
  const sql = `
    SELECT event_id,
           formatDateTime(ts, '%Y-%m-%d %H:%M:%S.%f') AS ts,
           type, device_id, session_id,
           JSONExtractString(payload, 'host') AS host,
           JSONExtractString(payload, 'url') AS url,
           payload
    FROM fleet.events FINAL
    WHERE 1 = 1
      ${f.sql}
      ${clauses.join('\n      ')}
    ORDER BY ts DESC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}`
  return { sql, params }
}

export function buildEventById(eventId: string): InsightQuery {
  const sql = `
    SELECT * FROM fleet.events FINAL
    WHERE event_id = {event_id:String}
    LIMIT 1`
  return { sql, params: { event_id: eventId } }
}

export function buildMetaFacets(): {
  types: InsightQuery
  devices: InsightQuery
  channels: InsightQuery
  oses: InsightQuery
  range: InsightQuery
} {
  return {
    types: {
      sql: 'SELECT type, count() AS count FROM fleet.events FINAL GROUP BY type ORDER BY count DESC',
      params: {},
    },
    devices: {
      sql: 'SELECT DISTINCT device_id FROM fleet.events FINAL WHERE device_id IS NOT NULL',
      params: {},
    },
    channels: { sql: 'SELECT DISTINCT channel FROM fleet.events FINAL', params: {} },
    oses: { sql: 'SELECT DISTINCT os FROM fleet.events FINAL', params: {} },
    range: {
      sql: 'SELECT toUnixTimestamp64Milli(min(ts)) AS min_ts, toUnixTimestamp64Milli(max(ts)) AS max_ts FROM fleet.events FINAL',
      params: {},
    },
  }
}

export function mapEventRow(row: Record<string, unknown>): EventRow {
  return {
    event_id: String(row.event_id),
    ts: String(row.ts),
    type: String(row.type),
    device_id: row.device_id === null ? null : String(row.device_id),
    session_id: String(row.session_id),
    host: row.host ? String(row.host) : null,
    url: row.url ? String(row.url) : null,
    payload: safeParse(row.payload),
  }
}

export function mapFullEvent(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, payload: safeParse(row.payload) }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd fleet-central/query && bun test src/insights/search.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the 3 routes to `app.ts`**

Add imports at the top of `app.ts`:
```ts
import {
  buildEventById,
  buildEventSearch,
  buildMetaFacets,
  mapEventRow,
  mapFullEvent,
} from './insights/search'
```

Add these routes inside `createApp` (after the health route):
```ts
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
```

- [ ] **Step 6: Add route tests to `app.test.ts`**

Append to `app.test.ts`:
```ts
describe('raw search + meta', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }

  test('GET /v1/events maps rows', async () => {
    const reader = new MemoryReader([
      {
        event_id: 'e1', ts: '2023-11-14 22:00:00.000', type: 'navigation',
        device_id: null, session_id: 's', host: 'a.com', url: 'http://a', payload: '{}',
      },
    ])
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/events?type=navigation', { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data[0].event_id).toBe('e1')
    expect(body.data[0].payload).toEqual({})
  })

  test('GET /v1/events/:id returns 404 when empty', async () => {
    const app = createApp({ reader: new MemoryReader([]), token: TOKEN })
    const res = await app.request('http://x/v1/events/nope', { headers: auth })
    expect(res.status).toBe(404)
  })

  test('GET /v1/events/:id returns the full event with parsed payload', async () => {
    const reader = new MemoryReader([{ event_id: 'e1', type: 'navigation', payload: '{"host":"a.com"}' }])
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/events/e1', { headers: auth })
    const body = (await res.json()) as any
    expect(body.data.payload).toEqual({ host: 'a.com' })
  })

  test('GET /v1/meta aggregates facets', async () => {
    const reader = new MemoryReader(
      [{ type: 'navigation', count: '3' }],
      [{ device_id: 'd1' }],
      [{ channel: 'dev' }],
      [{ os: 'macos' }],
      [{ min_ts: '1000', max_ts: '2000' }],
    )
    const app = createApp({ reader, token: TOKEN })
    const res = await app.request('http://x/v1/meta', { headers: auth })
    const body = (await res.json()) as any
    expect(body.data.types[0]).toEqual({ type: 'navigation', count: 3 })
    expect(body.data.devices).toEqual(['d1'])
    expect(body.data.range).toEqual({ from: 1000, to: 2000 })
  })
})
```

- [ ] **Step 7: Run the full suite, verify it passes**

Run: `cd fleet-central/query && bun test`
Expected: PASS (adds search 6 + app-route 4).

- [ ] **Step 8: Typecheck (everything except `index.ts`'s ClickHouseReader import is now real)**

Run: `cd fleet-central/query && bunx tsc --noEmit`
Expected: ONE error only — `Cannot find module './reader/clickhouse-reader'` in `index.ts` (resolved in Task 7). No other errors.

- [ ] **Step 9: Commit**

```bash
git add fleet-central/query/src/insights/search.ts \
  fleet-central/query/src/insights/search.test.ts \
  fleet-central/query/src/app.ts fleet-central/query/src/app.test.ts
git commit -m "feat(fleet-query): raw event search + by-id + meta facets"
```

---

### Task 7: ClickHouseReader + integration test

**Files:**
- Create: `fleet-central/query/src/reader/clickhouse-reader.ts`
- Test: `fleet-central/query/src/reader/clickhouse-reader.test.ts`

**Interfaces:**
- Consumes: `QueryReader` (Task 1).
- Produces: `class ClickHouseReader implements QueryReader` with constructor `(opts: { url: string; database: string; username: string; password: string })`. Resolves the `index.ts` import from Task 1.

- [ ] **Step 1: Write `clickhouse-reader.ts`**

`fleet-central/query/src/reader/clickhouse-reader.ts`:
```ts
import { type ClickHouseClient, createClient } from '@clickhouse/client'
import type { QueryReader } from './reader'

export interface ClickHouseReaderOptions {
  url: string
  database: string
  username: string
  password: string
}

export class ClickHouseReader implements QueryReader {
  private readonly opts: ClickHouseReaderOptions
  private _client: ClickHouseClient | undefined

  constructor(opts: ClickHouseReaderOptions) {
    this.opts = opts
  }

  private get client(): ClickHouseClient {
    if (!this._client) {
      this._client = createClient({
        url: this.opts.url,
        database: this.opts.database,
        username: this.opts.username,
        password: this.opts.password,
      })
    }
    return this._client
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    const rs = await this.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    })
    return (await rs.json()) as T[]
  }

  async health(): Promise<boolean> {
    try {
      await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    if (this._client) await this._client.close()
  }
}
```

- [ ] **Step 2: Typecheck — should now be fully clean**

Run: `cd fleet-central/query && bunx tsc --noEmit`
Expected: PASS, zero errors (the `index.ts` import now resolves).

- [ ] **Step 3: Write the integration test** (skips unless `CLICKHOUSE_URL` is set, mirroring `ingest/clickhouse-store.test.ts`)

`fleet-central/query/src/reader/clickhouse-reader.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { buildToolStats } from '../insights/agent-activity'
import { parseCommonParams } from '../params'
import { ClickHouseReader } from './clickhouse-reader'

const URL = process.env.CLICKHOUSE_URL
const skip = !URL

describe.skipIf(skip)('ClickHouseReader (integration)', () => {
  const reader = new ClickHouseReader({
    url: URL ?? '',
    database: 'fleet',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  })

  afterAll(async () => {
    await reader.close()
  })

  test('health is true against a live server', async () => {
    expect(await reader.health()).toBe(true)
  })

  test('seed agent.action events then aggregate via buildToolStats, FINAL dedups', async () => {
    const client = reader['client' as keyof ClickHouseReader] as never
    // Insert two agent.action rows (one duplicated event_id) directly.
    const base = {
      schema_version: 0, ts: 1_700_000_000_000, install_id: 'i',
      device_id: null, company_id: null, user_id: null, session_id: 's',
      browseros_version: '1', chromium_version: '1', os: 'macos', channel: 'dev',
      tab_id: null, frame_id: null, target_type: null, type: 'agent.action',
    }
    const mk = (id: string, result: string) => ({
      ...base, event_id: id,
      payload: JSON.stringify({ tool: 'navigate', result, duration_ms: 5 }),
    })
    await (client as { insert: (a: unknown) => Promise<unknown> }).insert({
      table: 'events', format: 'JSONEachRow',
      values: [mk('q-it-1', 'ok'), mk('q-it-1', 'ok'), mk('q-it-2', 'error')],
    })

    const r = parseCommonParams({ from: '1699999999000', to: '1700000001000' })
    if (!r.ok) throw new Error(r.error)
    const q = buildToolStats(r.value)
    const rows = await reader.query<Record<string, unknown>>(q.sql, q.params)
    const navigate = rows.find((x) => x.tool === 'navigate')
    expect(navigate).toBeDefined()
    // FINAL collapses the duplicated q-it-1 → executions = 2 (q-it-1 + q-it-2), not 3.
    expect(Number(navigate?.executions)).toBe(2)
    expect(Number(navigate?.errors)).toBe(1)
  })
})
```

> Reaching the private client via index access keeps the test self-contained without adding a production-only `rawClient()`. If a linter rejects the bracket access, add a `rawClient(): ClickHouseClient { return this.client }` escape hatch to `ClickHouseReader` (mirrors `ClickHouseStore.rawClient()`) and use it instead.

- [ ] **Step 4: Run the integration test against the live stack**

Bring up the existing stack if needed, then run with the host-mapped URL:
```bash
docker compose -f fleet-central/docker-compose.yml up -d clickhouse
cd fleet-central/query && CLICKHOUSE_URL=http://localhost:8123 bun test src/reader/clickhouse-reader.test.ts
```
Expected: PASS (2 tests). Without `CLICKHOUSE_URL` the suite is skipped (the default in CI/local unit runs).

- [ ] **Step 5: Run the full unit suite (no ClickHouse) to confirm nothing regressed**

Run: `cd fleet-central/query && bun test`
Expected: PASS; the integration describe is skipped.

- [ ] **Step 6: Commit**

```bash
git add fleet-central/query/src/reader/clickhouse-reader.ts \
  fleet-central/query/src/reader/clickhouse-reader.test.ts
git commit -m "feat(fleet-query): ClickHouseReader + integration test"
```

---

### Task 8: Static dashboard UI + serving

**Files:**
- Create: `fleet-central/query/public/index.html`
- Create: `fleet-central/query/public/app.css`
- Create: `fleet-central/query/public/app.js`
- Create: `fleet-central/query/public/vendor/uPlot.iife.min.js`
- Create: `fleet-central/query/public/vendor/uPlot.min.css`
- Modify: `fleet-central/query/src/app.ts` (serve static)
- Test: `fleet-central/query/src/app.test.ts` (static index served)

**Interfaces:**
- Consumes: all `/v1/*` endpoints (Tasks 3-6).
- Produces: a browser dashboard. No new exported code symbols.

- [ ] **Step 1: Vendor uPlot (no CDN at runtime)**

```bash
cd fleet-central/query
mkdir -p public/vendor
curl -fsSL https://unpkg.com/uplot@1.6.31/dist/uPlot.iife.min.js -o public/vendor/uPlot.iife.min.js
curl -fsSL https://unpkg.com/uplot@1.6.31/dist/uPlot.min.css -o public/vendor/uPlot.min.css
test -s public/vendor/uPlot.iife.min.js && test -s public/vendor/uPlot.min.css && echo OK
```
Expected: prints `OK`. (Download happens once at build-authoring time; the files are committed and served locally — no runtime egress.)

- [ ] **Step 2: Serve static files from `app.ts`**

Add this import at the top of `fleet-central/query/src/app.ts`:
```ts
import { serveStatic } from 'hono/bun'
```

Add this as the LAST thing inside `createApp`, immediately before `return app` (so `/v1/*` and `/health` win over the static fallback):
```ts
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/', serveStatic({ path: './public/index.html' }))
```

- [ ] **Step 3: Write `public/index.html`**

`fleet-central/query/public/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fleet Telemetry</title>
    <link rel="stylesheet" href="/vendor/uPlot.min.css" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <header>
      <h1>Fleet Telemetry</h1>
      <div id="filters">
        <select id="range">
          <option value="86400000">Last 24h</option>
          <option value="604800000">Last 7d</option>
          <option value="2592000000">Last 30d</option>
        </select>
        <select id="device"><option value="">All devices</option></select>
        <select id="channel"><option value="">All channels</option></select>
        <select id="os"><option value="">All OS</option></select>
        <button id="reload">Reload</button>
      </div>
    </header>
    <nav id="tabs">
      <button data-tab="usage" class="active">Usage</button>
      <button data-tab="agent">Agent</button>
      <button data-tab="health">Health</button>
      <button data-tab="explore">Explore</button>
    </nav>
    <main>
      <section id="usage" class="tab active"></section>
      <section id="agent" class="tab"></section>
      <section id="health" class="tab"></section>
      <section id="explore" class="tab"></section>
    </main>
    <div id="status"></div>
    <script src="/vendor/uPlot.iife.min.js"></script>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Write `public/app.css`**

`fleet-central/query/public/app.css`:
```css
:root { color-scheme: dark; --bg: #14161a; --fg: #e6e6e6; --mut: #8a93a0; --line: #2a2f37; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; gap: 8px; }
h1 { font-size: 16px; margin: 0; }
#filters { display: flex; gap: 8px; }
select, button { background: #1d2128; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
button { cursor: pointer; }
nav#tabs { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
nav#tabs button.active { background: #2a3340; }
main { padding: 16px; }
.tab { display: none; }
.tab.active { display: block; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--mut); font-weight: 600; }
tr.clickable:hover { background: #1d2128; cursor: pointer; }
#status { position: fixed; bottom: 8px; right: 12px; color: var(--mut); }
pre { background: #0e1014; padding: 12px; border-radius: 8px; overflow: auto; max-height: 60vh; }
.uplot { margin-top: 8px; }
```

- [ ] **Step 5: Write `public/app.js`**

`fleet-central/query/public/app.js`:
```js
const $ = (s) => document.querySelector(s)
const status = (m) => { $('#status').textContent = m || '' }

function getToken() {
  let t = localStorage.getItem('fleet_token')
  if (!t) {
    t = prompt('Query token (Bearer):') || ''
    localStorage.setItem('fleet_token', t)
  }
  return t
}

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } })
  if (res.status === 401) {
    localStorage.removeItem('fleet_token')
    throw new Error('unauthorized — reload to re-enter token')
  }
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

function commonQuery() {
  const now = Date.now()
  const span = Number($('#range').value)
  const p = new URLSearchParams({ from: String(now - span), to: String(now) })
  for (const k of ['device', 'channel', 'os']) {
    const v = $(`#${k}`).value
    if (v) p.set(k === 'device' ? 'device_id' : k, v)
  }
  return p
}

function table(rows, cols, opts = {}) {
  const t = document.createElement('table')
  t.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>`
  const tb = document.createElement('tbody')
  for (const r of rows) {
    const tr = document.createElement('tr')
    if (opts.onClick) { tr.className = 'clickable'; tr.onclick = () => opts.onClick(r) }
    tr.innerHTML = cols.map((c) => `<td>${c.get(r)}</td>`).join('')
    tb.appendChild(tr)
  }
  t.appendChild(tb)
  return t
}

function lineChart(el, points) {
  el.innerHTML = ''
  if (!points.length) { el.textContent = 'No data'; return }
  const xs = points.map((p, i) => i)
  const ys = points.map((p) => p.navigations)
  const labels = points.map((p) => p.bucket)
  // eslint-disable-next-line no-undef
  new uPlot(
    { width: el.clientWidth || 800, height: 240,
      scales: { x: { time: false } },
      axes: [{ values: (_u, vals) => vals.map((v) => labels[v] ?? '') }, {}],
      series: [{}, { label: 'navigations', stroke: '#5ab0ff', width: 2 }] },
    [xs, ys], el,
  )
}

const renderers = {
  async usage(el) {
    const { data } = await api(`/v1/insights/usage?bucket=hour&${commonQuery()}`)
    el.innerHTML = '<h3>Navigations</h3><div id="navchart" class="uplot"></div><h3>Top hosts</h3>'
    lineChart($('#navchart'), data.navigations)
    el.appendChild(table(data.top_hosts, [
      { label: 'Host', get: (r) => r.host || '(none)' },
      { label: 'Requests', get: (r) => r.requests },
    ]))
  },
  async agent(el) {
    const { data } = await api(`/v1/insights/agent-activity?${commonQuery()}`)
    el.innerHTML = '<h3>Tools</h3>'
    el.appendChild(table(data.tools, [
      { label: 'Tool', get: (r) => r.tool || '(none)' },
      { label: 'Execs', get: (r) => r.executions },
      { label: 'Error rate', get: (r) => `${(r.error_rate * 100).toFixed(1)}%` },
      { label: 'p50 ms', get: (r) => r.p50_ms.toFixed(0) },
      { label: 'p95 ms', get: (r) => r.p95_ms.toFixed(0) },
    ]))
    const h = document.createElement('h3'); h.textContent = 'MCP scopes'; el.appendChild(h)
    el.appendChild(table(data.mcp_scopes, [
      { label: 'Scope', get: (r) => r.scope_id || '(none)' },
      { label: 'Requests', get: (r) => r.requests },
    ]))
  },
  async health(el) {
    const { data } = await api(`/v1/insights/health?${commonQuery()}`)
    el.innerHTML = `<h3>Status families</h3>`
    el.appendChild(table(data.status_families, [
      { label: 'Family', get: (r) => r.status_family },
      { label: 'Count', get: (r) => r.count },
    ]))
    const h1 = document.createElement('h3'); h1.textContent = `Errors captured: ${data.error_count}`
    el.appendChild(h1)
    const h2 = document.createElement('h3'); h2.textContent = 'Top failing hosts'; el.appendChild(h2)
    el.appendChild(table(data.top_failing_hosts, [
      { label: 'Host', get: (r) => r.host || '(none)' },
      { label: 'Failures', get: (r) => r.failures },
    ]))
    const h3 = document.createElement('h3'); h3.textContent = 'Slowest requests'; el.appendChild(h3)
    el.appendChild(table(data.slowest, [
      { label: 'URL', get: (r) => r.url || '(none)' },
      { label: 'Total ms', get: (r) => r.total_ms.toFixed(0) },
    ]))
  },
  async explore(el) {
    const { data } = await api(`/v1/events?limit=100&${commonQuery()}`)
    el.innerHTML = '<h3>Recent events</h3>'
    el.appendChild(table(data, [
      { label: 'Time', get: (r) => r.ts },
      { label: 'Type', get: (r) => r.type },
      { label: 'Host', get: (r) => r.host || '' },
      { label: 'URL', get: (r) => (r.url || '').slice(0, 80) },
    ], {
      onClick: async (r) => {
        const { data: full } = await api(`/v1/events/${encodeURIComponent(r.event_id)}`)
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(full, null, 2)
        el.appendChild(pre)
        pre.scrollIntoView({ behavior: 'smooth' })
      },
    }))
  },
}

let current = 'usage'
async function render() {
  const el = $(`#${current}`)
  status('Loading…')
  try { await renderers[current](el); status('') }
  catch (e) { status(String(e.message || e)); el.innerHTML = `<p>${e.message || e}</p>` }
}

async function loadFacets() {
  try {
    const { data } = await api('/v1/meta')
    const fill = (sel, vals) => {
      for (const v of vals) {
        const o = document.createElement('option'); o.value = v; o.textContent = v
        $(sel).appendChild(o)
      }
    }
    fill('#device', data.devices)
    fill('#channel', data.channels)
    fill('#os', data.oses)
  } catch (e) { status(String(e.message || e)) }
}

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'))
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'))
    b.classList.add('active')
    current = b.dataset.tab
    $(`#${current}`).classList.add('active')
    render()
  }
}
$('#reload').onclick = render
$('#range').onchange = render
for (const k of ['device', 'channel', 'os']) $(`#${k}`).onchange = render

await loadFacets()
await render()
```

- [ ] **Step 6: Add a static-serving test to `app.test.ts`**

Append to `app.test.ts`:
```ts
describe('static UI', () => {
  test('serves index.html at /', async () => {
    const app = createApp({ reader: new MemoryReader(), token: TOKEN })
    const res = await app.request('http://x/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Fleet Telemetry')
  })
})
```

- [ ] **Step 7: Run the full suite, verify it passes**

Run: `cd fleet-central/query && bun test`
Expected: PASS, including the static test. (`serveStatic` from `hono/bun` reads from the real `public/` dir relative to CWD; run from `fleet-central/query`.)

- [ ] **Step 8: Manual visual smoke**

```bash
cd fleet-central/query
QUERY_TOKEN=devtoken CLICKHOUSE_URL=http://localhost:8123 bun src/index.ts
```
Open `http://localhost:9401/`, enter `devtoken` when prompted. With the existing E2E sample still in ClickHouse, confirm: Usage shows hosts + a nav chart, Agent/Health render tables, Explore lists events and clicking a row shows the full payload. Stop with Ctrl-C.
Expected: all four tabs render; no console errors; a bad token re-prompts after reload.

- [ ] **Step 9: Commit**

```bash
git add fleet-central/query/public fleet-central/query/src/app.ts \
  fleet-central/query/src/app.test.ts
git commit -m "feat(fleet-query): static dashboard UI (usage/agent/health/explore)"
```

---

### Task 9: Docker + compose + env + docs

**Files:**
- Create: `fleet-central/query/Dockerfile`
- Create: `fleet-central/query/.dockerignore`
- Modify: `fleet-central/docker-compose.yml` (add `query` service)
- Modify: `fleet-central/.env.example` (add `QUERY_TOKEN`, `QUERY_PORT`)
- Modify: `fleet-central/README.md` (document the query service + UI)

**Interfaces:**
- Consumes: the whole `query` service (Tasks 1-8).
- Produces: a deployable container reachable on `:9401`.

- [ ] **Step 1: Write `Dockerfile`** (mirror `ingest/Dockerfile`)

`fleet-central/query/Dockerfile`:
```dockerfile
FROM oven/bun:1.3
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
EXPOSE 9401
CMD ["bun", "src/index.ts"]
```

- [ ] **Step 2: Write `.dockerignore`**

`fleet-central/query/.dockerignore`:
```
node_modules
*.test.ts
```

- [ ] **Step 3: Add the `query` service to `docker-compose.yml`**

In `fleet-central/docker-compose.yml`, add this service after the `ingest` service block and before the `volumes:` key:
```yaml
  query:
    build: ./query
    restart: unless-stopped
    depends_on:
      clickhouse:
        condition: service_healthy
    environment:
      QUERY_PORT: 9401
      QUERY_TOKEN: ${QUERY_TOKEN:?set QUERY_TOKEN in .env}
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_DB: ${CLICKHOUSE_DB:-fleet}
      CLICKHOUSE_USER: ${CLICKHOUSE_USER:-default}
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD:-}
    ports:
      - "${QUERY_PORT:-9401}:9401"
```

- [ ] **Step 4: Add env vars to `.env.example`**

Append to `fleet-central/.env.example`:
```
# Query service (read-only dashboard API)
QUERY_TOKEN=change-me-query
QUERY_PORT=9401
```

- [ ] **Step 5: Document in `README.md`**

Append a section to `fleet-central/README.md`:
```markdown
## Query service + dashboard (subsystem #2a)

Read-only service over `fleet.events`, served on `:9401`.

- `GET /health`
- `GET /v1/insights/usage` — top hosts + navigation time series
- `GET /v1/insights/agent-activity` — per-tool stats + MCP scopes
- `GET /v1/insights/health` — status families, failing hosts, slowest, error count
- `GET /v1/events`, `GET /v1/events/:event_id` — raw search + detail
- `GET /v1/meta` — facets for the UI filters
- `GET /` — static dashboard (enter `QUERY_TOKEN` when prompted)

All `/v1/*` routes require `Authorization: Bearer $QUERY_TOKEN`.
Common query params: `from`, `to` (ISO or epoch ms; default last 24h),
`device_id`, `session_id`, `install_id`, `channel`, `os`, `limit` (≤1000), `offset`.

Run locally: `QUERY_TOKEN=dev CLICKHOUSE_URL=http://localhost:8123 bun src/index.ts`
(from `query/`), or via `docker compose up query`.
```

- [ ] **Step 6: Build and E2E smoke the whole stack**

```bash
cd fleet-central
# ensure QUERY_TOKEN is set in .env
docker compose up -d --build
curl -s http://localhost:9401/health
curl -s -H "authorization: Bearer $(grep QUERY_TOKEN .env | cut -d= -f2)" \
  "http://localhost:9401/v1/meta" | head -c 400
```
Expected: `/health` → `{"status":"ok","store":"connected"}`; `/v1/meta` returns JSON facets with the types present in the existing E2E sample (`network.request`, `navigation`, `page.lifecycle`). Open `http://localhost:9401/` and confirm the dashboard renders against real data.

- [ ] **Step 7: Final typecheck + full unit suite**

Run: `cd fleet-central/query && bunx tsc --noEmit && bun test`
Expected: typecheck clean; all unit tests pass (integration skipped without `CLICKHOUSE_URL`).

- [ ] **Step 8: Commit**

```bash
git add fleet-central/query/Dockerfile fleet-central/query/.dockerignore \
  fleet-central/docker-compose.yml fleet-central/.env.example fleet-central/README.md
git commit -m "feat(fleet-query): dockerize + compose service + env + docs"
```

---

## Self-Review

**1. Spec coverage:**
- §1 Architecture (service placement, read-only, isolation) → Tasks 1, 7, 8, 9. ✓
- §2 Contract (all endpoints + common params + meta) → Tasks 2 (params), 3 (agent-activity), 4 (usage), 5 (health), 6 (events/:id/meta). ✓
- §3 ClickHouse layer (JSONExtract, query_params, FINAL, fromUnixTimestamp64Milli, 400/503) → Tasks 2 (sql), 3-6 (builders + error handling), 7 (reader). ✓
- §4 UI (static, tabs, uPlot vendored, token in localStorage, lazy tabs, explorer detail) → Task 8. ✓
- §5 Auth/config/deploy (envs, compose, ports) → Tasks 1 (index env + auth), 9 (compose/env/Dockerfile). ✓
- §6 Testing (params unit, insight unit, app unit, integration, smoke) → present in every task; integration in 7; smokes in 8 & 9. ✓
- §7 Out of scope → respected (no agent surface, no multi-tenant, read-only only). ✓

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" — every code step has full code; error handling is the explicit `400`/`503`/`404`/`401` branches. ✓

**3. Type consistency:** `InsightQuery` defined once in `insights/agent-activity.ts` and imported by `usage.ts`/`health.ts`/`search.ts`. `QueryParams`/`parseCommonParams`/`commonFilter` names consistent across tasks. `QueryReader.query(sql, params)` signature identical in `reader.ts`, `MemoryReader`, `ClickHouseReader`, and all call sites. `buildMeta(params, rowCount, startedAt)` used uniformly. Route response is always `{ data, meta }` (except `/v1/events/:id` = `{ data }` and `/v1/meta` = `{ data }`, which the UI handles). ✓
