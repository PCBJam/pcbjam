# www.pcbjam.com deploy runbook

The Astro marketing site + blog (`../../site`) on **Cloudflare Pages** (project
`pcbjam-site`), with one **Pages Function** for `/api/waitlist`. The apex
`pcbjam.com` 308s to `www` via a zone Redirect Rule.

```
push to main (site/**)  ──▶  .github/workflows/deploy-site.yml
   1. npm ci
   2. npm test                     (vitest — nothing else runs it)
   3. astro build                  → site/dist/ (static; no adapter)
   4. wrangler pages deploy        → www.pcbjam.com
   5. smoke: /api/waitlist preflight == 204
```

Not tag-gated: content must not wait for a release. The WASM editor ships from
`release.yml`; the two are independent.

## Layout

```
site/functions/api/waitlist.ts   the only server-side code (Pages Function)
site/public/_headers             prod COOP/COEP, scoped to 2 routes
site/public/_routes.json         only /api/* invokes the Function
site/wrangler.toml               nodejs_compat + pages_build_output_dir
site/src/pages/404.astro         required — see "soft-404" below
```

Two things you can get wrong here, both of which fail quietly:

- **Never widen `_headers` to `/*`.** `deploy/demo/_headers` does exactly that,
  which is right for the demo and wrong here: a `require-corp` document cannot
  load the no-COEP YouTube hero iframe, so the landing page must stay
  un-isolated. The sweep asserts `/` is *not* isolated for this reason.
- **Never delete `404.astro`.** Without a `404.html` in the output, Pages answers
  every unknown URL with the **homepage at HTTP 200** — a soft-404 that invites
  search engines to index arbitrary URLs as the homepage.

## One-time setup (Cloudflare — needs your account)

1. `pcbjam.com` zone on Cloudflare; note the **account id**.
2. API token with: Zone→Zone:Read, Zone→DNS:Edit, Zone→Zone Settings:Edit,
   Zone→Dynamic Redirect:Edit, Account→Cloudflare Pages:Edit.
   Export `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
3. Pages project `pcbjam-site`, production branch `production` —
   `03-ensure-project.sh --apply`.
4. Secrets — `04-set-secrets.sh --apply`. `WAITLIST_ALLOWED_ORIGINS` stays
   **unset** so the allowlist lives in code.
5. Custom domain `www.pcbjam.com` + the apex Redirect Rule —
   `07-dns-cutover.sh`. There is no `wrangler pages domain` subcommand, so this
   goes through the API (or the dashboard).
6. The repo's GitHub secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   already exist for the demo/editor deploys — nothing to add.

## Migration / cutover (one time, from Vercel)

Every mutating script is **dry-run by default**; add `--apply`. Read the dry-run
output before applying — that is the whole point of the split.

| when | command | live? |
|---|---|---|
| T−days | `00-baseline.sh` | no — read-only |
| T−days | `01-preflight.sh` | no — read-only |
| T−days | `07-dns-cutover.sh --phase probe --apply` | no — throwaway hostname |
| T−days | `02-verify-local.sh` | no |
| T−days | `03-ensure-project.sh --apply` → `04-set-secrets.sh --apply` | new project only |
| T−days | `05-deploy.sh --preview --apply` → `06-verify-deploy.sh --latest` | no — pages.dev only |
| T−1d | `07-dns-cutover.sh --phase rules --apply` | no — inert until the apex is proxied |
| T−1d | `07-dns-cutover.sh --phase hsts --apply` | no — additive |
| T−24h | `07-dns-cutover.sh --phase prelower --apply` | no — TTL only |
| T−1h | `05-deploy.sh --production --apply` → `06-verify-deploy.sh --scope prod-deploy` | no — no DNS yet |
| **T+0** | `07-dns-cutover.sh --phase swap --apply` | **yes** |
| T+2m | `07-dns-cutover.sh --phase apex --apply` | yes (auto-rollback armed) |
| T+5m | `08-verify-prod.sh` | verify only |
| T+24h | `09-detach-vercel.sh --apply` | Vercel only |

Rollback, any time: **`99-rollback.sh --apply --yes`**. Keep it ready in a second
terminal during the swap.

### Why the swap is a PATCH, not a delete + create

A single `PATCH` flips the `www` record's content and proxied status atomically,
so there is **no DNS gap**. Delete-then-create leaves the name with no record for
a second or two, and any resolver that queries in that instant caches NODATA for
the zone's **SOA minimum** — typically 1800s. That is an un-flushable ~30-minute
partial outage. `00-baseline.sh` records the zone's actual value so the exposure
is a number, not a guess.

The residual risk with `PATCH` is HTTP-only and self-healing: for a second or two
the edge has no route for the hostname and serves the Pages not-found page.
Universal SSL already covers `*.pcbjam.com`, so TLS is never in question.

`--phase probe` settles whether Pages will attach a custom domain over an
existing CNAME, days early, on a throwaway hostname. `--swap-mode auto` reads
that result and only falls back to `delete-create` if it has to.

Throughout, Vercel stays attached, so resolvers still holding the old answer keep
serving the identical site. The cutover is a fade, not a switch.

## The parity sweep

`lib/parity.sh` is one assertion set, run against four bases: live Vercel
(baseline), `localhost:8788`, the `*.pages.dev` deployment, then `www`. Same
question every time, so a regression has nowhere to hide.

It asserts header values on the **final** response after following redirects,
via two separate requests (`_trace` then `_headers`). That is deliberate: the
COOP/COEP bug this migration fixes was invisible precisely because the headers
were present on a redirect hop and absent on the document.

`00-baseline.sh` is **expected to report failures** — the blog post's COOP/COEP
is genuinely broken on Vercel today (its canonical is the trailing-slash URL,
which serves 200 with no isolation headers). `08-verify-prod.sh` requires those
same probes to pass, which is how the fix is proven rather than assumed.

The honeypot POST is safe against production: that branch returns before
validation, before the rate limiter and before any Resend call, so it exercises
routing, Functions bundling, body parsing and CORS while sending no mail. The
only destructive probe (a *valid* email POST) is gated behind `--live-post` and
never runs against `www`.

## Gates

`02-verify-local.sh` writes a stamp keyed to a hash of `src/`, `public/`,
`functions/` and the configs. `05-deploy.sh` refuses to deploy without a stamp
for the *current* tree, and `07 --phase swap` refuses to cut DNS unless the
verified deployment id is still the live production deployment. Override with
`CFM_FORCE=1 CFM_I_UNDERSTAND=1`, which logs the bypass.

Scratch state (stamps, snapshots, logs) lives in `site/.cf-migrate/`, gitignored.

## Local development

```sh
cd site
npm run dev                        # Astro only — does NOT run functions/
cp .dev.vars.example .dev.vars     # gitignored
npm run build && npm run pages:dev # http://localhost:8788, Function included
```
