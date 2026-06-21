/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Redactor — mandatory on-device scrub that runs BEFORE the sink whenever we keep
 * more than metadata. Bodies never leave the host raw: secret-bearing headers are
 * reduced to presence + a salt-free sha256, body content is regex-scrubbed for
 * common credential/PII shapes, and everything is size-capped. A sha256 of the
 * ORIGINAL (pre-scrub) body is always retained so dedup/integrity survive
 * redaction (taxonomy v0 §3).
 *
 * Pure + deterministic: the only external call is node:crypto hashing, which is a
 * pure function of its input, so every output is unit-testable without mocks.
 */

import { createHash } from 'node:crypto'

/** Redacted header map: sensitive values replaced with a `sha256:<hex8>` token. */
export type RedactedHeaders = Record<string, string>

/** Body capture descriptor stored on the envelope (taxonomy v0). */
export interface BodyDescriptor {
  /** False = sampled/skipped for this resource type; only size+sha256 may exist. */
  captured: boolean
  /** Raw (pre-scrub, pre-cap) byte size of the original body. */
  size: number
  /** sha256 of the raw original body; null when there was no body. */
  sha256: string | null
  /** Scrubbed + capped text content; null for binary or non-captured bodies. */
  content: string | null
  /** True when the stored content was truncated to the byte cap. */
  truncated: boolean
  /** True when the body was binary (base64) and therefore not stored as text. */
  binary: boolean
}

/** Empty descriptor for requests/responses that carry no body. */
const NO_BODY: BodyDescriptor = {
  captured: false,
  size: 0,
  sha256: null,
  content: null,
  truncated: false,
  binary: false,
}

/**
 * Header names whose VALUE is never stored verbatim. Matched case-insensitively;
 * the suffix/substring rules catch vendor variants (`x-acme-api-key`, etc.).
 */
const SENSITIVE_HEADERS_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'proxy-authenticate',
  'www-authenticate',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
])

function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase()
  if (SENSITIVE_HEADERS_EXACT.has(n)) return true
  return (
    n.endsWith('-api-key') ||
    n.endsWith('-token') ||
    n.includes('secret') ||
    n.includes('password')
  )
}

/**
 * Resource types whose bodies we keep at `bodies` level. High-volume binary types
 * (Image/Media/Font/Ping) are sampled to metadata-only by default — they carry no
 * forensic value and would dominate WAL volume (taxonomy v0 §3.3).
 */
const BODY_CAPTURE_TYPES = new Set([
  'Document',
  'XHR',
  'Fetch',
  'Script',
  'Stylesheet',
  'Manifest',
  'EventSource',
])

type Replacer = string | ((match: string) => string)

/** Luhn check — gates the card scrubber so long ID/version digit runs aren't redacted. */
function passesLuhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

/**
 * Replace a candidate digit run with `[redacted:card]` ONLY if it Luhn-validates.
 * Without this, device_ids, version strings, and numeric tokens (all common long
 * digit runs) get false-flagged as payment cards — discovered in M3 live smoke.
 */
function redactCardCandidate(match: string): string {
  const digits = match.replace(/[ -]/g, '')
  if (digits.length < 13 || digits.length > 19) return match
  return passesLuhn(digits) ? '[redacted:card]' : match
}

/** Regex scrubbers applied to text bodies, in order. Each replaces the secret. */
const SCRUBBERS: Array<[RegExp, Replacer]> = [
  // JWTs (header.payload.signature, base64url segments).
  [
    /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    '[redacted:jwt]',
  ],
  // Bearer tokens.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]'],
  // password/token/secret/api_key JSON or form fields → keep key, drop value.
  [
    /("(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)"\s*:\s*")[^"]*(")/gi,
    '$1[redacted]$2',
  ],
  [
    /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|client[_-]?secret)=[^&\s]+/gi,
    '$1=[redacted]',
  ],
  // Payment card numbers (13–19 digits, optional spaces/dashes) — Luhn-gated.
  [/\b(?:\d[ -]?){13,19}\b/g, redactCardCandidate],
  // IBANs.
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[redacted:iban]'],
]

function sha256hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Truncate a UTF-8 string to at most `maxBytes`, never splitting a code point. */
function capToBytes(
  s: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (byteLength(s) <= maxBytes) return { text: s, truncated: false }
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes)
  // toString on a sliced buffer drops a trailing partial code point cleanly.
  return { text: buf.toString('utf8'), truncated: true }
}

function scrub(text: string): string {
  let out = text
  for (const [re, repl] of SCRUBBERS) {
    out =
      typeof repl === 'string' ? out.replace(re, repl) : out.replace(re, repl)
  }
  return out
}

export class Redactor {
  constructor(private readonly bodyMaxBytes: number) {}

  /** Whether a response body should be fetched+stored for this resource type. */
  shouldCaptureBody(resourceType: string | undefined): boolean {
    return BODY_CAPTURE_TYPES.has(resourceType ?? 'Other')
  }

  /** Reduce a CDP header map: sensitive values → `sha256:<hex8>`, rest verbatim. */
  headers(raw: Record<string, unknown> | undefined): RedactedHeaders {
    const out: RedactedHeaders = {}
    if (!raw) return out
    for (const [name, value] of Object.entries(raw)) {
      const v = typeof value === 'string' ? value : String(value)
      out[name] = isSensitiveHeader(name)
        ? `sha256:${sha256hex(v).slice(0, 16)}`
        : v
    }
    return out
  }

  /**
   * Turn a raw body into a stored descriptor: hash the original, scrub+cap text,
   * keep binary as metadata-only. `raw` is the decoded text (base64Encoded=false)
   * or a base64 string (base64Encoded=true).
   */
  body(
    raw: string | null | undefined,
    base64Encoded: boolean,
    resourceType: string | undefined,
  ): BodyDescriptor {
    if (raw === null || raw === undefined || raw.length === 0) return NO_BODY
    if (!this.shouldCaptureBody(resourceType)) {
      // Sampled out: retain integrity hash + size, drop content.
      const bytes = base64Encoded ? Buffer.from(raw, 'base64') : raw
      return {
        captured: false,
        size: base64Encoded ? (bytes as Buffer).length : byteLength(raw),
        sha256: sha256hex(bytes),
        content: null,
        truncated: false,
        binary: base64Encoded,
      }
    }
    if (base64Encoded) {
      const bytes = Buffer.from(raw, 'base64')
      return {
        captured: true,
        size: bytes.length,
        sha256: sha256hex(bytes),
        content: null,
        truncated: false,
        binary: true,
      }
    }
    const size = byteLength(raw)
    const scrubbed = scrub(raw)
    const { text, truncated } = capToBytes(scrubbed, this.bodyMaxBytes)
    return {
      captured: true,
      size,
      sha256: sha256hex(raw),
      content: text,
      truncated,
      binary: false,
    }
  }
}
