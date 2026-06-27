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
