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
    const client = reader.rawClient()
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
    await client.insert({
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
