/** Serializes defined args to a `?k=v&...` querystring. Skips undefined/null/''. */
export function buildQuery(args: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
