# ADR-0001 — Network capture mechanism (fleet telemetry)

**Status:** Proposed (Fase 1 spike completed 2026-06-21)
**Context:** We need to capture "every connection" each browser makes, fleet-wide,
into our own telemetry pipeline. The old plan assumed capture would live in
`controller-ext`, but upstream removed that component. This ADR records what the
Fase 1 spike proved and recommends the capture mechanism.

## Spike

Throwaway observer `apps/server/src/browser/core/observer/network-spike.ts`,
wired via the existing `BrowserSession` `onSessionAttached` hook (additive:
`browser.ts` accepts optional hooks, constructed in `main.ts`). On each attached
page session it calls `Network.enable()` and correlates
`requestWillBeSent → responseReceived → loadingFinished/Failed`, logging one
normalized line per request.

## What the spike proved (amazon.com, 294 requests captured)

- **Rich, complete capture on attached pages.** Captured method (GET/POST/HEAD),
  status (200/202/204), resource type (Image/Font/Script/XHR/Fetch/Ping/
  Stylesheet/Document/Other), MIME type, encoded byte size, and full URL.
- **Cross-origin + third parties.** 7 distinct hosts incl. third-party analytics
  (`unagi.amazon.com`, `*.awswaf.com`, `fls-na.amazon.com`) — not just the
  first-party origin.
- **Beacons and XHR/fetch.** POST analytics beacons (`unagi`) and JSON XHR/fetch
  (`/puff/content`) were captured — exactly the "connections" we care about.
- **Long-lived background activity.** Recurring background pings (every ~30s)
  kept being captured as long as the session stayed attached.

## The gap (decisive finding)

CDP server-side capture **only sees pages the server has attached to.** The
server attaches **on demand** — when the agent/tools touch a tab via
`PageManager.getSession() → attach()`. Tabs the user opens and browses normally,
that the agent never touches, produce **zero capture**. In the spike, 3 tabs
opened via a side-channel (github, Hacker News, newtab) were never captured;
only the agent-driven amazon.com tab was. Service workers and any traffic
**before** attach are also missed.

For "capture every connection across the fleet", on-demand attach is
insufficient on its own.

## Extended spike (proactive attach + bodies, 2026-06-21)

Rewrote the spike to **proactively** discover every target
(`Target.setDiscoverTargets` + `getTargets`, attach our own session per target,
re-attach on `targetCreated`) and to capture bodies (`Network.getResponseBody`
for XHR/Fetch/Document). Three decisive findings:

1. **Proactive attach captures ALL targets, agent-untouched ones included.** On
   startup it attached to every open page AND service workers (amazon page +
   amazon `service-worker.js` + the extension SW + newtab + HN) with no agent
   involvement. A brand-new tab created via a side-channel `Target.createTarget`
   (bypassing the agent entirely) was captured via `targetCreated`. **Metadata
   coverage is complete.**
2. **Attach-too-late race on brand-new tabs.** For a tab created and immediately
   navigated, the initial document + early subresources fire before we finish
   `attachToTarget` + `Network.enable`, so they're missed. Capturing from byte 0
   needs pause-on-start: `Target.setAutoAttach({waitForDebuggerOnStart:true})` +
   `Runtime.runIfWaitingForDebugger()` after enabling Network.
3. **Body capture requires the page's PRIMARY session.** `getResponseBody` on
   our *secondary* attached session failed for every request with
   `CDP error: No resource with given identifier found` — Chrome buffers bodies
   on the session that owns the navigation, not a parallel attached one. Isolated
   control test on the owning session: **34/40 bodies retrieved** (the 6 misses
   are cached/redirect/no-body — expected). So bodies are only available on the
   primary session.

**Consequence for "capture everything incl. bodies" (chosen scope):** metadata
wants proactive attach; bodies want the primary session; completeness wants
pause-on-start. All three converge on **root-level auto-attach with
`waitForDebuggerOnStart:true`** so the server's connection is the *primary*
session for every current/future target — giving complete metadata, byte-0
coverage, and working body capture in one mechanism. The cost is that this
changes the server's CDP attach model (today: on-demand explicit attach), so
Fase 2 must either let the telemetry layer own root auto-attach (PageManager
piggybacks) or coordinate the two. If that coupling proves fragile at fleet
scale, the **C++ network-service patch** becomes the cleaner alternative.

## Options

| Option | Coverage | Cost |
|---|---|---|
| **CDP, on-demand attach (today's seam)** | Only agent-touched pages | ~0 — already proven |
| **CDP, proactive attach to ALL targets** | All pages once attached; misses pre-attach + workers | Low — TS only; enumerate targets + `Target.setDiscoverTargets`/auto-attach, enable Network on each new target |
| **Chromium C++ patch (network-service level)** | Everything incl. pre-attach, workers, all profiles | High — rebase cost per release, slow build |

## Recommendation

**CDP root-level auto-attach with pause-on-start, on the server's connection**
(`Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true,
flatten:true})` + `runIfWaitingForDebugger` after `Network.enable`). The
extended spike proved this is the only single mechanism that satisfies the
chosen "capture everything incl. bodies" scope: complete metadata (proactive,
all targets), byte-0 coverage (pause-on-start), and working `getResponseBody`
(primary session). Plain proactive *secondary-session* attach is rejected — it
cannot retrieve bodies.

Revisit a **minimal C++ network-service patch** only if owning root auto-attach
proves to couple too tightly with the existing on-demand `PageManager` attach,
or if service-worker / pre-process-launch traffic still escapes at fleet scale.

The production capture layer (Fase 2) will live in an additive package and hook
the same `onSessionAttached` seam (plus target discovery), so the throwaway
spike wiring in `browser.ts`/`main.ts` is reverted once Fase 2 lands.

## Open questions (feed the taxonomy v0)

- Capture request/response **headers/bodies** (deep audit) or **connection
  metadata only** (url/method/status/type/size/timing)? Bodies carry PII/secrets
  → needs a redaction policy.
- Sampling/rollup: amazon.com alone produced ~290 requests; fleet-wide volume
  needs batching/sampling like `lib/metrics.ts` already does for tool events.
