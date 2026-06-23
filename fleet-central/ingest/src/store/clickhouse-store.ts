import { type ClickHouseClient, createClient } from '@clickhouse/client'
import type { Envelope } from '../envelope'
import type { StoreWriter } from './store-writer'

export interface ClickHouseStoreOptions {
  url: string
  database: string
  username: string
  password: string
}

export class ClickHouseStore implements StoreWriter {
  private readonly opts: ClickHouseStoreOptions
  private _client: ClickHouseClient | undefined

  constructor(opts: ClickHouseStoreOptions) {
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

  async write(events: Envelope[]): Promise<void> {
    if (events.length === 0) return
    await this.client.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: events.map((e) => ({
        event_id: e.event_id,
        ts: e.ts, // DateTime64(3): epoch ms
        schema_version: e.schema_version,
        install_id: e.install_id,
        device_id: e.device_id,
        company_id: e.company_id,
        user_id: e.user_id,
        session_id: e.session_id,
        browseros_version: e.browseros_version,
        chromium_version: e.chromium_version,
        os: e.os,
        channel: e.channel,
        tab_id: e.tab_id,
        frame_id: e.frame_id,
        target_type: e.target_type,
        type: e.type,
        payload: JSON.stringify(e.payload),
      })),
    })
  }

  async health(): Promise<boolean> {
    try {
      await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
      return true
    } catch {
      return false
    }
  }

  /** Escape hatch for tests that read rows back. */
  rawClient(): ClickHouseClient {
    return this.client
  }

  async close(): Promise<void> {
    if (this._client) await this._client.close()
  }
}
