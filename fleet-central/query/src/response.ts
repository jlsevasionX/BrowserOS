import type { QueryParams } from './params'

export function buildMeta(params: QueryParams, rowCount: number, startedAt: number) {
  return {
    range: { from: params.from, to: params.to },
    filters: {
      device_id: params.device_id ?? null,
      session_id: params.session_id ?? null,
      install_id: params.install_id ?? null,
      channel: params.channel ?? null,
      os: params.os ?? null,
    },
    row_count: rowCount,
    elapsed_ms: Date.now() - startedAt,
  }
}
