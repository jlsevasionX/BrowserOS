CREATE DATABASE IF NOT EXISTS fleet;

CREATE TABLE IF NOT EXISTS fleet.events (
  event_id          String,
  ts                DateTime64(3),
  ingested_at       DateTime64(3) DEFAULT now64(3),
  schema_version    UInt8,
  install_id        String,
  device_id         Nullable(String),
  company_id        Nullable(String),
  user_id           Nullable(String),
  session_id        String,
  browseros_version String,
  chromium_version  String,
  os                LowCardinality(String),
  channel           LowCardinality(String),
  tab_id            Nullable(Int64),
  frame_id          Nullable(String),
  target_type       Nullable(String),
  type              LowCardinality(String),
  payload           String
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (type, ts, event_id);
