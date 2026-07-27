// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// Fully static: every page prerenders to HTML with zero client JS, and there is
// NO adapter — the build output in dist/ is what `wrangler pages deploy` ships.
// The one dynamic route, /api/waitlist, is a Cloudflare Pages Function in
// functions/ rather than an Astro SSR route. See README.md ("Deploying").
export default defineConfig({
  // Canonical origin. Both www.pcbjam.com and the apex are custom domains on the
  // same Pages project and serve identically, so this tag is what consolidates
  // them for search — keep it pointing at www. Without `site` at all, prerendered
  // Astro.url is localhost, which leaked into canonical/OG tags on production.
  site: 'https://www.pcbjam.com',
  output: 'static',
  // Deliberately NO trailingSlash setting: Astro's default emits the canonical
  // with a trailing slash, which is also the form Cloudflare Pages serves at
  // 200 (the bare form 308s to it). Forcing 'never' would make canonical and
  // the served URL disagree.
  //
  // MDX lets the Gerber-viewer blog post embed the <GerberDemo /> component
  // inline (markdown posts can't import components).
  integrations: [mdx()],
  // Prefetch linked pages so SPA-style navigation feels instant.
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  // Dev-server cross-origin isolation so the embedded Gerber viewer's WASM
  // threads (SharedArrayBuffer) work under `npm run dev`. Production headers are
  // scoped per-route in public/_headers. require-corp (not credentialless) for
  // the widest browser support incl. Safari 15.2+; safe because the site loads
  // only same-origin subresources.
  vite: {
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },
  // No `env.schema`: the waitlist secrets are no longer read through
  // `astro:env/server`. They reach the Pages Function as bindings on its
  // `context.env` (`wrangler pages secret put`), and the two former schema
  // defaults now live in functions/api/waitlist.ts.
});
