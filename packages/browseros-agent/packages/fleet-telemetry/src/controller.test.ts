/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_TELEMETRY_CONFIG } from './config'
import { CaptureController } from './controller'
import {
  CollectingSink,
  FakeCdp,
  silentLogger,
  testContext,
} from './test-helpers'

const SID = 'session-A'

function makeController(cdp: FakeCdp, sink: CollectingSink): CaptureController {
  return new CaptureController(
    cdp,
    { ...DEFAULT_TELEMETRY_CONFIG, enabled: true },
    sink,
    silentLogger,
    testContext,
    'run-1',
  )
}

function attach(cdp: FakeCdp, over: Record<string, unknown> = {}): void {
  cdp.emitTarget('attachedToTarget', {
    sessionId: SID,
    waitingForDebugger: true,
    targetInfo: { type: 'page', tabId: 3, ...over },
  })
}

function requestWillBeSent(extra: Record<string, unknown> = {}) {
  return {
    requestId: 'r1',
    request: { url: 'https://api.test/v1?x=1', method: 'GET', headers: {} },
    initiator: { type: 'script' },
    type: 'Fetch',
    frameId: 'f1',
    ...extra,
  }
}

describe('CaptureController attach handling', () => {
  test('arms auto-attach on start and enables Network before releasing', async () => {
    const cdp = new FakeCdp()
    const controller = makeController(cdp, new CollectingSink())
    await controller.start()
    expect(cdp.autoAttachCalls).toBe(1)

    attach(cdp)
    // onAttached is async; let its awaits settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(cdp.enabledSessions).toContain(SID)
    expect(cdp.releasedSessions).toContain(SID)

    await controller.stop()
  })
})

describe('CaptureController network correlation', () => {
  test('emits one network.request on a completed lifecycle with correlation', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()
    attach(cdp)
    await Promise.resolve()

    cdp.emitSession('Network.requestWillBeSent', requestWillBeSent(), SID)
    cdp.emitSession(
      'Network.responseReceived',
      {
        requestId: 'r1',
        response: {
          url: 'https://api.test/v1',
          status: 200,
          mimeType: 'application/json',
        },
      },
      SID,
    )
    cdp.emitSession(
      'Network.loadingFinished',
      { requestId: 'r1', encodedDataLength: 1234 },
      SID,
    )

    expect(sink.events).toHaveLength(1)
    const e = sink.events[0]
    expect(e.type).toBe('network.request')
    expect(e.session_id).toBe('run-1')
    expect(e.tab_id).toBe(3)
    expect(e.target_type).toBe('page')
    expect(e.frame_id).toBe('f1')
    expect(e.payload).toMatchObject({
      method: 'GET',
      host: 'api.test',
      outcome: 'ok',
      status: 200,
      response_bytes: 1234,
    })

    await controller.stop()
  })

  test('emits a failed outcome on loadingFailed', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()

    cdp.emitSession('Network.requestWillBeSent', requestWillBeSent(), SID)
    cdp.emitSession(
      'Network.loadingFailed',
      { requestId: 'r1', errorText: 'net::ERR_FAILED', canceled: false },
      SID,
    )

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({
      outcome: 'failed',
      error_text: 'net::ERR_FAILED',
    })
    await controller.stop()
  })

  test('emits the prior hop when a redirect reuses the requestId', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()

    cdp.emitSession('Network.requestWillBeSent', requestWillBeSent(), SID)
    // Redirect: same requestId, carries the previous hop's response.
    cdp.emitSession(
      'Network.requestWillBeSent',
      requestWillBeSent({
        request: { url: 'https://api.test/v2', method: 'GET', headers: {} },
        redirectResponse: {
          url: 'https://api.test/v1',
          status: 301,
          mimeType: 'text/html',
        },
      }),
      SID,
    )
    cdp.emitSession(
      'Network.loadingFinished',
      { requestId: 'r1', encodedDataLength: 10 },
      SID,
    )

    // One event for the redirect hop, one for the final hop.
    expect(sink.events).toHaveLength(2)
    expect(sink.events[0].payload).toMatchObject({ status: 301, outcome: 'ok' })
    expect(sink.events[1].payload).toMatchObject({
      url: 'https://api.test/v2',
      outcome: 'ok',
    })
    await controller.stop()
  })
})

describe('CaptureController reconnect', () => {
  test('re-arms auto-attach when the epoch changes', async () => {
    const cdp = new FakeCdp()
    const controller = makeController(cdp, new CollectingSink())
    await controller.start()
    expect(cdp.autoAttachCalls).toBe(1)

    cdp.bumpEpoch()
    // Invoke the epoch check directly rather than waiting on the poll timer.
    ;(controller as unknown as { checkEpoch(): void }).checkEpoch()
    await Promise.resolve()
    await Promise.resolve()
    expect(cdp.autoAttachCalls).toBe(2)

    await controller.stop()
  })
})
