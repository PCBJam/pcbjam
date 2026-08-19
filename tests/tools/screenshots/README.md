# Screenshot regression + Discord review tooling

One comparison engine + a Discord reporter for the e2e screenshots; baseline
updates happen in the morelli review app
(https://pcbjam-morelli-staging.pcbjam-staging.workers.dev, repo
github.com/PCBJam/morelli).

**Source of truth = CI's Linux render.** The dev never authors baselines on the
Mac (Mac fonts/GL ≠ CI). CI renders on every push and uploads each run's
screenshots to R2 (`runs/pcbjam/<run-id>/`, 30-day retention, upload-run.ts);
when a render change is intentional you *promote* that run's screenshots in
morelli. The environment isn't pinned — if the host's Mesa/fonts drift, the
gate lights up in Discord and you just re-promote (broad + low-intensity
change ⇒ likely drift).

**Baselines live entirely in R2, not git.** The PNGs sit in a private
Cloudflare R2 bucket (`pcbjam-ci-screenshots`), content-addressed as
`sha256/<hex>.png` and immutable; the R2-HOSTED manifest
`baselines/pcbjam/manifest.json` (written only by morelli + its seed script)
pins each `<engine>/<name>` to a hash. The local `baseline-screenshots/` tree
and `.baseline-manifest.json` are gitignored caches —
`npm run screenshots:fetch-manifest && npm run screenshots:fetch` materializes
them. Nothing screenshot-related is committed.

**Credentials** (S3 API, bucket-scoped, region `auto`):
```
CI_SCREENSHOTS_S3_ENDPOINT           # https://<account-id>.r2.cloudflarestorage.com
CI_SCREENSHOTS_S3_BUCKET             # optional, default pcbjam-ci-screenshots
CI_SCREENSHOTS_S3_ACCESS_KEY_ID      # read-only pair for fetch; CI's upload step maps in a write pair
CI_SCREENSHOTS_S3_SECRET_ACCESS_KEY
```
CI holds the read-only pair as repo secrets (plus `CI_SCREENSHOTS_S3_WRITE_*`
for the run-upload step); devs get a read pair from the team vault (ask) and
put it in `tests/.env` (gitignored, auto-loaded by r2-store.ts; shell env vars
take precedence):
```
CI_SCREENSHOTS_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CI_SCREENSHOTS_S3_ACCESS_KEY_ID=<access-key-id>
CI_SCREENSHOTS_S3_SECRET_ACCESS_KEY=<secret>
```
Without credentials, the manifest/baseline fetch and the compare gate skip with
a warning (secretless CI callers stay green).

**Everything is per-engine.** Specs write `test-results/<engine>/<name>.png`
(engine derived from the running browser via `stableShot`/`shotPath`); baselines
live in `baseline-screenshots/<engine>/`; the canonical key everywhere in this
tooling is `<engine>/<name>` and captions/attachments carry the engine label.
The same spec on chromium + firefox is two independent gated screenshots.

## Files
- `config.ts` — thresholds, baseline dirs, per-engine floors (calibrate!), clustering knobs.
- `image-ops.ts` — PNG load/save, pixelmatch diff (AA-excluded), connected-component boxes, triptych compositing, size-cap resize.
- `compare.ts` — the comparison engine: classify per-engine baselines vs `test-results/<engine>/` → `test-results/screenshot-diff/report.json` + triptych/heatmap PNGs. `--pair` diffs two files.
- `perf-report.ts` — renders the track-only runtime-perf table (loadMs/openMs/FPS) with Δ vs the previous main run (fetched via `gh`).
- `post-discord.ts` — the always-on CI-on-main report: SHA + e2e status + perf table, then screenshot triptychs (batched, size-capped, flood-collapsed).
- `noise.ts` — calibration: diff two identical-input renders → per-engine noise floor.
- `r2-store.ts` — minimal aws4fetch S3 client for the CAS bucket (get/put/exists by hash, downloads integrity-checked).
- `r2-sync.ts` — cache sync: `--manifest` downloads the R2-hosted baseline manifest, `--pull` materializes `baseline-screenshots/` from it (idempotent, deletes unlisted files), `--verify` HEADs every hash.
- `upload-run.ts` — CI-only: upload the run's renders + meta.json to `runs/pcbjam/<run-id>/` for morelli (needs the write pair; no-ops without credentials).
- `spec-map.ts` — best-effort screenshot-name → spec-file attribution for captions (scans `stableShot`/`shotPath` literals).

## npm scripts (run from `tests/`)
```
npm run screenshots:fetch-manifest   # download the R2-hosted baseline manifest (needs read creds)
npm run screenshots:fetch            # materialize the baseline cache from R2 (run before check)
npm run screenshots:check            # gate: baselines vs test-results → report.json (exit 0; add --fail-on-change to gate)
npm run screenshots:report -- --e2e pass   # post the CI report to Discord (main+push only; needs DISCORD_WEBHOOK_URL)
npm run screenshots:noise -- run1/ run2/   # calibrate floors
npm run screenshots:upload-run -- --e2e pass   # CI-only: upload the run's renders for morelli
```

Baseline promotion (single or bulk) happens in morelli — pick the run, review
the diffs, Promote. It copies verbatim bytes into the CAS, updates the R2
manifest atomically (with provenance: which run/branch/user), and snapshots the
previous manifest for revert.

## Activation checklist
- [x] Baseline manifest migrated to R2 (`baselines/pcbjam/manifest.json`, {name, engine} authoritative — written by morelli).
- [x] `scale:'device'`→`'css'` normalized (no-op at CI's DSF=1).
1. Add the `DISCORD_WEBHOOK_URL` repo secret — until then everything is inert.
2. Calibrate: run the suite twice in CI, `screenshots:noise` the two dirs, set `FLOORS` in `config.ts`.
3. First re-baseline: `promote` a clean CI run's render, commit (expect a big, one-time chrome-font diff vs the Mac baselines).
4. Delete the old `scripts/{compare,update-baseline}-screenshots.sh`.
5. Once floors are proven stable, flip the gate to `--fail-on-change`.
