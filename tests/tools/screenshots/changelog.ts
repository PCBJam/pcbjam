/**
 * Baseline changelog (Discord trigger B) — no build, no GPU.
 *
 * On push to main, diff the committed screenshot MANIFEST between two commits
 * and post a "Baseline changelog" to Discord: a triptych (old | new+boxes |
 * heatmap) for each CHANGED baseline, the image for each ADDED, and a titled
 * line for each REMOVED. "added / removed" only mean anything as a git-history
 * diff, which is why this is separate from the re-render drift gate.
 *
 * The PNGs themselves are not in git — each manifest entry pins a sha256 and
 * the bytes are fetched from the R2 CAS bucket (objects are immutable, so the
 * base rev's hashes are always still resolvable). Needs the read credential
 * pair; a base rev whose manifest predates the R2 migration (v1) is skipped so
 * the migration commit itself doesn't post hundreds of bogus entries.
 *
 * CLI (from tests/):
 *   tsx tools/screenshots/changelog.ts [--base REV] [--head REV] [--dry-run] [--force]
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PNG } from 'pngjs';
import { DIFF_OUT_DIR, MANIFEST_PATH, MANIFEST_VERSION, floorFor, labelText, splitKey, LABEL, type Manifest } from './config';
import { comparePair, type Report } from './compare';
import { savePng, withBottomLabel } from './image-ops';
import { buildSpecResolver } from './spec-map';
import { buildAttachments, paginate, postMessage } from './post-discord';
import { missingEnv, storeFromEnv, type R2Store } from './r2-store';

function git(root: string, args: string[]): string {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/** The screenshot manifest as committed at `rev`, or null if absent/unparsable. */
function manifestAt(repoRoot: string, rev: string, repoPath: string): Manifest | null {
    try {
        return JSON.parse(execFileSync('git', ['-C', repoRoot, 'show', `${rev}:${repoPath}`], { encoding: 'utf8' })) as Manifest;
    } catch {
        return null;
    }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--force') out.force = true;
        else if (a === '--base') out.base = argv[++i];
        else if (a === '--head') out.head = argv[++i];
    }
    return out;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const cwd = process.cwd();
    const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
    const head = (args.head as string) || 'HEAD';
    let base = (args.base as string) || '';
    if (!base) {
        try {
            base = git(cwd, ['rev-parse', `${head}^`]);
        } catch {
            console.log('[changelog] no parent commit — nothing to diff');
            return;
        }
    }

    // Repo-relative manifest path (e.g. tests/screenshot-manifest.json).
    const manifestPath = path.relative(repoRoot, path.join(cwd, MANIFEST_PATH)).split(path.sep).join('/');
    const baseManifest = manifestAt(repoRoot, base, manifestPath);
    const headManifest = manifestAt(repoRoot, head, manifestPath);
    if (headManifest?.version !== MANIFEST_VERSION) {
        console.log('[changelog] head manifest is not v2 — nothing to diff');
        return;
    }
    if (baseManifest?.version !== MANIFEST_VERSION) {
        console.log('[changelog] base manifest predates the R2 migration — skipping (migration commit)');
        return;
    }

    // Engine-qualified key (`<engine>/<name>`) → sha256, per rev.
    const hashesOf = (m: Manifest): Map<string, string> =>
        new Map(m.screenshots.map((e) => [`${e.engine}/${e.name}`, e.sha256]));
    const baseHashes = hashesOf(baseManifest);
    const headHashes = hashesOf(headManifest);
    const added = [...headHashes.keys()].filter((k) => !baseHashes.has(k));
    const removed = [...baseHashes.keys()].filter((k) => !headHashes.has(k));
    const changed = [...headHashes.keys()].filter((k) => baseHashes.has(k) && baseHashes.get(k) !== headHashes.get(k));
    if (!added.length && !removed.length && !changed.length) {
        console.log('[changelog] no baseline changes between', base.slice(0, 7), 'and', head);
        return;
    }

    const store = storeFromEnv();
    if (!store) {
        console.error(`[changelog] R2 credentials required to fetch baseline bytes: set ${missingEnv().join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const outDir = path.join(cwd, DIFF_OUT_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const report: Report = {
        generatedFor: process.env.GITHUB_SHA || head,
        changed: [],
        added: [],
        removed: [],
        unchangedCount: 0,
        driftLikely: false,
    };
    const { specFor } = buildSpecResolver(cwd);

    const hashPng = async (s: R2Store, hash: string): Promise<PNG> => PNG.sync.read(await s.get(hash));
    // Save a single captioned image (added/removed) and record it in the report.
    const saveSingle = (img: PNG, key: string, status: 'added' | 'removed'): void => {
        const rel = path.join(DIFF_OUT_DIR, `${key.replace('/', '_')}.${status}.png`);
        savePng(path.join(cwd, rel), withBottomLabel(img, labelText(status, key, specFor(splitKey(key).name)), LABEL.colors[status]));
        report[status].push({ name: key, image: rel });
    };

    for (const key of added) saveSingle(await hashPng(store, headHashes.get(key)!), key, 'added');
    for (const key of removed) saveSingle(await hashPng(store, baseHashes.get(key)!), key, 'removed');
    for (const key of changed) {
        const oldImg = await hashPng(store, baseHashes.get(key)!);
        const newImg = await hashPng(store, headHashes.get(key)!);
        const { result, heatmap, triptych } = comparePair(oldImg, newImg, key, floorFor(key));
        const triptychRel = path.join(DIFF_OUT_DIR, `${key.replace('/', '_')}.triptych.png`);
        const heatmapRel = path.join(DIFF_OUT_DIR, `${key.replace('/', '_')}.heatmap.png`);
        savePng(path.join(cwd, triptychRel), withBottomLabel(triptych, labelText('changed', key, specFor(splitKey(key).name)), LABEL.colors.changed));
        savePng(path.join(cwd, heatmapRel), heatmap);
        report.changed.push({ ...result, triptych: triptychRel, heatmap: heatmapRel });
    }
    report.changed.sort((a, b) => b.changedRatio - a.changedRatio);

    const sha7 = (process.env.GITHUB_SHA || head).slice(0, 7);
    let subject = '';
    try {
        subject = git(cwd, ['log', '-1', '--pretty=%s', head]);
    } catch { /* ignore */ }
    const header =
        `🗂️ **Baseline changelog** · \`${sha7}\`` +
        (subject ? `\n> ${subject}` : '') +
        `\n${report.changed.length} changed, ${report.added.length} added, ${report.removed.length} removed` +
        (report.removed.length ? '\n➖ REMOVED: ' + report.removed.map((r) => `\`${r.name}\``).join(', ') : '');

    const { files, notes } = buildAttachments(cwd, report);
    const messages = paginate(header + (notes.length ? '\n' + notes.join('\n') : ''), files);

    const isMainPush = process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_EVENT_NAME === 'push';
    if (args.dryRun || (!args.force && !isMainPush)) {
        for (const [i, m] of messages.entries()) {
            console.log(`--- message ${i + 1}/${messages.length} (${m.files.length} files) ---`);
            if (m.content) console.log(m.content);
            for (const f of m.files) console.log(`  [attach] ${f.name} (${f.buffer.length} bytes)`);
        }
        if (!args.dryRun) console.log('[changelog] not a push to main — not posting');
        return;
    }
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!webhook) {
        console.log('[changelog] DISCORD_WEBHOOK_URL unset — skipping');
        return;
    }
    for (const m of messages) await postMessage(webhook, m);
    console.log(`[changelog] posted ${messages.length} message(s)`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[changelog] ${e.message}`);
        process.exitCode = 1;
    });
}
