# fleet-central

Central telemetry pipeline for the BrowserOS fork. Runs locally in Docker today
and deploys to AWS by changing only `.env`. The device knows only an ingest
URL + token; everything here is replaceable without touching devices.

## Run locally
1. `cp .env.example .env` and set a strong `INGEST_TOKEN`.
2. `docker compose up --build`
3. Health: `curl localhost:9400/health` → `{"status":"ok","store":"connected"}`.

## Point a device at it
On the device (from `packages/browseros-agent`):
```
BROWSEROS_TELEMETRY_ENABLED=true \
BROWSEROS_TELEMETRY_LEVEL=bodies \
BROWSEROS_TELEMETRY_INGEST_URL=http://localhost:9400 \
BROWSEROS_TELEMETRY_INGEST_TOKEN=<same as .env> \
bun run dev:watch
```

## Query
```
docker compose exec clickhouse clickhouse-client \
  --query "SELECT type, count() FROM fleet.events GROUP BY type"
```

## Future (central-side only, device frozen)
Insert OTel Collector + Redpanda in front of ingest, or add a `StoreWriter`
that produces to Redpanda; swap ClickHouse to managed via env. None of this
touches the device.
