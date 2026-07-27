// Workers/Pages ambient types. `PagesFunction<Env>` and `EventContext` are
// globals from this package — without the reference they don't resolve, because
// tsconfig extends astro/tsconfigs/strict, which only wires Astro/Vite types.
/// <reference types="@cloudflare/workers-types" />
