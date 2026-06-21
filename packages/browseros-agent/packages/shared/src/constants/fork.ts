/**
 * @license
 * Copyright 2026 Fleet Telemetry (BrowserOS fork — additive layer)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Fork divergence flags.
 */

/**
 * Hard kill-switch for upstream BrowserOS vendor analytics (PostHog server +
 * agent UI, Sentry). When true, those clients are never constructed, so no
 * telemetry can egress to BrowserOS-team infrastructure even if API keys / a
 * DSN are inlined at build time.
 *
 * This fork captures its own fleet telemetry (packages/fleet-telemetry) and
 * ships it ONLY to first-party infrastructure (Fase 3). It must never send
 * analytics to any third party. Flip to false only to restore upstream
 * vendor telemetry, which we never want.
 */
export const VENDOR_TELEMETRY_DISABLED = true
