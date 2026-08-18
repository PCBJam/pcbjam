# Screenshot regression + Discord review tooling

One comparison engine + a churn-free updater + a Discord reporter for the e2e
screenshots. Design and rationale: `~/.claude/plans/…snowglobe.md` (or ask).

**Source of truth = CI's Linux render.** The dev never authors baselines on the
Mac (Mac fonts/GL ≠ CI). Instead, CI renders on every push; when a render change
is intentional you *promote* CI's artifact into the baselines. The environment
isn't pinned — if the host's Mesa/fonts drift, the gate lights up in Discord and
you just re-promote (broad + low-intensity change ⇒ likely drift).

**Baselines live in R2, not git.** The PNGs sit in a private Cloudflare R2
bucket (`pcbjam-ci-screenshots`), content-addressed as `sha256/<hex>.png` and
immutable; the committed `screenshot-manifest.json` pins each `<engine>/<name>`
to a hash, so every git commit resolves its exact baselines. The local
`baseline-screenshots/` tree is a gitignored cache — `npm run screenshots:fetch`
materializes it; `promote` uploads new hashes and rewrites the manifest, and the
manifest diff is the only thing you commit.

**Credentials** (S3 API, bucket-scoped, region `auto`):
```
CI_SCREENSHOTS_S3_ENDPOINT           # https://<account-id>.r2.cloudflarestorage.com
CI_SCREENSHOTS_S3_BUCKET             # optional, default pcbjam-ci-screenshots
CI_SCREENSHOTS_S3_ACCESS_KEY_ID      # read-only pair in CI; read-write pair for promote
CI_SCREENSHOTS_S3_SECRET_ACCESS_KEY
```
CI holds the read-only pair as repo secrets; devs get the read-write pair from
the team vault (ask) and put it in `tests/.env` (gitignored, auto-loaded by
r2-store.ts; shell env vars take precedence):
```
CI_SCREENSHOTS_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CI_SCREENSHOTS_S3_ACCESS_KEY_ID=<rw-access-key-id>
CI_SCREENSHOTS_S3_SECRET_ACCESS_KEY=<rw-secret>
```
Without credentials, fetch and the compare gate skip with a warning (secretless
CI callers stay green); promote refuses to run.

**Everything is per-engine.** Specs write `test-results/<engine>/<name>.png`
(engine derived from the running browser via `stableShot`/`shotPath`); baselines
live in `baseline-screenshots/<engine>/`; the canonical key everywhere in this
tooling is `<engine>/<name>` and captions/attachments carry the engine label.
The same spec on chromium + firefox is two independent gated screenshots.

## Files
- `config.ts` — thresholds, baseline dirs, per-engine floors (calibrate!), clustering knobs.
- `image-ops.ts` — PNG load/save, pixelmatch diff (AA-excluded), connected-component boxes, triptych compositing, size-cap resize.
- `compare.ts` — the comparison engine: classify per-engine baselines vs `test-results/<engine>/` → `test-results/screenshot-diff/report.json` + triptych/heatmap PNGs. `--pair` diffs two files.
- `promote.ts` — churn-free updater: pull a CI run's shots (`gh run download`) or `--from DIR`; overwrite a baseline only when pixels differ beyond the floor (verbatim bytes, no re-encode) → no git churn.
- `perf-report.ts` — renders the track-only runtime-perf table (loadMs/openMs/FPS) with Δ vs the previous main run (fetched via `gh`).
- `post-discord.ts` — the always-on CI-on-main report: SHA + e2e status + perf table, then screenshot triptychs (batched, size-capped, flood-collapsed).
- `changelog.ts` — Discord trigger B: git-history diff of the manifest between two revs, PNG bytes fetched from R2 (no build/GPU).
- `noise.ts` — calibration: diff two identical-input renders → per-engine noise floor.
- `gen-manifest.ts` — regenerate `screenshot-manifest.json` ({name, engine, sha256, bytes, width, height}) from the local baseline cache; `--check` (gating in CI, credential-free) validates the schema and fails if baseline PNGs are ever re-committed to git.
- `r2-store.ts` — minimal aws4fetch S3 client for the CAS bucket (get/put/exists by hash, downloads integrity-checked).
- `r2-sync.ts` — cache sync: `--pull` materializes `baseline-screenshots/` from the manifest (idempotent, deletes unlisted files), `--push` seeds/uploads, `--verify` HEADs every hash.
- `spec-map.ts` — best-effort screenshot-name → spec-file attribution for captions (scans `stableShot`/`shotPath` literals).

## npm scripts (run from `tests/`)
```
npm run screenshots:fetch      # materialize the baseline cache from R2 (run before check; needs read creds)
npm run screenshots:check      # gate: baselines vs test-results → report.json (exit 0; add --fail-on-change to gate)
npm run screenshots:promote -- --run <ci-run-id>   # churn-free re-baseline from a CI run (or --from DIR; needs RW creds)
npm run screenshots:report -- --e2e pass           # post the CI report to Discord (main+push only; needs DISCORD_WEBHOOK_URL)
npm run screenshots:changelog                       # post the baseline changelog (main+push only)
npm run screenshots:noise -- run1/ run2/            # calibrate floors
npm run screenshots:manifest                        # regenerate the manifest (--check to verify it's fresh)
```

## Activation checklist
- [x] `screenshot-manifest.json` generated ({name, engine} authoritative — derived from the per-engine baseline tree).
- [x] `scale:'device'`→`'css'` normalized (no-op at CI's DSF=1).
1. Add the `DISCORD_WEBHOOK_URL` repo secret — until then everything is inert.
2. Calibrate: run the suite twice in CI, `screenshots:noise` the two dirs, set `FLOORS` in `config.ts`.
3. First re-baseline: `promote` a clean CI run's render, commit (expect a big, one-time chrome-font diff vs the Mac baselines).
4. Delete the old `scripts/{compare,update-baseline}-screenshots.sh`.
5. Once floors are proven stable, flip the gate to `--fail-on-change`.
