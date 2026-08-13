import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the React WEB APP (web/standalone editor at :3048 + the
 * @pcbjam/backend-example reference backend at :3060), as opposed to the
 * merged playwright.config.ts which drives the standalone tool harness HTMLs
 * under tests/apps. Kept separate because this suite runs a different server
 * stack (`pnpm dev` two-server turbo), its own globalSetup health checks and a
 * fixed base URL.
 *
 * These tests exercise the real web open paths: navigate to /:scope/projects/:name/<file>,
 * let WasmTool boot the tool in-document (boot.ts), drive the project into MEMFS
 * and auto-open the file (open-flow.ts via Module.kicadOpenFile), and assert the
 * editor loaded wizard-free.
 *
 * The backend serves a single project off the local filesystem — no DB, no
 * seeding. The suite runs against the PRODUCTION stack: the standalone is
 * `vite build`-built and served by `vite preview` (build-preview.mjs — wasm
 * stays out of dist/, served same-origin at /wasm via the serveWasm plugin),
 * and the backend runs its no-watch `start` script. Locally an already-running
 * stack on the ports is reused as before (the common dev case); CI always
 * cold-starts both servers with the env below, pointing PROJECT_DIR at the
 * committed tests/fixtures/demo project (slug "demo").
 *
 * All projects use the BUNDLED browsers so the suite runs identically on CI
 * (no system-Chrome channel; ANGLE/Mesa-llvmpipe GL for GPU-less runners).
 */

const FRONTEND_URL = process.env.WEB_APP_URL ?? 'http://localhost:3048';
// Keep the cold-started stack consistent with WEB_APP_URL overrides (e.g. a
// sibling worktree squatting :3048): vite binds the URL's port and the backend
// allows that origin, so overriding one env var relocates the whole frontend.
const FRONTEND_PORT = new URL(FRONTEND_URL).port || '3048';
// Backend counterpart — same override story for :3060 squatters. BACKEND_URL
// is the var global-setup-web.ts already probes; the cold-started reference
// backend binds its port and the editor is pointed at it.
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3060';
const BACKEND_PORT = new URL(BACKEND_URL).port || '3060';

// Bundled Chromium on GPU-less CI: WebGL via ANGLE over desktop GL (Mesa
// llvmpipe under the Xvfb display CI provides) — NOT SwiftShader, which under
// multi-worker contention transiently fails WebGL calls and drove KiCad's GAL
// error-recovery into silent Cairo fallbacks (the occ-export flake; see
// docs/features/wx-parity-bugs/occ-export-context-eviction.md). Keep this in
// lockstep with CHROMIUM_CI_ARGS in playwright.config.ts. --ignore-gpu-blocklist
// is mandatory: llvmpipe is on Chromium's software-GL blocklist and WebGL is
// silently unavailable without it.
const CHROMIUM_CI_ARGS = process.env.CI
  ? {
      launchOptions: {
        args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
      },
    }
  : {};

// Firefox prefs. JSPI is default-on since Firefox 153 (the Playwright 1.62
// bundle); the pref stays as documentation of intent, UNCONDITIONAL exactly
// like FIREFOX_PREFS_ALWAYS in playwright.config.ts.
// CI additionally runs headed under Xvfb (the CI step wraps in xvfb-run) with
// the no-GPU blocklist bypassed, since headless Firefox can't create a GL
// context on GPU-less CI VMs. NOTE: spreads REPLACE launchOptions wholesale —
// keep this a single composed object, never two competing spreads.
const FIREFOX_PREFS_ALWAYS = {
  'javascript.options.wasm_js_promise_integration': true,
};
const FIREFOX_CI_OPTS = process.env.CI
  ? {
      headless: false,
      launchOptions: {
        firefoxUserPrefs: {
          ...FIREFOX_PREFS_ALWAYS,
          'webgl.force-enabled': true,
        },
      },
    }
  : {
      launchOptions: {
        firefoxUserPrefs: { ...FIREFOX_PREFS_ALWAYS },
      },
    };

export default defineConfig({
  globalSetup: './web/global-setup-web.ts',
  testDir: './web',
  // On CI, keep Playwright's start-of-run cleanup away from test-results/ — the
  // engine-scoped gate screenshots of the main e2e invocation accumulate there.
  outputDir: process.env.CI ? 'pw-artifacts/web' : 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // retries:0 — same determinism doctrine as the merged config (the suite's
  // blind sleeps were replaced with condition waits when it was wired into CI).
  retries: 0,
  // Parallel workers (Playwright default ≈ 50% of cores), same as the merged
  // config — the kicad suite already runs 4 workers of giant wasm runtimes on
  // the same class of CI runner. Cross-worker isolation holds: each worker is
  // its own browser instance, so BroadcastChannel rooms and IndexedDB stores
  // never cross, and presence/comments specs mint per-run users via ?user=.
  workers: undefined,
  reporter: 'html',
  timeout: 180000, // tool wasm download + boot + open can take minutes

  use: {
    baseURL: FRONTEND_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'web-firefox',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
        ...FIREFOX_CI_OPTS,
      },
    },
    {
      name: 'web-chromium',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        ...CHROMIUM_CI_ARGS,
      },
    },
    {
      // Canvas-only mobile mode (features/mobile): Pixel 7 emulation on the
      // bundled Chromium (mobile emulation is Chromium-only).
      name: 'web-mobile',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices['Pixel 7'], ...CHROMIUM_CI_ARGS },
    },
  ],

  // Two independent prod servers, started in parallel and health-checked on
  // their URLs. cwd (not --dir/--filter from tests/): corepack resolves pnpm
  // from the packageManager pin in web/package.json only when the process
  // STARTS in web/ — launched from tests/ it falls back to latest pnpm, which
  // needs a newer Node than CI's. Locally an already-running stack is reused
  // (the common dev case — note that stack must have set the VITE_* flags
  // below itself, and a dev server is accepted too).
  webServer: [
    {
      // Reference backend, prod mode (tsx src/server.ts, no watch).
      command: 'pnpm --filter @pcbjam/backend-example start',
      cwd: '../web',
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
      env: {
        ...process.env,
        // resolved against web/backend/ (the backend's cwd)
        PROJECT_DIR: '../../tests/fixtures/demo',
        PORT: BACKEND_PORT,
        CORS_ORIGIN: FRONTEND_URL,
      },
    },
    {
      // Standalone editor: vite build → vite preview (build-preview.mjs).
      // The VITE_* flags are baked in at BUILD time here (the dev server used
      // to read them live): API base, the browser-local IDB project store the
      // missing-file tool-switch spec needs, and per-run e2e identity via
      // ?user= (0009). turbo.json lists them in globalEnv so the build cache
      // re-keys when they change.
      command: 'pnpm --filter @pcbjam/standalone e2e:preview',
      cwd: '../web',
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      // Cold build (turbo: shared + sync-client + standalone) + preview boot.
      timeout: 600000,
      env: {
        ...process.env,
        STANDALONE_PORT: FRONTEND_PORT,
        VITE_API_BASE_URL: BACKEND_URL,
        VITE_LOCAL_PROJECTS: 'idb',
        VITE_ALLOW_USER_OVERRIDE: '1',
      },
    },
  ],
});
