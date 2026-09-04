// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// Fully static: every page prerenders to HTML with zero client JS, and there is
// NO adapter — the build output in dist/ is what `wrangler pages deploy` ships.
// The one dynamic route, /api/waitlist, is a Cloudflare Pages Function in
// functions/ rather than an Astro SSR route. See README.md ("Deploying").
/**
 * Vite plugin: COOP/COEP on the Gerber post + demo assets only (dev server; static assets).
 * @returns {import('vite').Plugin}
 */
function scopedIsolation() {
  // Keep in sync with public/_headers and src/middleware.ts.
  const ISOLATED_PREFIXES = ['/blog/porting-kicad-graphics-to-webgl-in-2026', '/gerber-demo'];
  /** @type {import('vite').Connect.NextHandleFunction} */
  const middleware = (req, res, next) => {
    const url = req.url ?? '';
    if (ISOLATED_PREFIXES.some((p) => url.startsWith(p))) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
  };
  return {
    name: 'pcbjam-scoped-isolation',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

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
  // inline (markdown posts can't import components). The sitemap integration
  // emits sitemap-index.xml + sitemap-0.xml from every prerendered route (uses
  // `site` above); public/robots.txt points crawlers at it.
  integrations: [mdx(), sitemap()],
  // Prefetch linked pages so SPA-style navigation feels instant.
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  // Dev + preview cross-origin isolation for the embedded Gerber viewer's WASM
  // threads (SharedArrayBuffer), scoped to the Gerber post exactly like the
  // production rules in public/_headers. It must NOT be site-wide: a require-corp
  // document cannot load the landing page's YouTube iframe, so global headers
  // here made the hero render as a blocked frame under `npm run dev` / preview.
  // require-corp (not credentialless) for the widest browser support incl.
  // Safari 15.2+; safe because the post loads only same-origin subresources
  // plus the CORP-tagged WASM blobs on cdn.pcbjam.com.
  //
  // Applies to `astro dev` only: `astro preview` drops user Vite plugins, so it
  // serves every route un-isolated (the Gerber post's viewer degrades there).
  // For a preview with the real production headers use `npm run pages:dev`,
  // which serves dist/ through wrangler with public/_headers applied.
  vite: {
    plugins: [scopedIsolation()],
  },
  // No `env.schema`: the waitlist secrets are no longer read through
  // `astro:env/server`. They reach the Pages Function as bindings on its
  // `context.env` (`wrangler pages secret put`), and the two former schema
  // defaults now live in functions/api/waitlist.ts.
});
