import * as fs from "node:fs";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildPluginRuntime, WORKER_CSP } from '@pcbjam/plugin-platform/build.mjs';
import { buildGuide } from '@pcbjam/plugin-platform/build-guide.mjs';

/**
 * Serve /wasm assets from public/wasm (the link-wasm.mjs symlink) in BOTH the
 * dev server and `vite preview`.
 *
 * Dev: only `.gz` needs help. Vite's static (sirv) sets
 * `Content-Encoding: gzip` for `.gz` files; the browser then transparently
 * decompresses the response, so the harness's `fetch('images.tar.gz')`
 * receives the DECOMPRESSED tar — and KiCad's gunzip of it fails with "Can't
 * read from inflate stream: incorrect header check". We must hand the browser
 * the raw gzip bytes, so we serve them ourselves with no Content-Encoding.
 * Runs before the public-dir middleware.
 *
 * Preview: dist/ deliberately contains NO wasm (build-preview.mjs stashes the
 * public/wasm symlink aside during the build, same as build-demo.mjs — it
 * would copy 100s of MB into dist/), so preview serves ALL of /wasm/* from
 * the symlink path here, with the same raw-.gz rule. Same-origin, so COEP
 * needs no extra headers on these responses.
 */
function serveWasm(): Plugin {
  const publicDir = path.resolve(__dirname, "public");
  const MIME: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".map": "application/json",
    ".html": "text/html",
    ".data": "application/octet-stream",
    ".gz": "application/octet-stream",
  };
  const serve = (
    req: { url?: string },
    res: import("node:http").ServerResponse,
    next: () => void,
    opts: { gzOnly: boolean },
  ) => {
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/wasm/")) return next();
    const isGz = /\.gz$/.test(url);
    if (opts.gzOnly && !isGz) return next();
    const filePath = path.join(publicDir, decodeURIComponent(url));
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) return next();
      const type = MIME[path.extname(filePath)] ?? "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Length", st.size);
      // This middleware short-circuits BEFORE vite applies server/preview
      // `headers`, so it must emit the cross-origin-isolation set itself:
      // kicad_editor.js doubles as the pthread WORKER script, and under
      // COEP:require-corp a worker script's response must itself carry COEP —
      // without it Chrome kills the load with net::ERR_BLOCKED_BY_RESPONSE
      // and the editor never boots.
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      // Intentionally NO Content-Encoding for .gz so fetch() yields raw bytes.
      fs.createReadStream(filePath).pipe(res);
    });
  };
  return {
    name: "serve-wasm",
    configureServer(server) {
      // Dev: sirv serves public/ fine except the .gz encoding quirk.
      server.middlewares.use((req, res, next) => serve(req, res, next, { gzOnly: true }));
    },
    configurePreviewServer(server) {
      // Preview: dist has no wasm at all — serve the whole subtree.
      server.middlewares.use((req, res, next) => serve(req, res, next, { gzOnly: false }));
    },
  };
}

// Local POC artifacts are fixed trusted runtime files. Publisher UI is served
// separately on :4318 and must never be made executable on the editor origin.
function pluginRuntimeAssets(): Plugin {
  const middleware = (server: { middlewares: { use: Function } }) => {
    server.middlewares.use((req: { url?: string; method?: string }, res: import('node:http').ServerResponse, next: () => void) => {
      if (req.url?.startsWith('/plugin-runtime/')) {
        res.setHeader('Content-Security-Policy', WORKER_CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        const url = req.url.split('?')[0]!;
        if (/^\/plugin-runtime\/[a-f0-9]{64}\//.test(url) && !fs.existsSync(path.resolve(__dirname,'public'+url))) {
          res.writeHead(404);res.end('Runtime asset unavailable');return;
        }
      }
      if (req.url === '/plugin-guide' || req.url?.startsWith('/plugin-guide/')) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.setHeader('X-Content-Type-Options','nosniff');
        // Serve generated docs directly: Vite otherwise rewrites directory URLs
        // to the editor SPA and injects scripts that the guide's CSP rejects.
        const pathname = req.url.split('?')[0]!.replace(/\/$/, '');
        const pages: Record<string, string> = {
          '/plugin-guide': 'index.html',
          '/plugin-guide/api': 'api/index.html',
          '/plugin-guide/architecture': 'architecture/index.html',
          '/plugin-guide/remote-symbols': 'remote-symbols/index.html',
          '/plugin-guide/security': 'security/index.html',
        };
        const downloads = ['external-symbol-import.zip', 'external-symbol-import-source.zip', 'sample-symbols.kicad_sym', 'sdk.d.ts'];
        const download = downloads.find(name => pathname === '/plugin-guide/download/' + name);
        const relative = pages[pathname] ?? (pathname === '/plugin-guide/guide.css' ? 'guide.css' : download ? 'download/' + download : undefined);
        if (!relative || !['GET', 'HEAD'].includes(req.method ?? 'GET')) {
          res.writeHead(404);res.end('Documentation page not found');return;
        }
        const file = path.resolve(__dirname, 'public/plugin-guide', relative);
        if (!fs.existsSync(file)) {
          res.writeHead(503);res.end('Developer guide has not been generated');return;
        }
        res.setHeader('Content-Type', download ? download.endsWith('.zip') ? 'application/zip' : 'application/octet-stream' : relative.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
        if (download) res.setHeader('Content-Disposition', `attachment; filename="${download}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', fs.statSync(file).size);
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return;
      }
      next();
    });
  };
  return {
    name: "plugin-runtime-poc-assets",
    configurePreviewServer: middleware,
    configureServer(server) {
      middleware(server);
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/plugin-runtime/")) return next();
        const name = url.slice("/plugin-runtime/".length);
        // Immutable runtime sets: serve the bytes directly. Vite's dev transform
        // refuses `import()` of a /public .js file ("copied as-is"), which is how
        // the editor loads package-host.js; production static hosting has no
        // such step.
        const versioned = /^([a-f0-9]{64})\/([a-z.-]+)$/.exec(name);
        if (versioned) {
          if (req.method !== "GET") { res.writeHead(404); res.end(); return; }
          const type = name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "text/javascript";
          fs.readFile(path.resolve(__dirname, "public/plugin-runtime", versioned[1]!, versioned[2]!), (error, bytes) => {
            if (error) { res.writeHead(404); res.end("Runtime asset unavailable"); return; }
            res.setHeader("Content-Type", type);
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.setHeader("X-Content-Type-Options", "nosniff");
            // The editor document is COEP require-corp; a dedicated Worker script
            // must carry the same policy or the browser blocks the response.
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
            res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
            res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            if (/worker\.js$/.test(versioned[2]!)) res.setHeader("Content-Security-Policy", WORKER_CSP);
            res.end(bytes);
          });
          return;
        }
        const mime: Record<string, string> = {
          "editor-host.js": "text/javascript", "worker.js": "text/javascript",
          "guest.js": "text/javascript", "quickjs.wasm": "application/wasm",
          "package-host.js": "text/javascript", "package-worker.js": "text/javascript", "package-prelude.js": "text/javascript",
        };
        if (req.method !== "GET" || !Object.hasOwn(mime, name)) {
          res.writeHead(404); res.end(); return;
        }
        const file = path.resolve(__dirname, "public/plugin-runtime", name);
        fs.readFile(file, (error, bytes) => {
          if (error) { res.writeHead(404); res.end("Run pnpm editor:install in tools/plugin-runtime-poc"); return; }
          res.setHeader("Content-Type", mime[name]!);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          if (name === "worker.js" || name === "package-worker.js") res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'");
          res.end(bytes);
        });
      });
    },
  };
}

export default defineConfig(async () => {
const runtime = await buildPluginRuntime(path.resolve(__dirname, 'public/plugin-runtime'));
await buildGuide(path.resolve(__dirname,'public/plugin-guide'));
fs.mkdirSync(path.resolve(__dirname,'src/generated'),{recursive:true});
fs.writeFileSync(path.resolve(__dirname,'src/generated/plugin-runtime.json'),JSON.stringify({version:runtime.version,files:Object.keys(runtime.manifest.files)}));
return {
  define: { 'import.meta.env.VITE_PLUGIN_RUNTIME_BASE': JSON.stringify(runtime.base) },
  plugins: [pluginRuntimeAssets(), serveWasm(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // @pcbjam/shared is in a second pnpm workspace with its own `yjs`; dedupe so
    // the bundled editor links ONE yjs (a mutable, instanceof-checked singleton).
    // Without it shared's collab code (kicad-y) and the app's yjs are two
    // instances → "Unexpected content type" the moment a doc is seeded.
    dedupe: ["yjs"],
  },
  server: {
    proxy: { '/plugin-dev/': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
    // Default :3048. The closed `pnpm dev:gpl` runs a second editor instance on
    // :3049 (alongside the closed stack) via STANDALONE_PORT. strictPort so a
    // busy port fails loudly instead of drifting onto another service's port.
    port: Number(process.env.STANDALONE_PORT) || 3048,
    strictPort: true,
    // KiCad WASM is cross-origin-isolated (COOP/COEP); same-origin /wasm assets
    // load fine. Keep these so SharedArrayBuffer/threads are available.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    // Same port contract as the dev server (STANDALONE_PORT override,
    // strictPort) so the e2e webServer/health-check URL is identical in both
    // modes. Vite's preview default (4173) would silently strand the suite.
    port: Number(process.env.STANDALONE_PORT) || 3048,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
};
});
