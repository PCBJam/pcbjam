import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'child_process';

// THE merged Playwright config for every suite that runs against the static
// `apps` server: the wx widget suite (e2e/), the KiCad editor suite (kicad/),
// the asyncify race harness (asyncify/) and the coroutine harness
// (e2e/coroutine*). One config = one invocation = one webServer and one port
// and ONE start-of-run outputDir wipe — which is what retired the old
// per-suite pw-artifacts/{wx,asyncify,kicad} redirect dance (each sequential
// CI invocation used to wipe the previous suite's artifacts).
//
// The web-app suite (web/) stays in playwright-web.config.ts: it runs against
// the React editor + backend stack (`pnpm --dir ../web dev`), not this server.
//
// CI runs: npm run test:e2e  (wx-chromium, kicad-firefox, kicad-chromium,
//          asyncify-firefox, asyncify-chromium, coroutine-firefox)
//          npm run test:perf (perf project, non-gating, separate invocation)
// Local-only projects (system Chrome / WebKit) are listed at the bottom.

const PORT_ENV = 'PCBJAM_PLAYWRIGHT_PORT';

// Resolve the static-server port for this run.
//
// This config is re-imported by the main runner and every worker. Store the
// selected port in the runner's environment: workers inherit it, while two
// independent Playwright invocations have separate environments and therefore
// cannot overwrite one shared port file. Recreated workers inherit it too.
function resolvePort(): number {
  const inherited = parseInt(process.env[PORT_ENV] ?? '', 10);
  if (inherited > 0 && inherited < 65536) {
    return inherited;
  }

  const port = findFreePort();
  process.env[PORT_ENV] = port.toString();
  return port;
}

function findFreePort(): number {
  try {
    const result = execSync(
      'python3 -c "import socket; s=socket.socket(); s.bind((\'\',0)); print(s.getsockname()[1]); s.close()"',
      // timeout: a broken python3 must fall back to the random port below, not
      // hang the whole run at config-load time.
      { encoding: 'utf-8', timeout: 5000 }
    );
    return parseInt(result.trim());
  } catch {
    return 9000 + Math.floor(Math.random() * 1000);
  }
}

const port = resolvePort();

const appsDir = 'apps';

// Runtime-perf specs run ONLY on the Chromium 'perf' project: they need CDP
// CPU throttling (Chromium-only). Excluded from the kicad projects so they
// don't double-run there.
const PERF_SPECS = ['**/*-perf.spec.ts'];

// Bundled Chromium on GPU-less CI: use ANGLE over desktop GL (Mesa llvmpipe
// via the Xvfb display CI already provides — the whole e2e step runs under
// `xvfb-run -a`) instead of SwiftShader. SwiftShader under multi-worker
// contention transiently fails WebGL calls ("Requested render buffer size is
// not supported", LRU context evictions at 3 live contexts, cross-context
// object errors), which stochastically drove KiCad's GAL error-recovery and
// flipped the occ-export screenshots between runs. llvmpipe — the same
// software-GL stack the Firefox projects run on — never exhibited any of it.
// Flags tested useless against the SwiftShader eviction before the switch:
// --max-active-webgl-contexts=64, --force-gpu-mem-available-mb,
// --disable-low-end-device-mode, --disable-gpu-driver-bug-workarounds.
// See docs/features/wx-parity-bugs/occ-export-context-eviction.md.
const CHROMIUM_CI_ARGS = process.env.CI
  ? {
      launchOptions: { args: [
        '--use-gl=angle',
        '--use-angle=gl',
        // llvmpipe is on Chromium's software-GL blocklist (the analog of the
        // Firefox projects' webgl.force-enabled pref) — without this, WebGL
        // is simply unavailable and the app falls back to Cairo rendering.
        '--ignore-gpu-blocklist',
      ] },
    }
  : {};

// CI-only Firefox prefs: GPU-less CI VMs can't create a headless GL context
// (FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS) — run headed under Xvfb, where
// GLX + Mesa llvmpipe provides software WebGL, and bypass the no-GPU
// blocklist so the GAL canvas gets a context. CI invokes the suite via
// `xvfb-run`.
const FIREFOX_CI_OPTS = process.env.CI
  ? {
      headless: false,
      launchOptions: {
        firefoxUserPrefs: {
          'webgl.force-enabled': true,
        },
      },
    }
  : {};

export default defineConfig({
  globalSetup: './global-setup.ts',
  // Every suite writes its gate screenshots to test-results/<engine>/ via
  // stableShot/shotPath — NOT into outputDir. On CI, outputDir points at a
  // throwaway dir so Playwright's start-of-run cleanup never touches the
  // accumulated screenshots (the perf run is a separate later invocation).
  outputDir: process.env.CI ? 'pw-artifacts/e2e' : 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // retries:0 — the suites are deterministic (no blind sleeps or "if element
  // exists" branches; screenshots go through stableShot for the offline gate,
  // not asserted inline), so a failure is a real failure rather than flake to
  // mask with a retry.
  retries: 0,
  // Parallel workers on CI too (Playwright default ≈ 50% of cores) — the
  // serial CI run was the dominant wall-clock cost.
  workers: undefined,
  reporter: 'html',
  timeout: 60000, // wx-suite default; the heavier projects override below

  // No expect.toHaveScreenshot: screenshots are captured via stableShot()
  // (render-settle + raw PNG to test-results/<engine>/) and compared OFFLINE
  // by tools/screenshots against tests/baseline-screenshots/<engine>/ on CI's
  // deterministic Linux render.

  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // ── CI projects (npm run test:e2e) ──────────────────────────────────
    {
      // The wx widget/test-app suite. Chromium-only by design (the wx PORT is
      // exercised cross-engine by the kicad + coroutine projects).
      name: 'wx-chromium',
      testDir: './e2e',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['clipboard-read', 'clipboard-write', 'local-fonts'],
        ...CHROMIUM_CI_ARGS,
      },
    },
    {
      name: 'kicad-firefox',
      testDir: './kicad',
      testIgnore: PERF_SPECS,
      timeout: 180000, // KiCad WASM needs more time to load
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
        ...FIREFOX_CI_OPTS,
      },
    },
    {
      name: 'kicad-chromium',
      testDir: './kicad',
      testIgnore: PERF_SPECS,
      timeout: 180000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        ...CHROMIUM_CI_ARGS,
      },
    },
    {
      // Asyncify-layer harnesses: the race-condition red-green battery and
      // the Design-B scheduler-context gate. One heavy WASM app at a time.
      // Matches EVERY spec in ./asyncify — a new harness here is covered by
      // construction rather than by remembering to widen this pattern.
      name: 'asyncify-firefox',
      testDir: './asyncify',
      testMatch: /\.spec\.ts$/,
      fullyParallel: false,
      timeout: 120000,
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
        ...FIREFOX_CI_OPTS,
      },
    },
    {
      // The Asyncify arbiter is browser-JS as well as wasm. Run its complete
      // harness set on bundled Chromium in CI too: the wx project exercises
      // coroutine consumers, but it does not select any file in ./asyncify.
      name: 'asyncify-chromium',
      testDir: './asyncify',
      testMatch: /\.spec\.ts$/,
      fullyParallel: false,
      timeout: 120000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        ...CHROMIUM_CI_ARGS,
      },
    },
    {
      // Coroutine harness on real Firefox — the wx-chromium project already
      // covers these specs on bundled Chromium; this is the cross-engine leg.
      // pending-event-owner is the owner-aware wx event reducer and belongs in
      // the same two-engine architectural gate even though its filename is not
      // coroutine-prefixed.
      name: 'coroutine-firefox',
      testDir: './e2e',
      testMatch: /(?:coroutine.*|pending-event-owner)\.spec\.ts$/,
      fullyParallel: false,
      timeout: 120000,
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
        ...FIREFOX_CI_OPTS,
      },
    },
    {
      // Runtime-perf specs: bundled Chromium for CDP CPU throttling. Run as a
      // SEPARATE, non-gating invocation (npm run test:perf) — hence its own CI
      // outputDir so its start-of-run wipe can't delete the e2e run's traces.
      name: 'perf',
      testDir: './kicad',
      testMatch: PERF_SPECS,
      timeout: 180000,
      ...(process.env.CI ? { outputDir: 'pw-artifacts/perf' } : {}),
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        ...CHROMIUM_CI_ARGS,
      },
    },

    // ── local-only projects (system Chrome / WebKit; CI installs neither) ─
    {
      // System Chrome (real GPU/V8) for headed KiCad debugging:
      //   npx playwright test --project=kicad-chrome --headed kicad/pcbnew.spec.ts
      name: 'kicad-chrome',
      testDir: './kicad',
      testIgnore: PERF_SPECS,
      timeout: 180000,
      use: {
        channel: 'chrome',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'asyncify-chrome',
      testDir: './asyncify',
      // Keep the scheduler-context contract in the same cross-engine policy as
      // the races battery. A narrower pattern used to omit sched-context.spec.
      testMatch: /\.spec\.ts$/,
      fullyParallel: false,
      timeout: 120000,
      use: {
        channel: 'chrome',
        viewport: { width: 1280, height: 720 },
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
    {
      // WebKit (Safari's engine) — project policy: every asyncify spec must be
      // green in all three engines. Run via npm run test:asyncify:safari.
      name: 'asyncify-webkit',
      testDir: './asyncify',
      testMatch: /\.spec\.ts$/,
      fullyParallel: false,
      timeout: 120000,
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      // Coroutine harness on system Chrome (real V8/GPU — where the KiCad
      // coroutine crash historically manifested). Must be --headed on ARM Mac.
      name: 'coroutine-chrome',
      testDir: './e2e',
      testMatch: /coroutine.*\.spec\.ts$/,
      fullyParallel: false,
      timeout: 120000,
      use: {
        channel: 'chrome',
        viewport: { width: 1280, height: 720 },
        permissions: ['clipboard-read', 'clipboard-write', 'local-fonts'],
      },
    },
  ],

  webServer: {
    command: `npx serve ${appsDir} -p ${port} -c ../serve.json`,
    port: port,
    reuseExistingServer: !process.env.CI,
  },
});
