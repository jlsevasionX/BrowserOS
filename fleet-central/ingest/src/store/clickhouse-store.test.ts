import { describe, expect, test } from 'bun:test'
import type { Envelope } from '../envelope'
import { ClickHouseStore } from './clickhouse-store'

const URL = process.env.CLICKHOUSE_URL
const skip = !URL

function event(id: string): Envelope {
  return {
    schema_version: 0, event_id: id, ts: 1_700_000_000_000, install_id: 'i',
    device_id: null, company_id: null, user_id: null, session_id: 's',
    browseros_version: '1', chromium_version: '1', os: 'macos', channel: 'dev',
    tab_id: null, frame_id: null, target_type: null, type: 'navigation',
    payload: { test: true },
  }
}

describe.skipIf(skip)('ClickHouseStore (integration)', () => {
  const store = new ClickHouseStore({
    url: URL ?? '',
    database: 'fleet',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  })

  test('health is true against a live server', async () => {
    expect(await store.health()).toBe(true)
  })

  test('insert then read back, and dedup by event_id', async () => {
    const id = `it-${process.env.USER ?? 'x'}-dedup`
    await store.write([event(id)])
    await store.write([event(id)]) // resend → must collapse with FINAL
    const client = store.rawClient()
    const rs = await client.query({
      query: `SELECT count() AS c FROM fleet.events FINAL WHERE event_id = {id:String}`,
      query_params: { id },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<{ c: string }>
    expect(Number(rows[0].c)).toBe(1)
    await store.close()
  })
})
