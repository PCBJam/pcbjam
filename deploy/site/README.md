# www.pcbjam.com

The Astro marketing site + blog (`../../site`) on **Cloudflare Pages** (project
`pcbjam-site`), with one **Pages Function** for `/api/waitlist`. Both
`www.pcbjam.com` and the apex `pcbjam.com` are custom domains on that project and
serve identically; the pages emit `canonical=www`, which is what consolidates them
for search.

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

## Files that carry load

```
site/functions/api/waitlist.ts   the only server-side code (Pages Function)
site/public/_headers             prod response headers, scoped to 3 patterns
site/public/_routes.json         only /api/* invokes the Function
site/wrangler.toml               nodejs_compat + pages_build_output_dir
site/src/pages/404.astro         required — see below
```

Four things here fail **silently** if changed carelessly. Each is asserted by
`verify.sh`, and each is asserted because it was a real defect at some point:

- **Never widen `_headers` to `/*`.** `../demo/_headers` does exactly that, which
  is right for the demo and wrong here: a `require-corp` document cannot load the
  no-COEP YouTube hero iframe, so the landing page must stay un-isolated.
- **Keep both URL forms of the Gerber blog post in `_headers`.** Pages serves the
  trailing-slash form and 308s the bare form to it, and the trailing-slash form is
  the page's own canonical. Scoping the headers to one form only means search
  arrivals get a page without `SharedArrayBuffer` and the embedded viewer quietly
  degrades. That shipped in production for months.
- **Never delete `404.astro`.** With no `404.html` in the output, Pages answers
  every unknown URL with the **homepage at HTTP 200** — a soft 404 that invites
  indexing junk URLs as the homepage.
- **Keep the cross-site form-POST guard** in `waitlist.ts`. Vercel's edge refused
  those for free; Cloudflare does not, and a cross-site `<form>` submit needs no
  CORS permission to be *sent*, so the allowlist cannot stop it.

## Verifying

```sh
deploy/site/verify.sh                    # production
EXPECT_HSTS=1 deploy/site/verify.sh      # once HSTS max-age is set, assert it

# a specific deployment, before promoting it
PROD_BASE=https://abc123.pcbjam-site.pages.dev \
  deploy/site/verify.sh --skip-dns --skip-domains
```

`lib/parity.sh` holds the assertion set: pages resolve to themselves (which is how
a soft-404 gets caught), cross-origin isolation on the right paths *and its
absence on the landing page*, immutable asset caching, and the waitlist endpoint's
whole contract — preflight 204 with **zero** redirects for the demo origin, CORS
denied for others, 405 on GET, 400 on a bad address, 303 for the no-JS form, 403
for a cross-site form POST.

Header assertions are made on the **final** response after following redirects,
via two separate requests (`_trace`, then `_headers`). That split is deliberate:
the isolation bug above was invisible precisely because the headers were present
on a redirect hop and absent on the document.

The POSTs are safe against production. The full-path probe uses the honeypot
branch, which returns before validation, before the rate limiter and before any
Resend call — so it exercises routing, Functions bundling, body parsing and CORS
while sending no mail. The one destructive probe (a *valid* email POST) is behind
`--live-post` and is not used here.

## Secrets

`RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `WAITLIST_FROM_EMAIL`, set on the Pages
project (dashboard → Settings → Variables and Secrets, or
`wrangler pages secret put <NAME> --project-name pcbjam-site`). Pages applies
changes to **new deployments only**, so redeploy after editing them.

`WAITLIST_ALLOWED_ORIGINS` is deliberately unset — it keeps its default in
`functions/api/waitlist.ts`, where the allowlist is reviewable in code. Preview is
deliberately keyless too: a preview holding the live key would email real people
and write real Resend contacts.

## Recovery

There is no cross-vendor fallback — the Vercel project is gone. Recovery is a
Pages concern: every deployment stays addressable at its own `*.pages.dev` URL, so
verify a candidate first, then either roll back to it in the dashboard
(Deployments → Rollback to this deployment) or re-deploy a known-good tree so git
stays the source of truth.

## Local development

```sh
cd site
npm run dev                        # Astro only — does NOT run functions/
cp .dev.vars.example .dev.vars     # gitignored
npm run build && npm run pages:dev # http://localhost:8788, Function included
```

`astro dev` does not execute `functions/`, so any change to the waitlist endpoint
needs `pages:dev` to be exercised at all.
