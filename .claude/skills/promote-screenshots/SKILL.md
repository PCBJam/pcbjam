---
name: promote-screenshots
description: Promote a CI run's screenshot renders as the new baselines in the R2 bucket (pcbjam-ci-screenshots). Churn-free - only meaningfully-changed images upload; git gets only the tests/screenshot-manifest.json diff, never PNGs. Needs the read-write R2 keypair in tests/.env. Usage - "/promote-screenshots <ci-run-id> [--prune]". (scoped to pcbjam/ - covers the KiCad WASM e2e pipeline in tests/)
---

# promote-screenshots (pcbjam)

Bless a CI run's rendered screenshots as the new baselines. Baselines live in
the private R2 bucket `pcbjam-ci-screenshots` (prod Cloudflare account),
content-addressed as `sha256/<hex>.png`; the committed
`tests/screenshot-manifest.json` pins each `<engine>/<name>` to a hash. **Only
the manifest diff lands in git — never PNGs.**

## Prerequisites

- The READ-WRITE R2 keypair in the gitignored `tests/.env` (auto-loaded by the
  tooling, shell env wins; format in `tests/tools/screenshots/README.md`,
  values from the team vault). **Never print, echo, or commit these values.**
  If `.env` is missing, ask the user to fill it — promote fails fast without it.
- The CI run id: `gh run list --workflow ci-ubicloud.yml` on PCBJam/pcbjam
  (mind the active `gh` account — PCBJam repos need `matejcsok-pcb`).

## Steps

1. From `tests/`, dry-run first and show the user the plan:
   `npm run screenshots:promote -- --run <ci-run-id> --dry-run`
2. Sanity-check it: a handful of UPDATE/ADD lines for an intentional UI change
   is normal; hundreds of UPDATEs means environment drift — stop and confirm
   with the user before applying.
3. Apply: same command without `--dry-run`. Add `--prune` only when the user
   confirms screenshots were intentionally removed (prune edits the manifest;
   R2 objects are never deleted — old commits still resolve).
4. `git status` must show ONLY `tests/screenshot-manifest.json` modified.
   Commit that diff; on main it triggers the Discord baseline changelog.

## Never

- Never commit files under `tests/baseline-screenshots/` (the CI manifest
  check fails the build if you do) or the `.env`.
- Never promote local (Mac) renders via `--from` — CI's Linux render is the
  only source of truth.
- Never hand-edit hashes in the manifest; promote regenerates it.
