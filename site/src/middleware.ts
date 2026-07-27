import { defineMiddleware } from 'astro:middleware';

/**
 * Dev-only cross-origin isolation for Astro-rendered pages.
 *
 * Vite's `server.headers` (astro.config.mjs) already cover static assets in
 * public/ (the boot page + WASM), but Astro's dev page renderer writes its own
 * response headers and drops them — so the blog post itself wouldn't be
 * cross-origin isolated, and the embedded Gerber viewer's SharedArrayBuffer
 * would be unavailable. Set them here for `npm run dev`.
 *
 * Production is static (output: 'static'); these headers come from public/_headers
 * scoped to the post + /gerber-demo routes, so we no-op outside dev to keep the
 * prerender/build output untouched.
 */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  if (import.meta.env.DEV) {
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  return response;
});
