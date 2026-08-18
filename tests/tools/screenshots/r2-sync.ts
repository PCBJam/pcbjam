/**
 * Sync the local baseline-screenshots/ cache with the R2 CAS bucket.
 *
 * The committed manifest (screenshot-manifest.json) is the source of truth;
 * baseline-screenshots/ is a gitignored local cache materialized from it.
 *
 * CLI (from tests/):
 *   tsx tools/screenshots/r2-sync.ts --pull     # manifest → local tree (CI fetch step + local gate)
 *   tsx tools/screenshots/r2-sync.ts --push     # upload manifest entries missing in R2 (seeding)
 *   tsx tools/screenshots/r2-sync.ts --verify   # HEAD every manifest hash, exit 1 on any miss
 *
 * --pull without credentials (or with a pre-migration manifest) warns and
 * exits 0, so secretless callers of the reusable CI workflow (release.yml,
 * pcbjam deploy-staging.yml, fork PRs) stay green — compare.ts then skips its
 * gate for the same reason. With credentials, any 404/corrupt object is
 * collected and the run exits 1.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BASELINE_ROOT, MANIFEST_PATH, MANIFEST_VERSION, listEngineKeys, type Manifest, type ManifestEntry } from './config';
import { R2Store, hashFile, missingEnv, storeFromEnv } from './r2-store';

const CONCURRENCY = 16;

/** Parse the committed manifest if it is the R2-backed v2 format, else null. */
export function loadManifestV2(root: string): Manifest | null {
    const p = path.join(root, MANIFEST_PATH);
    if (!fs.existsSync(p)) return null;
    try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
        return m.version === MANIFEST_VERSION ? m : null;
    } catch {
        return null;
    }
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
    const manifest = loadManifestV2(root);
    if (!manifest) throw new Error(`no v2 ${MANIFEST_PATH} — nothing to pull`);
    const base = path.join(root, BASELINE_ROOT);
    const wanted = new Map<string, ManifestEntry>();
    for (const e of manifest.screenshots) wanted.set(`${e.engine}/${e.name}`, e);

    let downloaded = 0;
    let cached = 0;
    const errors: string[] = [];
    await pool([...wanted.values()], CONCURRENCY, async (e) => {
        const dest = path.join(base, e.engine, e.name);
        if (fs.existsSync(dest) && hashFile(dest) === e.sha256) {
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

/** Upload every manifest entry's local file to R2 (skipping hashes already present). */
export async function pushBaselines(root: string, store: R2Store): Promise<{ uploaded: number; existing: number }> {
    const manifest = loadManifestV2(root);
    if (!manifest) throw new Error(`no v2 ${MANIFEST_PATH} — run \`npm run screenshots:manifest\` first`);
    const base = path.join(root, BASELINE_ROOT);
    let uploaded = 0;
    let existing = 0;
    const errors: string[] = [];
    await pool(manifest.screenshots, CONCURRENCY, async (e) => {
        const file = path.join(base, e.engine, e.name);
        try {
            if (!fs.existsSync(file)) throw new Error('local file missing');
            const bytes = fs.readFileSync(file);
            const hash = hashFile(file);
            if (hash !== e.sha256) throw new Error(`local sha256 ${hash} ≠ manifest — regenerate the manifest`);
            if ((await store.put(hash, bytes)) === 'uploaded') uploaded++;
            else existing++;
        } catch (err) {
            errors.push(`${e.engine}/${e.name}: ${(err as Error).message}`);
        }
    });
    if (errors.length) throw new Error(`${errors.length} upload(s) failed:\n  ${errors.join('\n  ')}`);
    return { uploaded, existing };
}

/** HEAD every manifest hash; returns the missing keys. */
export async function verifyBaselines(root: string, store: R2Store): Promise<string[]> {
    const manifest = loadManifestV2(root);
    if (!manifest) throw new Error(`no v2 ${MANIFEST_PATH}`);
    const missing: string[] = [];
    await pool(manifest.screenshots, CONCURRENCY, async (e) => {
        if (!(await store.exists(e.sha256))) missing.push(`${e.engine}/${e.name} (${e.sha256})`);
    });
    return missing;
}

async function main(): Promise<void> {
    const mode = process.argv.find((a) => a === '--pull' || a === '--push' || a === '--verify');
    if (!mode) {
        console.error('usage: r2-sync.ts --pull | --push | --verify');
        process.exitCode = 2;
        return;
    }
    const root = process.cwd();

    if (mode === '--pull' && !loadManifestV2(root)) {
        console.log(`[r2-sync] ${MANIFEST_PATH} is not the R2-backed v2 format — nothing to fetch`);
        return;
    }
    const store = storeFromEnv();
    if (!store) {
        if (mode === '--pull') {
            console.log(`[r2-sync] R2 credentials unset (${missingEnv().join(', ')}) — skipping baseline fetch`);
            return; // exit 0: secretless CI callers stay green
        }
        console.error(`[r2-sync] R2 credentials required for ${mode}: set ${missingEnv().join(', ')}`);
        process.exitCode = 2;
        return;
    }

    if (mode === '--pull') {
        const { downloaded, cached, deleted } = await pullBaselines(root, store);
        console.log(`[r2-sync] pull done: downloaded=${downloaded} cached=${cached} deleted=${deleted}`);
    } else if (mode === '--push') {
        const { uploaded, existing } = await pushBaselines(root, store);
        console.log(`[r2-sync] push done: uploaded=${uploaded} already-present=${existing}`);
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
