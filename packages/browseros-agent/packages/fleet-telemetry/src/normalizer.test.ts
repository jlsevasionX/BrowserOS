/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from 'bun:test'
import type {
  RequestWillBeSentEvent,
  Response,
} from '@browseros/cdp-protocol/domains/network'
import {
  buildEnvelope,
  buildNetworkPayload,
  type NetworkRecord,
} from './normalizer'
import { testContext } from './test-helpers'

function rwbs(
  over: Partial<RequestWillBeSentEvent> = {},
): RequestWillBeSentEvent {
  return {
    requestId: 'req-1',
    request: {
      url: 'https://example.com/api?token=secret',
      method: 'GET',
      headers: {},
      initialPriority: 'High',
      referrerPolicy: 'no-referrer',
    },
    initiator: { type: 'script', url: 'https://example.com/app.js' },
    type: 'XHR',
    frameId: 'frame-9',
    ...over,
  } as unknown as RequestWillBeSentEvent
}

function response(over: Partial<Response> = {}): Response {
  return {
    url: 'https://example.com/api',
    status: 200,
    statusText: 'OK',
    headers: {},
    mimeType: 'application/json',
    protocol: 'h2',
    remoteIPAddress: '1.2.3.4',
    encodedDataLength: 512,
    ...over,
  } as unknown as Response
}

describe('buildNetworkPayload', () => {
  test('maps a completed request to metadata fields', () => {
    const record: NetworkRecord = {
      start: rwbs(),
      response: response(),
      encodedDataLength: 999,
      outcome: 'ok',
    }
    const p = buildNetworkPayload(record)
    expect(p).toMatchObject({
      request_id: 'req-1',
      method: 'GET',
      host: 'example.com',
      resource_type: 'XHR',
      initiator: { type: 'script', url: 'https://example.com/app.js' },
      outcome: 'ok',
      status: 200,
      mime_type: 'application/json',
      protocol: 'h2',
      remote_ip: '1.2.3.4',
      from_cache: false,
      response_bytes: 999,
      blocked_reason: null,
      error_text: null,
    })
    // M2 is metadata-only: no headers/bodies leak through.
    expect(p).not.toHaveProperty('request_headers')
    expect(p).not.toHaveProperty('response_body')
  })

  test('represents a failed request with null response fields', () => {
    const record: NetworkRecord = {
      start: rwbs(),
      outcome: 'failed',
      errorText: 'net::ERR_TIMED_OUT',
    }
    const p = buildNetworkPayload(record)
    expect(p.outcome).toBe('failed')
    expect(p.status).toBeNull()
    expect(p.error_text).toBe('net::ERR_TIMED_OUT')
    expect(p.response_bytes).toBe(0)
  })

  test('counts request body bytes when postData is present', () => {
    const record: NetworkRecord = {
      start: rwbs({
        request: {
          url: 'https://example.com/submit',
          method: 'POST',
          headers: {},
          postData: 'héllo',
          initialPriority: 'High',
          referrerPolicy: 'no-referrer',
          // biome-ignore lint/suspicious/noExplicitAny: partial test fixture
        } as any,
      }),
      outcome: 'ok',
    }
    const p = buildNetworkPayload(record)
    // "héllo" = 6 UTF-8 bytes (é is 2 bytes).
    expect(p.request_bytes).toBe(6)
  })
})

describe('buildEnvelope', () => {
  test('stamps the taxonomy-v0 common envelope', () => {
    const event = buildEnvelope({
      context: testContext,
      sessionId: 'run-42',
      correlation: { tab_id: 7, frame_id: 'frame-9', target_type: 'page' },
      type: 'network.request',
      payload: { request_id: 'req-1' },
      ts: 1718900000000,
      eventId: 'evt-1',
    })
    expect(event).toMatchObject({
      schema_version: 0,
      event_id: 'evt-1',
      ts: 1718900000000,
      install_id: 'install-test',
      device_id: null,
      company_id: null,
      session_id: 'run-42',
      browseros_version: '1.2.3',
      os: 'macos',
      channel: 'dev',
      tab_id: 7,
      frame_id: 'frame-9',
      target_type: 'page',
      type: 'network.request',
    })
  })
})
