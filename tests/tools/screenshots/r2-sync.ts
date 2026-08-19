/**
 * Sync the local baseline-screenshots/ cache with the R2 CAS bucket.
 *
 * The R2-HOSTED manifest (baselines/pcbjam/manifest.json, written only by the
 * morelli review app + its seed script) is the source of truth. --manifest
 * downloads it to the gitignored MANIFEST_PATH; everything downstream (--pull,
 * --verify, compare.ts) reads that local copy, so a single fetch pins the
 * whole run to one manifest version.
 *
 * CLI (from tests/):
 *   tsx tools/screenshots/r2-sync.ts --manifest # R2 manifest → local .baseline-manifest.json
 *   tsx tools/screenshots/r2-sync.ts --pull     # fetched manifest → local tree (CI fetch step + local gate)
 *   tsx tools/screenshots/r2-sync.ts --verify   # HEAD every manifest hash, exit 1 on any miss
 *
 * --manifest and --pull without credentials warn and exit 0 — and --manifest
 * DELETES a stale local manifest so the gate skips rather than comparing
 * against outdated baselines. Secretless callers of the reusable CI workflow
 * (release.yml, pcbjam deploy-staging.yml, fork PRs) therefore stay green;
 * compare.ts skips its gate when no manifest was fetched. With credentials,
 * any 404/corrupt object is collected and the run exits 1.
 *
 * (--push is gone with the git-manifest era: baseline bytes now enter the CAS
 * only via morelli's promote, which copies them from the CI run uploads.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { BASELINE_ROOT, MANIFEST_PATH, MANIFEST_VERSION, R2_BASELINES_MANIFEST_KEY, listEngineKeys, type Manifest, type ManifestEntry } from './config';
import { R2Store, hashFile, missingEnv, storeFromEnv } from './r2-store';

const CONCURRENCY = 16;

/** Parse the fetched manifest if it is the morelli-era v3 format; null when
 *  absent/unparsable (→ the gate skips). A NEWER version throws — old tooling
 *  silently no-oping on a future format would disable the whole gate. */
export function loadManifest(root: string): Manifest | null {
    const p = path.join(root, MANIFEST_PATH);
    if (!fs.existsSync(p)) return null;
    let m: Manifest;
    try {
        m = JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
    } catch {
        return null;
    }
    if (m.version > MANIFEST_VERSION) {
        throw new Error(`${MANIFEST_PATH} is version ${m.version} but this tooling expects ${MANIFEST_VERSION} — update your checkout`);
    }
    return m.version === MANIFEST_VERSION ? m : null;
}

/**
 * Download the R2-hosted baseline manifest to MANIFEST_PATH (atomic tmp+rename).
 * Returns false when it could not be fetched — in which case any stale local
 * copy is removed, so downstream steps skip instead of using old baselines.
 */
export async function fetchManifest(root: string, store: R2Store): Promise<boolean> {
    const dest = path.join(root, MANIFEST_PATH);
    const bytes = await store.getKey(R2_BASELINES_MANIFEST_KEY);
    if (!bytes) {
        fs.rmSync(dest, { force: true });
        console.warn(`[r2-sync] ${R2_BASELINES_MANIFEST_KEY} not found in R2 — no baselines (seed via morelli first)`);
        return false;
    }
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
    return true;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]);
    });
    await Promise.all(workers);
}

/**
 * Materialize the manifest's baselines into the local cache tree. Files already
 * hashing correctly are skipped (idempotent — a warm cache or restored
 * actions/cache costs nothing), writes are atomic (tmp + rename), and local
 * PNGs the manifest no longer lists are deleted so a stale branch switch can't
 * leave ghost baselines for compare.ts to gate against.
 */
export async function pullBaselines(
    root: string,
    store: R2Store
): Promise<{ downloaded: number; cached: number; deleted: number }> {
    const manifest = loadManifest(root);
    if (!manifest) throw new Error(`no fetched ${MANIFEST_PATH} — run \`npm run screenshots:fetch-manifest\` first`);
    const base = path.join(root, BASELINE_ROOT);
    const wanted = new Map<string, ManifestEntry>();
    for (const e of manifest.screenshots) wanted.set(`${e.engine}/${e.name}`, e);

    let downloaded = 0;
    let cached = 0;
    const errors: string[] = [];
    await pool([...wanted.values()], CONCURRENCY, async (e) => {
        const dest = path.join(base, e.engine, e.name);
        // Size is a cheap pre-filter: only pay the full read + hash when it can match.
        if (fs.existsSync(dest) && fs.statSync(dest).size === e.bytes && hashFile(dest) === e.sha256) {
            cached++;
            return;
        }
        try {
            const bytes = await store.get(e.sha256);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tmp = `${dest}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, bytes);
            fs.renameSync(tmp, dest);
            downloaded++;
        } catch (err) {
            errors.push(`${e.engine}/${e.name}: ${(err as Error).message}`);
        }
    });

    let deleted = 0;
    for (const key of listEngineKeys(base)) {
        if (wanted.has(key)) continue;
        fs.rmSync(path.join(base, key), { force: true });
        deleted++;
    }

    if (errors.length) throw new Error(`${errors.length} object(s) failed:\n  ${errors.join('\n  ')}`);
    return { downloaded, cached, deleted };
}

/** HEAD every manifest hash; returns the missing keys. */
export async function verifyBaselines(root: string, store: R2Store): Promise<string[]> {
    const manifest = loadManifest(root);
    if (!manifest) throw new Error(`no fetched ${MANIFEST_PATH} — run \`npm run screenshots:fetch-manifest\` first`);
    const missing: string[] = [];
    await pool(manifest.screenshots, CONCURRENCY, async (e) => {
        if (!(await store.exists(e.sha256))) missing.push(`${e.engine}/${e.name} (${e.sha256})`);
    });
    return missing;
}

async function main(): Promise<void> {
    const mode = process.argv.find((a) => a === '--manifest' || a === '--pull' || a === '--verify');
    if (!mode) {
        console.error('usage: r2-sync.ts --manifest | --pull | --verify');
        process.exitCode = 2;
        return;
    }
    const root = process.cwd();

    if (mode === '--pull' && !loadManifest(root)) {
        console.log(`[r2-sync] no fetched ${MANIFEST_PATH} — skipping pull (run screenshots:fetch-manifest first)`);
        return; // exit 0: manifest fetch skipped/failed → the gate skips, never gates on stale data
    }
    const store = storeFromEnv();
    if (!store) {
        if (mode === '--manifest') {
            // Delete a stale copy so the downstream gate SKIPS instead of
            // comparing against whatever manifest a previous run left behind.
            fs.rmSync(path.join(root, MANIFEST_PATH), { force: true });
            console.log(`[r2-sync] R2 credentials unset (${missingEnv().join(', ')}) — skipping manifest fetch`);
            return; // exit 0: secretless CI callers stay green
        }
        if (mode === '--pull') {
            console.log(`[r2-sync] R2 credentials unset (${missingEnv().join(', ')}) — skipping baseline fetch`);
            return; // exit 0: secretless CI callers stay green
        }
        console.error(`[r2-sync] R2 credentials required for ${mode}: set ${missingEnv().join(', ')}`);
        process.exitCode = 2;
        return;
    }

    if (mode === '--manifest') {
        if (await fetchManifest(root, store)) {
            const manifest = loadManifest(root);
            console.log(`[r2-sync] fetched ${MANIFEST_PATH}: ${manifest?.screenshots.length ?? 0} baselines (updated ${manifest?.updatedAt ?? '?'} by ${manifest?.updatedBy ?? '?'})`);
        }
    } else if (mode === '--pull') {
        const { downloaded, cached, deleted } = await pullBaselines(root, store);
        console.log(`[r2-sync] pull done: downloaded=${downloaded} cached=${cached} deleted=${deleted}`);
    } else {
        const missing = await verifyBaselines(root, store);
        if (missing.length) {
            console.error(`[r2-sync] ${missing.length} manifest hash(es) MISSING in R2:\n  ${missing.join('\n  ')}`);
            process.exitCode = 1;
        } else {
            console.log('[r2-sync] verify ok — every manifest hash is present in R2');
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[r2-sync] ${(e as Error).message}`);
        process.exitCode = 1;
    });
}
