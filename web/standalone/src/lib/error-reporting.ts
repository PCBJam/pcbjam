import * as Sentry from "@sentry/browser";
import { APP_GIT_SHA, APP_TAG, ERRORS_DSN, ERRORS_ENV } from "./config";
import { isTerminalSerializedError } from "@/wasm/terminal-error";

/**
 * Error reporting to Better Stack.
 *
 * Better Stack's Error Tracking ingests the SENTRY wire protocol, so we run the
 * stock @sentry/browser SDK pointed at a Better Stack DSN. No Better Stack SDK
 * is involved (they don't publish one for browsers; their alternative is a
 * remote <script> tag with no beforeSend/fingerprint hooks and session replay on
 * by default — which on a CAD canvas would record customers' board geometry).
 *
 * THIS IS THE ONLY FILE THAT IMPORTS @sentry/browser. Everything else stays
 * vendor-neutral, so swapping providers is a one-file change. Same isolation
 * rule lib/analytics.ts applies to Plausible.
 *
 * What this captures, and what it doesn't
 * --------------------------------------
 * Sentry.init installs its own window `error` / `unhandledrejection` handlers,
 * so uncaught main-thread errors are captured with no instrumentation at the
 * throw sites. That is deliberately the whole feature: the errors that actually
 * kill sessions are wasm traps escaping emscripten's DOM event handlers
 * (`dynCall_iiii` → trap → window.onerror), which this sees for free.
 *
 * It does NOT see inside Web Workers — occ-worker.js / ngspice-worker.js and the
 * KiCad pthread workers are separate realms with their own global scope, and
 * every console.error in this app lives in one of them. Forwarding those needs a
 * postMessage bridge; deferred until the data says those workers actually fail.
 *
 * Bundle cost: ZERO when no DSN is configured. `import.meta.env.VITE_ERRORS_DSN`
 * is const-folded at build time, so the guard below is statically false and
 * Rollup drops the whole @sentry/browser import — measured 1,193,080 vs
 * 1,282,463 bytes of JS (~26 KB gzipped) with and without. Dev checkouts and the
 * e2e preview build therefore ship none of it.
 */

/** Reports per session — a crash loop must not bill as a thousand events. */
const MAX_EVENTS_PER_SESSION = 20;

let sent = 0;
/**
 * Set once a terminal wasm error has been reported. After a trap the module is
 * wedged, so every subsequent DOM event re-enters dead wasm and throws again — a
 * single production incident produced 8 identical-looking errors from one root
 * cause. Reporting each would triple-count the issue and read as 8 problems.
 */
let wasmDead = false;
let cascade = 0;

/** Query params whose values are credentials. `?token=` in particular is live:
 *  wasm/collab/provider.ts passes the collab token in the y-partyserver URL, so
 *  any connection-failure message containing that URL carries a real secret. */
const SECRET_PARAM = /([?&](?:token|apiKey|api_key|access_token|key|secret|sig|signature|password)=)[^&\s"']+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._-]+/gi;

function redact(text: string): string {
  return text.replace(SECRET_PARAM, "$1[redacted]").replace(BEARER, "$1[redacted]");
}

/**
 * Initialize error reporting. Idempotent; a hard no-op unless all three hold:
 *
 *   1. a DSN is configured (unset in dev checkouts and in any deploy that
 *      doesn't pass one);
 *   2. we're in a browser (vitest imports this module transitively);
 *   3. the build does NOT allow `?user=` overrides — VITE_ALLOW_USER_OVERRIDE=1
 *      is set by the dev server and every Playwright harness and NEVER by a
 *      production build (see config.ts). Using it as a negative gate means a
 *      developer who copies a production .env into a local checkout still can't
 *      pollute the dashboard.
 */
export function initErrorReporting(): void {
  if (!ERRORS_DSN || typeof window === "undefined") return;
  if (import.meta.env.VITE_ALLOW_USER_OVERRIDE === "1") return;

  Sentry.init({
    dsn: ERRORS_DSN,
    environment: ERRORS_ENV,
    // Same identity the version badge shows, which is also our GPLv3
    // corresponding-source pointer — so an error and the exact source it came
    // from share one key.
    release: `pcbjam@${APP_TAG ?? "dev"}+${APP_GIT_SHA?.slice(0, 7) ?? "local"}`,

    // The defaults are MERGED with an `integrations: [...]` array, so removing
    // one requires the callback form.
    integrations: (defaults) => [
      ...defaults.filter(
        (i) =>
          // BrowserApiErrors wraps setTimeout / setInterval /
          // requestAnimationFrame / addEventListener in try/catch to attach
          // better stack traces. KiCad-on-Emscripten drives its main loop
          // through exactly those (emscripten_async_call → setTimeout, and the
          // GAL refresh timer re-arms in a tight loop), so wrapping them adds
          // a closure per tick on the hottest paths for marginal gain. (Under
          // JSPI stack traces are not mangled, so source-map symbolication may
          // now be worth revisiting — behavior kept as is.)
          i.name !== "BrowserApiErrors" && i.name !== "Breadcrumbs",
      ),
      // Keep breadcrumbs — clicks, navigation and fetches are exactly the "what
      // was the user doing" trail that makes a lone stack trace actionable — but
      // drop CONSOLE capture. wasm/collab/debug.ts's clog is on by default in
      // production and fires on every Yjs update, so console breadcrumbs would
      // evict the whole ring with collab chatter before any crash happens.
      Sentry.breadcrumbsIntegration({ console: false }),
    ],

    beforeSend(event) {
      if (sent >= MAX_EVENTS_PER_SESSION) return null;

      const ex = event.exception?.values?.[0];
      const message = ex?.value ?? event.message ?? "";
      // The live Error is gone by now — classify from the serialized frame,
      // whose `type` is the original constructor name. Matching on the message
      // alone would miss any trap whose wording we didn't anticipate.
      const terminal = isTerminalSerializedError(ex?.type, message);

      // One wedge, one event. Later traps are the same corpse being kicked.
      if (terminal && wasmDead) {
        cascade++;
        return null;
      }
      if (terminal) {
        wasmDead = true;
        event.tags = { ...event.tags, wasm_terminal: "true" };
      }
      if (cascade > 0) {
        event.extra = { ...event.extra, cascade_count: cascade };
      }

      if (ex?.value) ex.value = redact(ex.value);
      if (event.message) event.message = redact(event.message);
      // The SDK attaches the page URL automatically; scrub it too — editor URLs
      // are project paths and may carry query credentials.
      if (event.request?.url) event.request.url = redact(event.request.url);

      sent++;
      return event;
    },
  });
}
