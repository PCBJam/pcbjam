The goal is to build kicad with wasm and run it in a browser
README.md details how to run the project

A lot of native module have to be compiled to wasm, the most complex is wxwidgets
/kicad and /wxwidgets are git submodules from our own forks
The e2e tests are in /tests, with a README and WHATWORKS md files
Test determinism rules (no blind sleeps/ifs, `stableShot` screenshots, retries:0) are in tests/TESTING.md, enforced by `npm run lint:determinism`.
The e2e tests are separated per feature
Wxwidgets wasm port has hooks for finding positions of UI elements, tests use that
The test screenshot baselines live in a private R2 bucket (content-addressed by sha256), pinned per engine by the R2-hosted manifest baselines/pcbjam/manifest.json — NOTHING manifest-related is in git; tests/baseline-screenshots/{chromium,firefox}/ is a gitignored local cache — `cd tests && npm run screenshots:fetch-manifest && npm run screenshots:fetch` materializes it (needs the R2 credentials in tests/tools/screenshots/README.md). CI's Linux render is the source of truth (tooling: tests/tools/screenshots/, see its README).
To update baselines, promote a CI run's screenshots in the morelli review app (https://pcbjam-morelli-staging.pcbjam-staging.workers.dev — pick the run, review the diffs, bulk-select, Promote). CI uploads every run's renders to R2 (runs/pcbjam/<run-id>/, 30-day retention) for that purpose. No git commit is involved. `npm run screenshots:check` is the local gate (fetch-manifest + fetch first); on each main push CI posts a screenshot-diff + runtime-perf report to Discord.
The tests have log files in tests/logs/{wxwidgets/kicad}/{test-name} after each run where the js console and cpp logs are visible
Always check screenshots for validating tests
Run e2e tests from /tests folder: `npm run test:e2e` (full CI project set, one merged playwright.config.ts) or `npm run test:kicad` (firefox shortcut) — not playwright directly. One spec/engine: `npx playwright test --project=kicad-firefox kicad/pcbnew.spec.ts`. Web-app suite: `npm run test:web`.

Build kicad with docker/build.sh (includes wxwidgets build, runs in docker)
Build wxwidgets standalone with scripts/build-wx-wasm.sh (runs on machine, for wxwidgets-only changes)
Build CPP wxwidgets tests with scripts/builds-wasm-test.sh
The build scripts pipe their outputs into log files so that they won't clog the LLM context. 
Don't pipe outputs, just run the scripts. Maybe with flex if you need that.

Don't change the wxwidgets core unless absolutely necessary, try to fix things in the wasm layer.
Don't change kicad unless absolutely necessary - keep our fork as close to upstream as possible.
Run scripts/kicad-diff-stats.sh to see how far our KiCad fork has diverged from upstream.
It's okay to add temporary logging that will be removed for debugging.

Don't try to guess what's broken , use debug tools / symbols, supported by the build scripts

Feature docs/patches are in features/<branch-name>/. Run scripts/create-feature-patches.sh to save patches for root, kicad, wxwidgets submodules.

The landing page / website is in /site (Astro, static, deployed to Cloudflare Pages
by .github/workflows/deploy-site.yml on every push to main touching site/**).
It has no Astro adapter; the one dynamic route (/api/waitlist) is a Cloudflare
Pages Function in site/functions/. Prod response headers come from
site/public/_headers (COOP/COEP for the embedded Gerber viewer — never widen
them to /*, the landing page must stay un-isolated for the YouTube embed).
The footer shows a build SHA that links to the pcbjam commit the site was built
from; because it pins the kicad + wxwidgets submodule revisions implicitly, it is
our GPLv3 corresponding-source pointer (see /licenses). It resolves automatically
at build time in site/src/components/Footer.astro (CF_PAGES_COMMIT_SHA / GITHUB_SHA
in CI, `git rev-parse` locally) — no manual bump needed.
Cloudflare setup, the invariants that fail silently, and the health check
(deploy/site/verify.sh) are documented in pcbjam/deploy/site/README.md.
