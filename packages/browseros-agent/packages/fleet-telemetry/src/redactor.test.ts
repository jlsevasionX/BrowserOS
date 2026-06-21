/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from 'bun:test'
import { Redactor } from './redactor'

const r = new Redactor(64 * 1024)

describe('Redactor.headers', () => {
  test('redacts sensitive headers to a sha256 token, keeps the rest', () => {
    const out = r.headers({
      Authorization: 'Bearer secret-abc',
      Cookie: 'sid=123',
      'X-Acme-Api-Key': 'k-9',
      'Content-Type': 'application/json',
      Accept: '*/*',
    })
    expect(out['Content-Type']).toBe('application/json')
    expect(out.Accept).toBe('*/*')
    expect(out.Authorization).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(out.Cookie).toMatch(/^sha256:/)
    expect(out['X-Acme-Api-Key']).toMatch(/^sha256:/)
    // Same value hashes deterministically.
    expect(
      r.headers({ Authorization: 'Bearer secret-abc' }).Authorization,
    ).toBe(out.Authorization)
  })

  test('coerces non-string header values and tolerates undefined', () => {
    expect(r.headers(undefined)).toEqual({})
    expect(r.headers({ 'X-Count': 5 as unknown as string })['X-Count']).toBe(
      '5',
    )
  })
})

describe('Redactor.body', () => {
  test('scrubs credentials and PII from a captured text body', () => {
    const raw = JSON.stringify({
      password: 'hunter2',
      jwt: 'eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSM',
      card: '4111 1111 1111 1111',
      note: 'keep me',
    })
    const d = r.body(raw, false, 'XHR')
    expect(d.captured).toBe(true)
    expect(d.binary).toBe(false)
    expect(d.size).toBe(Buffer.byteLength(raw))
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(d.content).toContain('keep me')
    expect(d.content).not.toContain('hunter2')
    expect(d.content).not.toContain('4111 1111 1111 1111')
    expect(d.content).not.toContain('eyJhbGciOiJ')
  })

  test('redacts only Luhn-valid card numbers, not long ID/version digit runs', () => {
    // 4111… is a Luhn-valid test card; the others are realistic false positives
    // seen in the M3 live smoke (device_id, FPI token, AMP version).
    const raw = JSON.stringify({
      card: '4111111111111111',
      device_id: '1234567890123456',
      fpi: '9876543210987654',
    })
    const d = r.body(raw, false, 'XHR')
    expect(d.content).not.toContain('4111111111111111')
    expect(d.content).toContain('[redacted:card]')
    expect(d.content).toContain('1234567890123456')
    expect(d.content).toContain('9876543210987654')
  })

  test('keeps binary (base64) bodies as metadata + hash only', () => {
    const b64 = Buffer.from([0, 1, 2, 3, 255]).toString('base64')
    const d = r.body(b64, true, 'Fetch')
    expect(d.captured).toBe(true)
    expect(d.binary).toBe(true)
    expect(d.content).toBeNull()
    expect(d.size).toBe(5)
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('samples high-volume types to metadata-only with an integrity hash', () => {
    const d = r.body('....png-bytes....', false, 'Image')
    expect(d.captured).toBe(false)
    expect(d.content).toBeNull()
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(d.size).toBeGreaterThan(0)
  })

  test('truncates content past the byte cap but reports the true size', () => {
    const small = new Redactor(16)
    const raw = 'x'.repeat(100)
    const d = small.body(raw, false, 'Document')
    expect(d.truncated).toBe(true)
    expect(d.size).toBe(100)
    expect(Buffer.byteLength(d.content ?? '')).toBeLessThanOrEqual(16)
  })

  test('treats empty/absent bodies as no-body', () => {
    expect(r.body('', false, 'XHR').captured).toBe(false)
    expect(r.body(null, false, 'XHR').sha256).toBeNull()
    expect(r.body(undefined, false, 'XHR').size).toBe(0)
  })
})

describe('Redactor.shouldCaptureBody', () => {
  test('captures text resource types, samples binary/high-volume ones', () => {
    expect(r.shouldCaptureBody('Document')).toBe(true)
    expect(r.shouldCaptureBody('XHR')).toBe(true)
    expect(r.shouldCaptureBody('Fetch')).toBe(true)
    expect(r.shouldCaptureBody('Image')).toBe(false)
    expect(r.shouldCaptureBody('Font')).toBe(false)
    expect(r.shouldCaptureBody(undefined)).toBe(false)
  })
})
