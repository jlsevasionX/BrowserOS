/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Human-readable view of the on-disk telemetry WAL — so you can SEE what the
 * capture layer recorded instead of squinting at raw JSONL.
 *
 *   bun packages/fleet-telemetry/scripts/inspect.ts            # summary
 *   bun packages/fleet-telemetry/scripts/inspect.ts --samples 5
 *   bun packages/fleet-telemetry/scripts/inspect.ts --grep amazon
 *   bun packages/fleet-telemetry/scripts/inspect.ts --dir /path/to/telemetry
 *   bun packages/fleet-telemetry/scripts/inspect.ts --bodies   # only events with a captured body
 *
 * Default dir: ~/.browseros-dev/telemetry (dev). Use --dir for prod (~/.browseros/telemetry).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface Args {
  dir: string
  samples: number
  grep: string | null
  bodiesOnly: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dir: join(homedir(), '.browseros-dev', 'telemetry'),
    samples: 3,
    grep: null,
    bodiesOnly: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--dir') a.dir = argv[++i]
    else if (v === '--samples') a.samples = Number.parseInt(argv[++i], 10) || 0
    else if (v === '--grep') a.grep = argv[++i]
    else if (v === '--bodies') a.bodiesOnly = true
  }
  return a
}

function listFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  // Rotated segments first (oldest→newest by seq), then the active file last.
  const rotated = entries
    .filter((f) => /^events-\d+\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f))
  const active = entries.includes('events.jsonl')
    ? [join(dir, 'events.jsonl')]
    : []
  return [...rotated, ...active]
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function top(map: Map<string, number>, n: number): Array<[string, number]> {
  return [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, n)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length)
}

const args = parseArgs(process.argv.slice(2))
const files = listFiles(args.dir)

if (files.length === 0) {
  console.log(`No WAL files in ${args.dir}`)
  console.log(
    'Is telemetry enabled? Start with: BROWSEROS_TELEMETRY_ENABLED=true BROWSEROS_TELEMETRY_LEVEL=bodies bun run dev:watch',
  )
  process.exit(0)
}

const byType = new Map<string, number>()
const byHost = new Map<string, number>()
const byResource = new Map<string, number>()
const byStatus = new Map<string, number>()
const byOutcome = new Map<string, number>()
let total = 0
let badJson = 0
let withReqHeaders = 0
let redactedHeaderValues = 0
let bodiesCaptured = 0
let bodiesTruncated = 0
let bodiesBinary = 0
let bodyBytesOnWire = 0
let redactionMarkers = 0
const samples: Array<Record<string, unknown>> = []
let diskBytes = 0

for (const file of files) {
  diskBytes += statSync(file).size
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (args.grep && !line.includes(args.grep)) continue
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line)
    } catch {
      badJson++
      continue
    }
    const payload = (e.payload ?? {}) as Record<string, unknown>
    const rb = payload.response_body as
      | {
          captured?: boolean
          size?: number
          truncated?: boolean
          binary?: boolean
        }
      | undefined
    if (args.bodiesOnly && !rb?.captured) continue

    total++
    bump(byType, String(e.type))
    if (e.type === 'network.request') {
      bump(byHost, String(payload.host ?? '?'))
      bump(byResource, String(payload.resource_type ?? '?'))
      bump(byStatus, String(payload.status ?? 'null'))
      bump(byOutcome, String(payload.outcome ?? '?'))
    }
    const reqH = payload.request_headers as Record<string, string> | undefined
    const resH = payload.response_headers as Record<string, string> | undefined
    if (reqH) withReqHeaders++
    for (const h of [reqH, resH]) {
      if (!h) continue
      for (const val of Object.values(h)) {
        if (typeof val === 'string' && val.startsWith('sha256:')) {
          redactedHeaderValues++
        }
      }
    }
    if (rb?.captured) {
      bodiesCaptured++
      bodyBytesOnWire += rb.size ?? 0
      if (rb.truncated) bodiesTruncated++
      if (rb.binary) bodiesBinary++
    }
    const content = (rb as { content?: string } | undefined)?.content
    if (typeof content === 'string' && content.includes('[redacted')) {
      redactionMarkers++
    }
    if (samples.length < args.samples && rb?.captured && content) {
      samples.push(e)
    }
  }
}

const line = '─'.repeat(60)
console.log(line)
console.log(`Fleet telemetry WAL  ·  ${args.dir}`)
console.log(
  `${files.length} file(s) · ${fmtBytes(diskBytes)} on disk · ${total} events${
    args.grep ? ` matching "${args.grep}"` : ''
  }${badJson ? ` · ${badJson} unparseable` : ''}`,
)
console.log(line)

console.log('\nEvents by type:')
for (const [k, v] of top(byType, 20)) console.log(`  ${pad(k, 26)} ${v}`)

if ((byType.get('network.request') ?? 0) > 0) {
  console.log('\nTop hosts:')
  for (const [k, v] of top(byHost, 15)) console.log(`  ${pad(k, 40)} ${v}`)
  console.log('\nBy resource type:')
  for (const [k, v] of top(byResource, 20)) console.log(`  ${pad(k, 16)} ${v}`)
  console.log('\nBy outcome / status:')
  for (const [k, v] of top(byOutcome, 5))
    console.log(`  outcome ${pad(k, 10)} ${v}`)
  for (const [k, v] of top(byStatus, 8))
    console.log(`  status  ${pad(k, 10)} ${v}`)
}

console.log('\nRedaction & bodies:')
console.log(`  events with request headers : ${withReqHeaders}`)
console.log(
  `  redacted header values      : ${redactedHeaderValues}  (sha256: tokens)`,
)
console.log(
  `  bodies captured             : ${bodiesCaptured}  (${fmtBytes(bodyBytesOnWire)} original)`,
)
console.log(`  bodies truncated (> cap)    : ${bodiesTruncated}`)
console.log(`  bodies binary (hash only)   : ${bodiesBinary}`)
console.log(`  bodies with [redacted] marks: ${redactionMarkers}`)

if (samples.length > 0) {
  console.log(`\nSample captured bodies (first ${samples.length}):`)
  for (const e of samples) {
    const p = e.payload as Record<string, unknown>
    const rb = p.response_body as {
      size: number
      content: string
      sha256: string
    }
    console.log(line)
    console.log(`  ${p.method} ${String(p.url).slice(0, 80)}`)
    console.log(
      `  status ${p.status} · ${p.mime_type} · ${fmtBytes(rb.size)} · sha256 ${rb.sha256.slice(0, 12)}…`,
    )
    console.log(`  body: ${JSON.stringify(rb.content.slice(0, 160))}`)
  }
}
console.log(line)
