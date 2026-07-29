// Publish the FULL default KiCad symbol + footprint set to the CDN as
// version-pinned r2-idb-sync STATIC ORIGINS (one per lib), which the demo's
// cdnLibsSource opens read-only + IDB-cached (1 bundle cold, 0 warm). See
// docs/features/r2-idb-sync + wasm/libs/cdn-source.ts.
//
//   npx tsx scripts/deploy/publish-libs.ts --lib-tag 10.0.3 \
//     --symbols-src <kicad-symbols checkout> --footprints-src <kicad-footprints> \
//     --driver local --out /tmp/cdn-libs
//   npx tsx scripts/deploy/publish-libs.ts --lib-tag 10.0.3 --symbols-src … \
//     --footprints-src … --driver r2 --bucket pcbjam-cdn --remote
//
// Keyed by the upstream KiCad library tag (libs/kicad/<libTag>/), published ONCE
// per tag: if <prefix>/<libTag>/manifest.json already exists it SKIPS the whole
// run (override with --force) — so it's decoupled from the app/demo deploy.
//
// Per lib `<prefix>/<libTag>/<lib>/`:
//   manifest   SyncManifest { version, entries: { "<kind>/<name>": {hash,size,mtime} } }
//   bundle     encodeBundle(manifest, bodies)  — cold-init payload (all bodies)
// + top `<prefix>/<libTag>/manifest.json` { schema, tag, libs:[{id,name,kind,itemCount}] }
// + `<prefix>/<libTag>/fp-index.json` { schema, tag, libs: { <libId>: [[name, pads], …] } }
//   — the publish-time footprint index: unique electrical pad count per footprint,
//   so the editor's symbol-chooser footprint selector can filter EVERY footprint
//   lib without fat-loading a single body (kicad pcbnew.cpp `filterFootprints`).
// + `<prefix>/<libTag>/sizes.json` { schema, tag, libs: { <libId>: <bundleBytes> } }
//   — per-lib bundle byte counts for the standalone's download-consent dialog
//   (standalone-load-ux 0001). A SEPARATE key (not a manifest.json field) on
//   purpose: manifest.json is stored IMMUTABLE, so re-putting it to add sizes
//   could serve stale from edge caches; a new key can't.
// All immutable (content is pinned by the tag).
// A tag published before fp-index.json / sizes.json existed gets a TOP-UP run:
// bundles/manifests are skipped (immutable + present), only the missing index
// and/or sizes files are computed (pure local work) and put.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractAllLibs } from "../../web/backend/src/extract/extract-libs.js";
import { countUniquePads } from "../../web/backend/src/extract/kicad-pretty.js";
import { encodeBundle, type SyncManifest } from "../../web/pcbjam-shared/src/sync-wire.js";
import { IMMUTABLE, makeStore, putJSON, sha256hex } from "./lib/cdn-store.mjs";

// Upstream KiCad library repos (full set lives here; tagged per KiCad release).
const SYMBOLS_URL = "https://gitlab.com/kicad/libraries/kicad-symbols.git";
const FOOTPRINTS_URL = "https://gitlab.com/kicad/libraries/kicad-footprints.git";

interface Args {
  libTag: string | null;
  symbolsSrc: string | null;
  footprintsSrc: string | null;
  clone: string | null;
  driver: string;
  out: string | null;
  bucket: string;
  remote: boolean;
  prefix: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    libTag: null,
    symbolsSrc: null,
    footprintsSrc: null,
    clone: null,
    driver: "local",
    out: null,
    bucket: "pcbjam-cdn",
    remote: false,
    prefix: "libs/kicad",
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i]!;
    switch (argv[i]) {
      case "--lib-tag": a.libTag = next(); break;
      case "--symbols-src": a.symbolsSrc = next(); break;
      case "--footprints-src": a.footprintsSrc = next(); break;
      // Clone both upstream repos at --lib-tag into <dir>/{kicad-symbols,
      // kicad-footprints} (full, shallow) and use them as the sources.
      case "--clone": a.clone = next(); break;
      case "--driver": a.driver = next(); break;
      case "--out": a.out = next(); break;
      case "--bucket": a.bucket = next(); break;
      case "--remote": a.remote = true; break;
      case "--prefix": a.prefix = next(); break;
      case "--force": a.force = true; break;
      default: throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  if (!a.libTag) throw new Error("--lib-tag <kicad library tag> is required");
  if (!a.symbolsSrc && !a.footprintsSrc && !a.clone)
    throw new Error("need --clone <dir>, or --symbols-src / --footprints-src");
  if (a.driver === "local" && !a.out) a.out = ".cdn-out";
  return a;
}

/** Shallow full clone of a lib repo at a tag (idempotent: skip if present). */
function cloneFull(url: string, dest: string, ref: string): void {
  if (existsSync(dest)) {
    console.log(`clone: ${dest} present — reusing`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`clone: ${url} @ ${ref} → ${dest}`);
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, url, dest], {
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv);
  const store = makeStore(a.driver, a);
  const enc = new TextEncoder();
  const topKey = `${a.prefix}/${a.libTag}/manifest.json`;
  const indexKey = `${a.prefix}/${a.libTag}/fp-index.json`;
  const sizesKey = `${a.prefix}/${a.libTag}/sizes.json`;

  // Skip-if-exists: the snapshot is immutable + content-pinned by the tag.
  // A tag published before fp-index.json / sizes.json existed drops into a
  // TOP-UP run: recompute + put just the missing derived files (pure local
  // work; no bundle/manifest puts).
  const published = !a.force && !!store.getJSON(topKey);
  const haveIndex = published && !!store.getJSON(indexKey);
  const haveSizes = published && !!store.getJSON(sizesKey);
  if (published && haveIndex && haveSizes) {
    console.log(`publish-libs: ${topKey} already published — skipping (use --force)`);
    return;
  }

  console.log(
    `publish-libs: tag=${a.libTag} driver=${store.kind} → ${a.prefix}/${a.libTag}/` +
      (published ? " (top-up: derived files only)" : ""),
  );

  // Source the full set from upstream when asked (CI path); --symbols-src /
  // --footprints-src still win if also given (local checkouts).
  if (a.clone) {
    const symDest = join(a.clone, "kicad-symbols");
    const fpDest = join(a.clone, "kicad-footprints");
    cloneFull(SYMBOLS_URL, symDest, a.libTag);
    cloneFull(FOOTPRINTS_URL, fpDest, a.libTag);
    a.symbolsSrc ??= symDest;
    a.footprintsSrc ??= fpDest;
  }

  const libs = await extractAllLibs({
    // Symbols are only needed for bundles (fresh publish) or sizes (top-up);
    // the fp-index alone covers footprints only.
    symbolsSrc: published && haveSizes ? undefined : (a.symbolsSrc ?? undefined),
    footprintsSrc: a.footprintsSrc ?? undefined,
  });

  const topLibs: Array<{ id: string; name: string; kind: string; itemCount: number }> = [];
  const fpIndexLibs: Record<string, Array<[string, number]>> = {};
  const sizesLibs: Record<string, number> = {};
  let totalItems = 0;
  for (const { lib, kind, items } of libs) {
    if (kind === "footprint" && !haveIndex) {
      fpIndexLibs[lib] = items.map((it) => [it.name, countUniquePads(it.body)]);
    }
    // bundles/manifests already live under a published tag; a sizes top-up
    // still re-encodes each bundle LOCALLY (deterministic from the same tag's
    // sources) to measure it — nothing is re-put.
    if (published && haveSizes) continue;

    const bodies = items.map(
      (it): [string, Uint8Array] => [`${it.kind}/${it.name}`, enc.encode(it.body)],
    );
    const entries: SyncManifest["entries"] = {};
    for (const [path, body] of bodies) {
      entries[path] = { hash: sha256hex(body), size: body.length, mtime: 0 };
    }
    const manifest: SyncManifest = { version: 1, entries };
    const bundle = encodeBundle(manifest, bodies);
    sizesLibs[lib] = bundle.byteLength;
    if (published) continue;

    const base = `${a.prefix}/${a.libTag}/${lib}`;
    putJSON(store, `${base}/manifest`, manifest, IMMUTABLE);
    store.put(`${base}/bundle`, bundle, {
      contentType: "application/octet-stream",
      contentEncoding: null,
      cacheControl: IMMUTABLE,
    });
    topLibs.push({ id: lib, name: lib, kind, itemCount: items.length });
    totalItems += items.length;
  }

  if (!published) {
    topLibs.sort((x, y) => x.id.localeCompare(y.id));
    putJSON(store, topKey, { schema: 1, tag: a.libTag, libs: topLibs }, IMMUTABLE);
  }
  if (!haveIndex) {
    putJSON(store, indexKey, { schema: 1, tag: a.libTag, libs: fpIndexLibs }, IMMUTABLE);
  }
  if (!haveSizes) {
    putJSON(store, sizesKey, { schema: 1, tag: a.libTag, libs: sizesLibs }, IMMUTABLE);
  }

  const fpIndexCount = Object.values(fpIndexLibs).reduce((n, v) => n + v.length, 0);
  console.log(
    published
      ? `publish-libs: done — top-up (${haveIndex ? "" : `fp-index: ${fpIndexCount} footprints`}` +
          `${!haveIndex && !haveSizes ? ", " : ""}` +
          `${haveSizes ? "" : `sizes: ${Object.keys(sizesLibs).length} libs`})`
      : `publish-libs: done — ${topLibs.length} libs, ${totalItems} items ` +
          `(+fp-index: ${fpIndexCount} footprints, +sizes) → ${topKey}`,
  );
  if (store.kind === "local") console.log(`local layout under: ${a.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
