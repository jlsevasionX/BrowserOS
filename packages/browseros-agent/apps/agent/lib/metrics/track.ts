import { getBrowserOSAdapter } from '@/lib/browseros/adapter'
import { getAgentServerUrl } from '@/lib/browseros/helpers'

const versions = {
  extension: null as string | null,
  chromium: null as string | null,
  browseros: null as string | null,
}

/**
 * Fork: forward the event to our first-party server pipeline as `app.event`.
 * Best-effort and fire-and-forget — never block or surface UI errors, and a
 * missing server port (early startup) is a silent no-op.
 */
function forwardToFleet(
  eventName: string,
  properties: Record<string, unknown>,
): void {
  getAgentServerUrl()
    .then((base) =>
      fetch(`${base}/telemetry/app-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: eventName, properties }),
        keepalive: true,
      }),
    )
    .catch(() => {})
}

const adapter = getBrowserOSAdapter()
adapter
  .getVersion()
  .then((v) => {
    versions.chromium = v
  })
  .catch(() => {})
adapter
  .getBrowserosVersion()
  .then((v) => {
    versions.browseros = v
  })
  .catch(() => {})

/** @public */
export function track(
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  if (!versions.extension) {
    versions.extension = chrome.runtime.getManifest().version
  }

  const enriched = {
    extension_version: versions.extension,
    ...(versions.chromium && { chromium_version: versions.chromium }),
    ...(versions.browseros && { browseros_version: versions.browseros }),
    ...properties,
  }

  adapter.logMetric(eventName, enriched).catch(() => {})
  forwardToFleet(eventName, enriched)
}
