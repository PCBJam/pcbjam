# site

Public-facing marketing/content site for the KiCad WebAssembly project: landing
page, blog, and legal pages. Built with **Astro 6**.

This is a **standalone** project — it is intentionally decoupled from the `/web`
app monorepo (which is the product itself: React frontend + Fastify backend).
It uses **npm** (not the monorepo's pnpm) and has its own `package-lock.json`.

## What it ships

- Static by default: every page is prerendered to HTML and ships **zero client
  JavaScript**. A visitor downloads HTML + CSS only — no React/JS bundle.
- No adapter and no server bundle: the build emits `dist/` only. The single
  dynamic endpoint, `/api/waitlist`, ships as a **Cloudflare Pages Function**
  from `functions/` (see below).

## Routes

| Route                 | Source                                  |
| --------------------- | --------------------------------------- |
| `/`                   | `src/pages/index.astro`                 |
| `/blog`               | `src/pages/blog/index.astro`            |
| `/blog/<id>`          | `src/pages/blog/[slug].astro`           |
| `/terms`              | `src/pages/terms.astro`                 |
| `/privacy`            | `src/pages/privacy.astro`               |
| `/cookies`            | `src/pages/cookies.astro`               |

Blog posts are Markdown files in `src/content/blog/`, validated by the schema in
`src/content.config.ts`. Add a post by dropping a new `.md` file there with
`title`, `description`, and `pubDate` frontmatter.

## Local development

Requires **Node ≥ 22.12** (Astro 6 requirement).

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # outputs to dist/ (static only — no adapter)
npm run preview    # serve the production build locally
```

## Dynamic routes

Every page is static. The one server-side endpoint is a **Cloudflare Pages
Function**, not an Astro SSR route:

```
functions/api/waitlist.ts   ->  POST/OPTIONS/GET  /api/waitlist
```

Pages maps the `functions/` tree to routes by path, and the handlers are named
exports (`onRequestPost`, `onRequestOptions`, `onRequestGet`). Config arrives on
`context.env`, not via `astro:env/server`. `public/_routes.json` restricts
Function invocation to `/api/*`, so every page and asset stays a plain static
request.

To add another endpoint, drop a new file in `functions/` — no Astro adapter and
no `prerender = false` involved.

Locally, run the built site the way Pages will serve it (this is the only way to
exercise the Function, `astro dev` does not run `functions/`):

```bash
cp .dev.vars.example .dev.vars   # fill in as needed; gitignored
npm run build
npm run pages:dev                # http://localhost:8788
```

## Deploying

`www.pcbjam.com` is a **Cloudflare Pages** project (`pcbjam-site`), deployed by
`.github/workflows/deploy-site.yml` on every push to `main` touching `site/**` —
content and blog posts do not wait for a release tag.

```
push to main (site/**)  ->  npm ci  ->  npm test  ->  astro build
                        ->  wrangler pages deploy  ->  www.pcbjam.com
```

Two things live outside the repo and are set once:

- **Secrets** — `wrangler pages secret put <NAME> --project-name pcbjam-site`
  for `RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `WAITLIST_FROM_EMAIL`.
  `WAITLIST_ALLOWED_ORIGINS` is deliberately unset; it keeps the in-code default.
- **The custom domain** — attached to the Pages project (there is no
  `wrangler pages domain` subcommand). The apex `pcbjam.com` 308s to `www` via a
  Cloudflare Redirect Rule.

Response headers come from `public/_headers` (copied verbatim into `dist/`), which
carries the COOP/COEP rules the embedded Gerber viewer needs. Do **not** widen
them to `/*` — the landing page must stay un-isolated so the YouTube hero embed
loads.

One-time setup, the invariants that fail silently if changed, and the health
check (`deploy/site/verify.sh`) are in `../deploy/site/README.md`.
