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
