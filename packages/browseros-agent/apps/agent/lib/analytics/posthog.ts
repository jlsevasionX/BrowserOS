import posthog from 'posthog-js'
import 'posthog-js/dist/posthog-recorder'
import { env } from '../env'

// Fork: hard kill-switch for vendor analytics. No PostHog (incl. session
// replay/autocapture) may egress to BrowserOS infra, even if keys are inlined.
// This fork captures its own first-party telemetry instead.
const VENDOR_TELEMETRY_DISABLED = true

if (
  !VENDOR_TELEMETRY_DISABLED &&
  env.VITE_PUBLIC_POSTHOG_KEY &&
  env.VITE_PUBLIC_POSTHOG_HOST
) {
  posthog.init(env.VITE_PUBLIC_POSTHOG_KEY, {
    api_host: env.VITE_PUBLIC_POSTHOG_HOST,
    person_profiles: 'identified_only',
    disable_external_dependency_loading: true,
    disable_session_recording: false,
    capture_pageview: true,
    autocapture: true,
    session_recording: {
      maskAllInputs: true,
    },
    persistence: 'localStorage',
    loaded: (posthog) => {
      posthog.register({
        extension_version: chrome.runtime.getManifest().version,
        ui_context: window.location.pathname,
      })
    },
  })
}

export { posthog }
