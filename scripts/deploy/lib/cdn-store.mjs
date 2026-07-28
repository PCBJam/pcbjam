// Shared CDN publish primitives for the demo-deploy pipeline (publish-wasm,
// publish-content). A pluggable object store with two drivers — `local` (writes
// the exact bucket layout to a dir + a `_uploads.json` HTTP-metadata sidecar, so
// publishing is verifiable offline) and `r2` (shells `wrangler r2 object
// {get,put}`, needing only CLOUDFLARE_API_TOKEN). See docs/features/demo-deploy/.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import {
  brotliCompress,
  brotliCompressSync,
  gzip,
  gzipSync,
  constants as zc,
} from "node:zlib";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// `no-transform` keeps Cloudflare's edge from decompressing our pre-compressed
// (brotli-q11) blobs and re-serving them at its own on-the-fly quality (br-4);
// also preserves the original Content-Length. Immutable content-addressed blobs.
export const IMMUTABLE = "public, max-age=31536000, immutable, no-transform";
export const NO_STORE = "no-store";

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

const brotliOpts = (bytes, quality) => ({
  params: {
    [zc.BROTLI_PARAM_QUALITY]: quality ?? 5,
    [zc.BROTLI_PARAM_SIZE_HINT]: bytes.length,
  },
});

/** Compress bytes; returns { bytes, encoding }. mode: "gzip" | "br" | "none". */
export function compressBytes(bytes, mode, quality) {
  if (mode === "none") return { bytes, encoding: null };
  if (mode === "gzip")
    return { bytes: gzipSync(bytes, { level: quality ?? 6 }), encoding: "gzip" };
  // brotli — default quality 5 (good ratio, far faster than 11 on 100s of MB).
  return {
    bytes: brotliCompressSync(bytes, brotliOpts(bytes, quality)),
    encoding: "br",
  };
}

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

/**
 * Async compressBytes: runs on the libuv threadpool, so N calls awaited
 * together compress on N cores (set UV_THREADPOOL_SIZE before the first call).
 * Byte-identical output to compressBytes.
 */
export async function compressBytesAsync(bytes, mode, quality) {
  if (mode === "none") return { bytes, encoding: null };
  if (mode === "gzip")
    return {
      bytes: await gzipAsync(bytes, { level: quality ?? 6 }),
      encoding: "gzip",
    };
  return {
    bytes: await brotliCompressAsync(bytes, brotliOpts(bytes, quality)),
    encoding: "br",
  };
}

/** Content-Type from a file extension (best-effort; covers KiCad + web assets). */
export function contentTypeForPath(name) {
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".html")) return "text/html";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  // KiCad project/board/schematic/lib files are s-expr / ini text.
  if (/\.(kicad_\w+|net|csv|pos|drl|gbr|g[a-z0-9]+)$/i.test(name))
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

// --- drivers ------------------------------------------------------------------
// Interface:
//   getJSON(key) -> object | null         (object stored uncompressed)
//   put(key, bytes, { contentType, contentEncoding, cacheControl })

export function localDriver(outDir) {
  const uploadsPath = join(outDir, "_uploads.json");
  const uploads = existsSync(uploadsPath)
    ? JSON.parse(readFileSync(uploadsPath, "utf8"))
    : {};
  const abs = (key) => join(outDir, key);
  return {
    kind: "local",
    getJSON(key) {
      const p = abs(key);
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    },
    put(key, bytes, meta) {
      const p = abs(key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
      uploads[key] = { ...meta, bytes: bytes.length };
      mkdirSync(outDir, { recursive: true });
      writeFileSync(uploadsPath, JSON.stringify(uploads, null, 2));
    },
  };
}

export function r2Driver({ bucket, remote }) {
  // Default to `npx wrangler` so no global install is needed (override via env).
  const wrangler = process.env.WRANGLER_CMD?.split(" ") || ["npx", "--yes", "wrangler@4"];
  const flags = remote ? ["--remote"] : [];
  // quiet: capture stderr instead of inheriting it — used for existence PROBES,
  // where wrangler's "key does not exist" on a fresh bucket is expected + caught.
  const run = (args, { quiet = false } = {}) =>
    execFileSync(wrangler[0], [...wrangler.slice(1), ...args], {
      stdio: ["pipe", "pipe", quiet ? "pipe" : "inherit"],
      maxBuffer: 1024 * 1024 * 512,
    });
  const tmp = join(tmpdir(), `r2put-${process.pid}`);
  return {
    kind: "r2",
    getJSON(key) {
      const dest = `${tmp}-get`;
      try {
        // Probe: a missing object is the normal "not published yet" case.
        run(["r2", "object", "get", `${bucket}/${key}`, "--file", dest, ...flags], {
          quiet: true,
        });
      } catch {
        return null; // not found / error → absent (expected on first publish)
      }
      try {
        return JSON.parse(readFileSync(dest, "utf8"));
      } finally {
        rmSync(dest, { force: true });
      }
    },
    put(key, bytes, meta) {
      mkdirSync(dirname(tmp), { recursive: true });
      writeFileSync(tmp, bytes);
      const args = [
        "r2", "object", "put", `${bucket}/${key}`,
        "--file", tmp,
        "--content-type", meta.contentType,
        "--cache-control", meta.cacheControl,
        ...flags,
      ];
      if (meta.contentEncoding) args.push("--content-encoding", meta.contentEncoding);
      run(args);
      rmSync(tmp, { force: true });
    },
  };
}

/** Construct the driver named by `driver` ("local" | "r2"). */
export function makeStore(driver, opts) {
  if (driver === "local") return localDriver(opts.out);
  if (driver === "r2") return r2Driver(opts);
  throw new Error(`unknown driver: ${driver}`);
}

/** Put a JSON value (pretty-printed, uncompressed) with the given Cache-Control. */
export function putJSON(store, key, obj, cacheControl) {
  store.put(key, Buffer.from(JSON.stringify(obj, null, 2)), {
    contentType: "application/json",
    contentEncoding: null,
    cacheControl,
  });
}
