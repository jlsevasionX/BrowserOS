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
