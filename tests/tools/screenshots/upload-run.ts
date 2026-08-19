/**
 * Upload this CI run's screenshot renders + a meta.json index to the private
 * R2 bucket, so the morelli review app (github.com/PCBJam/morelli) can list
 * builds and promote baselines from the UI.
 *
 * Key layout (30-day lifecycle rule on runs/ — objects expire, baselines don't):
 *   runs/pcbjam/<GITHUB_RUN_ID>/<engine>/<name>.png
 *   runs/pcbjam/<GITHUB_RUN_ID>/meta.json          ← written LAST = upload-complete marker
 *
 * The meta.json schema is MIRRORED from morelli's src/shared/schemas.ts
 * (RunMeta, schemaVersion 1) — that file is canonical; change it first.
 *
 * Workflow re-runs reuse GITHUB_RUN_ID, so a re-run overwrites the prefix
 * (meta.json records runAttempt; last attempt wins — deliberate).
 *
 * Needs the WRITE keypair (CI maps CI_SCREENSHOTS_S3_WRITE_* GH secrets onto
 * the standard env names for this step only). Without credentials it warns and
 * exits 0, like r2-sync --pull — screenshot uploads never fail a build.
 *
 * CLI (from tests/):  tsx tools/screenshots/upload-run.ts --e2e pass|fail
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { DIFF_OUT_DIR, RESULTS_DIR, isIgnored, listEngineKeys, splitKey } from './config';
import { hashBytes, missingEnv, storeFromEnv, type R2Store } from './r2-store';
import { pool } from './r2-sync';
import { loadPng } from './image-ops';

const PIPELINE = 'pcbjam';
const META_SCHEMA_VERSION = 1;
const UPLOAD_CONCURRENCY = 8;

type RunScreenshot = { name: string; engine: string; sha256: string; bytes: number; width: number; height: number };

function runPrefix(runId: string): string {
    return `runs/${PIPELINE}/${runId}/`;
}

function gitSubject(): string {
    try {
        return execFileSync('git', ['log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

function prNumber(): number | null {
    const m = /^refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '');
    return m ? Number(m[1]) : null;
}

/** Compress compare.ts's report.json (if this run produced one) into the meta summary. */
function reportSummary(root: string): object | undefined {
    const p = path.join(root, DIFF_OUT_DIR, 'report.json');
    if (!fs.existsSync(p)) return undefined;
    try {
        const report = JSON.parse(fs.readFileSync(p, 'utf8')) as {
            changed: Array<{ name: string; changedRatio: number; driftHint: string | null }>;
            added: Array<{ name: string }>;
            removed: Array<{ name: string }>;
            unchangedCount: number;
            driftLikely: boolean;
        };
        return {
            changed: report.changed.map((c) => ({ ...splitKey(c.name), changedRatio: c.changedRatio, driftHint: c.driftHint })),
            added: report.added.map((a) => a.name),
            removed: report.removed.map((r) => r.name),
            unchangedCount: report.unchangedCount,
            driftLikely: report.driftLikely,
        };
    } catch (e) {
        console.warn(`[upload-run] unreadable ${DIFF_OUT_DIR}/report.json — omitting summary: ${(e as Error).message}`);
        return undefined;
    }
}

export async function uploadRun(root: string, store: R2Store, runId: string, e2e: string): Promise<number> {
    const resultsDir = path.join(root, RESULTS_DIR);
    // Engine-qualified renders only; screenshot-diff/ isn't an engine dir so
    // listEngineKeys never picks up compare artifacts.
    const keys = listEngineKeys(resultsDir).filter((k) => !isIgnored(k));
    if (keys.length === 0) {
        console.warn(`[upload-run] no renders under ${RESULTS_DIR}/{chromium,firefox,webkit} — nothing to upload`);
        return 0;
    }

    const screenshots: RunScreenshot[] = keys
        .map((key) => {
            const file = path.join(resultsDir, key);
            const bytes = fs.readFileSync(file);
            const png = loadPng(file);
            const { engine, name } = splitKey(key);
            return { name, engine, sha256: hashBytes(bytes), bytes: bytes.length, width: png.width, height: png.height };
        })
        .sort((a, b) => (a.engine !== b.engine ? (a.engine < b.engine ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const prefix = runPrefix(runId);
    await pool(screenshots, UPLOAD_CONCURRENCY, async (shot) => {
        const bytes = fs.readFileSync(path.join(resultsDir, `${shot.engine}/${shot.name}`));
        await store.putKey(`${prefix}${shot.engine}/${shot.name}`, bytes, 'image/png');
    });

    const meta = {
        schemaVersion: META_SCHEMA_VERSION,
        pipeline: PIPELINE,
        repo: process.env.GITHUB_REPOSITORY ?? 'PCBJam/pcbjam',
        runId,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
        workflow: process.env.GITHUB_WORKFLOW ?? '',
        event: process.env.GITHUB_EVENT_NAME ?? '',
        branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '',
        prNumber: prNumber(),
        commit: process.env.GITHUB_SHA ?? '',
        commitSubject: gitSubject(),
        uploadedAt: new Date().toISOString(),
        e2e: e2e === 'pass' || e2e === 'fail' ? e2e : 'unknown',
        screenshots,
        ...(reportSummary(root) ? { report: reportSummary(root) } : {}),
    };
    // meta.json goes LAST: its presence is the upload-complete marker the app keys on.
    await store.putKey(`${prefix}meta.json`, Buffer.from(JSON.stringify(meta, null, 2) + '\n'), 'application/json');
    return screenshots.length;
}

async function main(): Promise<void> {
    const e2eIdx = process.argv.indexOf('--e2e');
    const e2e = e2eIdx !== -1 ? (process.argv[e2eIdx + 1] ?? 'unknown') : 'unknown';
    const runId = process.env.GITHUB_RUN_ID;
    if (!runId || !/^\d+$/.test(runId)) {
        console.warn('[upload-run] GITHUB_RUN_ID unset — not a CI run, skipping');
        return;
    }
    const store = storeFromEnv();
    if (!store) {
        console.warn(`[upload-run] R2 credentials unset (${missingEnv().join(', ')}) — skipping run upload`);
        return;
    }
    const count = await uploadRun(process.cwd(), store, runId, e2e);
    if (count > 0) console.log(`[upload-run] uploaded ${count} screenshots + meta.json to ${runPrefix(runId)}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[upload-run] ${(e as Error).message}`);
        process.exitCode = 1;
    });
}
