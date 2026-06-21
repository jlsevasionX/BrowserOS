/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Pure CDP-event → taxonomy-v0 envelope builders. No I/O, no clock, no randomness
 * (ts + event_id are injected) so every builder is deterministic and unit-testable.
 *
 * M2 filled the `network.request` family at metadata depth. M3 adds optional
 * already-redacted headers and body descriptors: the controller fetches+redacts
 * them and stashes them on the record; this stays pure and just shapes the output.
 */

import type {
  Initiator,
  RequestWillBeSentEvent,
  ResourceTiming,
  Response,
} from '@browseros/cdp-protocol/domains/network'
import type { BodyDescriptor, RedactedHeaders } from './redactor'
import type { TelemetryContext, TelemetryEvent } from './types'

export type NetworkOutcome = 'ok' | 'failed' | 'canceled'

/** A request fully correlated across requestWillBeSent → response → finished/failed. */
export interface NetworkRecord {
  start: RequestWillBeSentEvent
  /** From responseReceived.response, or a redirectResponse for a redirect hop. */
  response?: Response
  /** loadingFinished.encodedDataLength (total response bytes on the wire). */
  encodedDataLength?: number
  outcome: NetworkOutcome
  errorText?: string
  blockedReason?: string
  /** Redacted (M3). Present only at `headers`/`bodies` capture level. */
  requestHeaders?: RedactedHeaders
  responseHeaders?: RedactedHeaders
  /** Redacted body descriptors (M3). Present only at `bodies` capture level. */
  requestBody?: BodyDescriptor
  responseBody?: BodyDescriptor
}

/** Correlation fields resolved from the owning target/frame. */
export interface EventCorrelation {
  tab_id: number | null
  frame_id: string | null
  target_type: string | null
}

interface BuildEnvelopeArgs {
  context: TelemetryContext
  /** The browser-run id (one per server process), NOT the CDP session id. */
  sessionId: string
  correlation: EventCorrelation
  type: string
  payload: Record<string, unknown>
  ts: number
  eventId: string
}

/** Wrap a family payload in the taxonomy-v0 common envelope. */
export function buildEnvelope(args: BuildEnvelopeArgs): TelemetryEvent {
  const { context, correlation } = args
  return {
    schema_version: 0,
    event_id: args.eventId,
    ts: args.ts,
    install_id: context.install_id,
    device_id: null,
    company_id: null,
    user_id: null,
    session_id: args.sessionId,
    browseros_version: context.browseros_version,
    chromium_version: context.chromium_version,
    os: context.os,
    channel: context.channel,
    tab_id: correlation.tab_id,
    frame_id: correlation.frame_id,
    target_type: correlation.target_type,
    type: args.type,
    payload: args.payload,
  }
}

/** Build the `network.request` payload (metadata depth — no headers/bodies yet). */
export function buildNetworkPayload(
  record: NetworkRecord,
): Record<string, unknown> {
  const { start, response } = record
  const req = start.request
  const payload: Record<string, unknown> = {
    request_id: start.requestId,
    method: req.method,
    url: req.url,
    host: hostOf(req.url),
    resource_type: start.type ?? 'Other',
    initiator: normalizeInitiator(start.initiator),
    outcome: record.outcome,
    status: response?.status ?? null,
    status_text: response?.statusText ?? null,
    mime_type: response?.mimeType ?? null,
    protocol: response?.protocol ?? null,
    remote_ip: response?.remoteIPAddress ?? null,
    from_cache: response?.fromDiskCache ?? false,
    blocked_reason: record.blockedReason ?? null,
    error_text: record.errorText ?? null,
    request_bytes: req.postData ? byteLength(req.postData) : 0,
    response_bytes:
      record.encodedDataLength ?? response?.encodedDataLength ?? 0,
    timing: response?.timing ? mapTiming(response.timing) : null,
  }
  // M3: only present when the capture level kept them (already redacted).
  if (record.requestHeaders) payload.request_headers = record.requestHeaders
  if (record.responseHeaders) payload.response_headers = record.responseHeaders
  if (record.requestBody) payload.request_body = record.requestBody
  if (record.responseBody) payload.response_body = record.responseBody
  return payload
}

function normalizeInitiator(initiator: Initiator): {
  type: string
  url: string | null
} {
  return { type: initiator.type, url: initiator.url ?? null }
}

/** ResourceTiming offsets are ms relative to requestTime; emit phase durations. */
function mapTiming(t: ResourceTiming): Record<string, number> {
  const span = (start: number, end: number): number =>
    start >= 0 && end >= start ? end - start : 0
  return {
    dns: span(t.dnsStart, t.dnsEnd),
    connect: span(t.connectStart, t.connectEnd),
    ssl: span(t.sslStart, t.sslEnd),
    ttfb: span(t.sendEnd, t.receiveHeadersEnd),
    total: span(0, t.receiveHeadersEnd),
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
