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
