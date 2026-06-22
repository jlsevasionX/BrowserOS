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

function makeController(
  cdp: FakeCdp,
  sink: CollectingSink,
  over: Partial<typeof DEFAULT_TELEMETRY_CONFIG> = {},
): CaptureController {
  return new CaptureController(
    cdp,
    { ...DEFAULT_TELEMETRY_CONFIG, enabled: true, ...over },
    sink,
    silentLogger,
    testContext,
    'run-1',
  )
}

/** Let fire-and-forget body fetches (a couple of awaited CDP calls) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
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

    const netEvents = sink.events.filter((e) => e.type === 'network.request')
    expect(netEvents).toHaveLength(1)
    const e = netEvents[0]
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

describe('CaptureController capture levels (M3)', () => {
  test('headers level attaches redacted request/response headers, no body', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink, { captureLevel: 'headers' })
    await controller.start()
    attach(cdp)
    await Promise.resolve()

    cdp.emitSession(
      'Network.requestWillBeSent',
      requestWillBeSent({
        request: {
          url: 'https://api.test/v1',
          method: 'POST',
          headers: { Authorization: 'Bearer xyz', Accept: 'application/json' },
        },
      }),
      SID,
    )
    cdp.emitSession(
      'Network.responseReceived',
      {
        requestId: 'r1',
        response: {
          url: 'https://api.test/v1',
          status: 200,
          mimeType: 'application/json',
          headers: {
            'Set-Cookie': 'sid=abc',
            'Content-Type': 'application/json',
          },
        },
      },
      SID,
    )
    cdp.emitSession(
      'Network.loadingFinished',
      { requestId: 'r1', encodedDataLength: 5 },
      SID,
    )
    await flush()

    const netEvents = sink.events.filter((e) => e.type === 'network.request')
    expect(netEvents).toHaveLength(1)
    const p = netEvents[0].payload as Record<string, Record<string, string>>
    expect(p.request_headers.Authorization).toMatch(/^sha256:/)
    expect(p.request_headers.Accept).toBe('application/json')
    expect(p.response_headers['Set-Cookie']).toMatch(/^sha256:/)
    expect(p.response_body).toBeUndefined()
    await controller.stop()
  })

  test('bodies level fetches + redacts the response body on the owning session', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    cdp.responseBodies.set('r1', {
      body: '{"token":"sk-secret","ok":true}',
      base64Encoded: false,
    })
    const controller = makeController(cdp, sink, { captureLevel: 'bodies' })
    await controller.start()
    attach(cdp)
    await Promise.resolve()

    cdp.emitSession(
      'Network.requestWillBeSent',
      requestWillBeSent({ type: 'XHR' }),
      SID,
    )
    cdp.emitSession(
      'Network.responseReceived',
      {
        requestId: 'r1',
        response: { url: 'https://api.test/v1', status: 200, headers: {} },
      },
      SID,
    )
    cdp.emitSession(
      'Network.loadingFinished',
      { requestId: 'r1', encodedDataLength: 31 },
      SID,
    )
    await flush()

    const netEvents = sink.events.filter((e) => e.type === 'network.request')
    expect(netEvents).toHaveLength(1)
    const body = (netEvents[0].payload as Record<string, unknown>)
      .response_body as { captured: boolean; content: string; sha256: string }
    expect(body.captured).toBe(true)
    expect(body.content).toContain('"ok":true')
    expect(body.content).not.toContain('sk-secret')
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/)
    await controller.stop()
  })

  test('bodies level still emits when the body fetch misses (cache/redirect)', async () => {
    const cdp = new FakeCdp() // no seeded body ⇒ getResponseBody rejects
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink, { captureLevel: 'bodies' })
    await controller.start()

    cdp.emitSession(
      'Network.requestWillBeSent',
      requestWillBeSent({ type: 'Document' }),
      SID,
    )
    cdp.emitSession(
      'Network.loadingFinished',
      { requestId: 'r1', encodedDataLength: 9 },
      SID,
    )
    await flush()

    expect(sink.events).toHaveLength(1)
    expect(
      (sink.events[0].payload as Record<string, unknown>).response_body,
    ).toBeUndefined()
    await controller.stop()
  })
})

describe('CaptureController page.lifecycle + navigation (M5a)', () => {
  test('emits page.lifecycle opened on attach and enables Page for page targets', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()

    cdp.emitTarget('attachedToTarget', {
      sessionId: SID,
      waitingForDebugger: true,
      targetInfo: {
        type: 'page',
        tabId: 3,
        targetId: 'T-1',
        url: 'https://news.test/home',
        title: 'Home',
        openerId: 'T-0',
      },
    })
    await flush()

    expect(cdp.pageEnabledSessions).toContain(SID)
    const opened = sink.events.find((e) => e.type === 'page.lifecycle')
    expect(opened).toBeDefined()
    expect(opened?.tab_id).toBe(3)
    expect(opened?.payload).toMatchObject({
      action: 'opened',
      target_id: 'T-1',
      target_type: 'page',
      host: 'news.test',
      opener_id: 'T-0',
    })
    await controller.stop()
  })

  test('does not enable Page for non-page targets (service workers)', async () => {
    const cdp = new FakeCdp()
    const controller = makeController(cdp, new CollectingSink())
    await controller.start()
    cdp.emitTarget('attachedToTarget', {
      sessionId: 'sw-1',
      waitingForDebugger: false,
      targetInfo: {
        type: 'service_worker',
        targetId: 'SW-1',
        url: 'https://x.test/sw.js',
      },
    })
    await Promise.resolve()
    expect(cdp.pageEnabledSessions).not.toContain('sw-1')
    await controller.stop()
  })

  test('emits page.lifecycle closed on detach with the stored target info', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()
    cdp.emitTarget('attachedToTarget', {
      sessionId: SID,
      waitingForDebugger: false,
      targetInfo: {
        type: 'page',
        tabId: 5,
        targetId: 'T-9',
        url: 'https://a.test/p',
        title: 'P',
      },
    })
    await flush()

    cdp.emitTarget('detachedFromTarget', { sessionId: SID, targetId: 'T-9' })

    const closed = sink.events.find(
      (e) => e.type === 'page.lifecycle' && e.payload.action === 'closed',
    )
    expect(closed?.payload).toMatchObject({
      action: 'closed',
      target_id: 'T-9',
      target_type: 'page',
      host: 'a.test',
    })
    expect(closed?.tab_id).toBe(5)
    await controller.stop()
  })

  test('emits a navigation event on Page.frameNavigated with correlation', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()
    attach(cdp)
    await flush()

    cdp.emitSession(
      'Page.frameNavigated',
      {
        frame: {
          id: 'F-main',
          loaderId: 'L-1',
          url: 'https://shop.test/cart',
          domainAndRegistry: 'shop.test',
          securityOrigin: 'https://shop.test',
          mimeType: 'text/html',
        },
        type: 'Navigation',
      },
      SID,
    )

    const navs = sink.events.filter((e) => e.type === 'navigation')
    expect(navs).toHaveLength(1)
    const e = navs[0]
    expect(e.tab_id).toBe(3)
    expect(e.frame_id).toBe('F-main')
    expect(e.payload).toMatchObject({
      is_main_frame: true,
      url: 'https://shop.test/cart',
      host: 'shop.test',
      navigation_type: 'Navigation',
    })
    await controller.stop()
  })
})

describe('CaptureController.track (M5b push families)', () => {
  test('emits a server-originated event with a null correlation by default', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()

    controller.track('agent.action', {
      tool: 'navigate_page',
      source: 'browser',
      result: 'ok',
    })

    const e = sink.events.find((ev) => ev.type === 'agent.action')
    expect(e).toBeDefined()
    expect(e?.session_id).toBe('run-1')
    expect(e?.tab_id).toBeNull()
    expect(e?.frame_id).toBeNull()
    expect(e?.payload).toMatchObject({ tool: 'navigate_page', result: 'ok' })
    await controller.stop()
  })

  test('honors a supplied correlation', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const controller = makeController(cdp, sink)
    await controller.start()

    controller.track('agent.action', { tool: 'click' }, { tab_id: 12 })

    const e = sink.events.find((ev) => ev.type === 'agent.action')
    expect(e?.tab_id).toBe(12)
    await controller.stop()
  })
})

describe('CaptureController shipper lifecycle', () => {
  test('starts and stops the shipper with the capture lifecycle', async () => {
    const cdp = new FakeCdp()
    const sink = new CollectingSink()
    const calls: string[] = []
    const shipper = {
      start: () => calls.push('start'),
      stop: async () => {
        calls.push('stop')
      },
    }
    const controller = new CaptureController(
      cdp,
      {
        enabled: true,
        captureLevel: 'metadata',
        bodyMaxBytes: 1024,
        walDir: '',
        ingestUrl: 'x',
        ingestToken: '',
        shipIntervalMs: 1000,
      },
      sink,
      silentLogger,
      testContext,
      'run-1',
      shipper,
    )
    await controller.start()
    await controller.stop()
    expect(calls).toEqual(['start', 'stop'])
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
