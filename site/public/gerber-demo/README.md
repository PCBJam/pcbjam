# Gerber viewer demo

KiCad's `gerbview` compiled to WebAssembly, embedded (lazily) in the landing page
and the blog post. Click → it streams the WASM and renders the bundled
tiny_tapeout board in-browser.

The WASM is **not** kept here — `boot.js` loads it from the versioned CDN
(`cdn.pcbjam.com`), the same artifacts the demo/app deploy publishes. It resolves
gerbview's immutable, content-addressed folder at runtime from the release
manifest, so this page always shows the **latest deployed** gerbview with no
manual sync:

```
manifest-latest.json  ->  { tag }
manifest-<tag>.json   ->  tools.gerbview -> <ver>
base = https://cdn.pcbjam.com/wasm/gerbview/<ver>
```

See `docs/features/demo-deploy/0001-wasm-cdn-versioning.md` (in `pcbjam-private`)
for the CDN layout, manifest shapes, and header matrix.

## Files here (`site/public/gerber-demo/`)

| Path | What it does |
|------|--------------|
| `index.html` | The iframe/standalone target — minimal page with the `#main-window` / `#window-container` the WASM needs. |
| `boot.js` | Boot harness: resolves gerbview's CDN folder from the manifest, configures Emscripten `Module`, seeds KiCad config, preloads the board into MEMFS, auto-opens it via `Module.arguments`, and injects `wx.js → wx-dom.js → gerbview.js` from the CDN. |
| `board/` | The tiny_tapeout Gerber layers (committed) the demo opens. |
| `poster.png` | Static fallback shown to browsers that can't run the live viewer. |

The folder is cross-origin to this page (which is COEP `require-corp`); the CDN
sends `Cross-Origin-Resource-Policy: cross-origin` + `Access-Control-Allow-Origin: *`,
and the cross-origin pthread worker is loaded via a same-origin `blob:`
`importScripts` shim (`new Worker(<cross-origin URL>)` is a SecurityError). This
mirrors the standalone editor's `web/standalone/src/wasm/boot.ts`.

## Related pieces (elsewhere in `site/`)

| Path | What it does |
|------|--------------|
| `src/sections/GerberDemoSection.astro` | The landing-page showcase: a poster + launch button that opens `/gerber-demo/` in a new tab (the landing itself is not cross-origin isolated). |
| `src/components/GerberDemo.astro` | The blog embed: lazy click-to-load iframe, cross-origin-isolation reload guard, feature-detect + poster fallback. |
| `astro.config.mjs` + `src/middleware.ts` | Dev cross-origin-isolation headers (COOP/COEP `require-corp`). |
| `public/_headers` | Prod COOP/COEP on Cloudflare Pages, scoped to the blog post + `/gerber-demo/` routes (both URL forms of the post). |

## Dev overrides

`boot.js` reads query params so you can point it elsewhere without a rebuild:

| Param | Effect |
|-------|--------|
| `?tag=<tag>` | Pin a specific release instead of following `manifest-latest.json`. |
| `?cdn=<root>` | Swap the CDN root (e.g. a local mirror serving `manifest-*.json` + `gerbview/<ver>/`). |
| `?base=<folder>` | Use a tool folder verbatim (e.g. a fresh local build) — skips manifest resolution. |

The live viewer needs SharedArrayBuffer + WebGL2 (Chrome/Edge/Firefox, Safari 15.2+);
other browsers get `poster.png`.

## Updating `KICAD_VERSION_DIR`

`boot.js` seeds KiCad config under a version dir (currently `"10.0"`) to suppress
the first-run wizard. It **must** match the deployed build's
`GetMajorMinorVersion()`. If a future deploy bumps KiCad's major.minor, update the
`KICAD_VERSION_DIR` constant in `boot.js` (same coupling as
`web/standalone/src/wasm/constants.ts`).
