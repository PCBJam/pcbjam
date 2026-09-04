import { defineMiddleware } from 'astro:middleware';

/**
 * Dev-only cross-origin isolation for Astro-rendered pages, scoped to the same
 * routes as the production rules in public/_headers.
 *
 * The Vite plugin in astro.config.mjs covers static assets served by Vite (the
 * Gerber demo boot page + WASM under public/), but Astro's dev page renderer
 * writes its own response headers and drops them — so the blog post itself
 * wouldn't be cross-origin isolated and the embedded Gerber viewer's
 * SharedArrayBuffer would be unavailable. Set them here for `npm run dev`.
 *
 * Scoped, not global: a require-corp document cannot load the landing page's
 * YouTube iframe, so isolating every page rendered the hero as a blocked frame.
 *
 * Production is static (output: 'static'); the headers come from public/_headers,
 * so we no-op outside dev to keep the prerender/build output untouched.
 */
const ISOLATED_PREFIXES = ['/blog/porting-kicad-graphics-to-webgl-in-2026', '/gerber-demo'];

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  if (import.meta.env.DEV && ISOLATED_PREFIXES.some((p) => context.url.pathname.startsWith(p))) {
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  return response;
});
