import * as fs from "node:fs";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildPluginRuntime, WORKER_CSP } from '@pcbjam/plugin-platform/build.mjs';

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

// The /recover airlock page (standalone-hardening 0009) must NOT be cross-origin
// isolated: leaving the isolated process is its whole job. Production gets that
// from deploy/demo/_headers; here the server/preview `headers` would add
// COOP/COEP to every response, so drop them for this one page and map the
// extension-less URL (what Cloudflare serves) onto the built recover.html.
function recoverAirlock(): Plugin {
  const ISOLATION = new Set(["cross-origin-opener-policy", "cross-origin-embedder-policy"]);
  const middleware = (server: { middlewares: { use: Function } }) => {
    server.middlewares.use((req: { url?: string }, res: import("node:http").ServerResponse, next: () => void) => {
      const [pathname, query] = (req.url ?? "").split("?") as [string, string | undefined];
      if (pathname !== "/recover" && pathname !== "/recover.html") return next();
      req.url = `/recover.html${query ? `?${query}` : ""}`;
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => (ISOLATION.has(String(name).toLowerCase()) ? res : setHeader(name, value));
      res.setHeader("Cache-Control", "no-store");
      next();
    });
  };
  return { name: "recover-airlock", configureServer: middleware, configurePreviewServer: middleware };
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
fs.mkdirSync(path.resolve(__dirname,'src/generated'),{recursive:true});
fs.writeFileSync(path.resolve(__dirname,'src/generated/plugin-runtime.json'),JSON.stringify({version:runtime.version,files:Object.keys(runtime.manifest.files)}));
return {
  define: { 'import.meta.env.VITE_PLUGIN_RUNTIME_BASE': JSON.stringify(runtime.base) },
  plugins: [recoverAirlock(), pluginRuntimeAssets(), serveWasm(), react()],
  build: {
    rollupOptions: {
      // recover.html: the OOM process airlock (0009), its own tiny entry.
      input: {
        main: path.resolve(__dirname, "index.html"),
        recover: path.resolve(__dirname, "recover.html"),
      },
    },
  },
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
    // The local plugin lab (tools/plugin-runtime-poc `node scripts/serve.mjs`); PLUGIN_DEV_URL
    // points at a lab on another port (a second checkout beside one on :4317).
    proxy: { '/plugin-dev/': { target: process.env.PLUGIN_DEV_URL || 'http://127.0.0.1:4317', changeOrigin: false } },
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
