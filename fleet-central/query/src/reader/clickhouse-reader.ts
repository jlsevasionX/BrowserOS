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

  /** Escape hatch for tests that need direct client access. */
  rawClient(): ClickHouseClient {
    return this.client
  }

  async close(): Promise<void> {
    if (this._client) await this._client.close()
  }
}
