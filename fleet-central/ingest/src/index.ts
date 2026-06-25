import { createApp } from './app'
import { ClickHouseStore } from './store/clickhouse-store'

const port = Number(process.env.INGEST_PORT ?? 9400)
const token = process.env.INGEST_TOKEN
if (!token) {
  console.error('INGEST_TOKEN is required')
  process.exit(1)
}

const store = new ClickHouseStore({
  url: process.env.CLICKHOUSE_URL ?? 'http://clickhouse:8123',
  database: process.env.CLICKHOUSE_DB ?? 'fleet',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
})

const app = createApp({ store, token })
console.log(`fleet-ingest listening on :${port}`)
export default { port, fetch: app.fetch }
