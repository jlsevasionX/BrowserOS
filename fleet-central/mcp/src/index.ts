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
