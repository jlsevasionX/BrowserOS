import type { Envelope } from '../envelope'

/** The swappable destination. ClickHouse today; OTel/Redpanda/managed later. */
export interface StoreWriter {
  write(events: Envelope[]): Promise<void>
  health(): Promise<boolean>
  close(): Promise<void>
}

/** In-memory store for tests and the `docker compose` skeleton. */
export class MemoryStore implements StoreWriter {
  readonly events: Envelope[] = []
  async write(events: Envelope[]): Promise<void> {
    this.events.push(...events)
  }
  async health(): Promise<boolean> {
    return true
  }
  async close(): Promise<void> {}
}
