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
