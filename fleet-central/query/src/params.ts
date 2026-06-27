export interface QueryParams {
  from: number // epoch ms
  to: number // epoch ms
  device_id?: string
  session_id?: string
  install_id?: string
  channel?: string
  os?: string
  limit: number
  offset: number
}

const DAY_MS = 86_400_000
const MAX_LIMIT = 1000

/** Accepts epoch-ms (digits) or an ISO-8601 string. Returns epoch ms or null. */
function parseTime(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null
  if (/^\d+$/.test(v.trim())) return Number(v.trim())
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v.trim() === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function parseCommonParams(
  q: Record<string, string | undefined>,
): { ok: true; value: QueryParams } | { ok: false; error: string } {
  const now = Date.now()
  const toRaw = q.to
  const fromRaw = q.from

  const to = toRaw === undefined ? now : parseTime(toRaw)
  if (to === null) return { ok: false, error: 'invalid `to`' }
  const from = fromRaw === undefined ? to - DAY_MS : parseTime(fromRaw)
  if (from === null) return { ok: false, error: 'invalid `from`' }
  if (from > to) return { ok: false, error: '`from` must be <= `to`' }

  const opt = (k: string): string | undefined => {
    const v = q[k]
    return v === undefined || v.trim() === '' ? undefined : v
  }

  return {
    ok: true,
    value: {
      from,
      to,
      device_id: opt('device_id'),
      session_id: opt('session_id'),
      install_id: opt('install_id'),
      channel: opt('channel'),
      os: opt('os'),
      limit: clampInt(q.limit, 100, 1, MAX_LIMIT),
      offset: clampInt(q.offset, 0, 0, 4294967295),
    },
  }
}
