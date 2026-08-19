/**
 * The one screenshot comparison engine + its CLI.
 *
 * Run modes (from the `tests/` directory):
 *   tsx tools/screenshots/compare.ts                 # gate: baselines vs test-results
 *   tsx tools/screenshots/compare.ts --fail-on-change  # same, but exit 1 on any change
 *   tsx tools/screenshots/compare.ts --pair OLD NEW --name N --out DIR   # diff two files
 *
 * The gate mode classifies every screenshot into changed / added / removed /
 * unchanged, writes per-change triptych + heatmap PNGs and a machine-readable
 * report.json into DIFF_OUT_DIR, and (unless --fail-on-change) exits 0 so it can
 * run report-only first. post-discord.ts and the changelog workflow import the
 * exported helpers rather than re-deriving the diff.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import {
    BASELINE_ROOT,
    RESULTS_DIR,
    DIFF_OUT_DIR,
    MANIFEST_PATH,
    type EngineFloor,
    type Manifest,
    floorFor,
    isIgnored,
    labelText,
    listEngineKeys,
    splitKey,
    LABEL,
} from './config';
import { diffImages, cluster, drawBoxes, composite, loadPng, savePng, withBottomLabel, type Box } from './image-ops';
import { buildSpecResolver } from './spec-map';

export type PairVerdict = 'unchanged' | 'changed';

export type PairResult = {
    name: string;
    verdict: PairVerdict;
    dimsMatch: boolean;
    diffPixels: number;
    changedRatio: number;
    meanChannelDiff: number;
    boxes: Box[];
    /** heuristic: a broad, low-intensity change smells like host env drift, not a code regression */
    driftHint: 'regression-like' | 'drift-like' | null;
};

/** Broad + low-intensity ⇒ likely environment drift rather than a localized regression. */
function driftHint(changed: boolean, changedRatio: number, meanChannelDiff: number): PairResult['driftHint'] {
    if (!changed) return null;
    return changedRatio > 0.05 && meanChannelDiff < 4 ? 'drift-like' : 'regression-like';
}

/** Compare two decoded PNGs; returns the verdict/metrics plus the heatmap and old|new+boxes|heatmap triptych. */
export function comparePair(
    oldPng: PNG,
    newPng: PNG,
    name: string,
    floor: EngineFloor
): { result: PairResult; heatmap: PNG; triptych: PNG } {
    const d = diffImages(oldPng, newPng);
    const changed = !d.dimsMatch || d.changedRatio > floor.changedRatio;
    const boxes = changed ? cluster(d.mask, d.width, d.height) : [];
    const triptych = composite([oldPng, drawBoxes(newPng, boxes), d.heatmap]);
    return {
        result: {
            name,
            verdict: changed ? 'changed' : 'unchanged',
            dimsMatch: d.dimsMatch,
            diffPixels: d.diffPixels,
            changedRatio: d.changedRatio,
            meanChannelDiff: d.meanChannelDiff,
            boxes,
            driftHint: driftHint(changed, d.changedRatio, d.meanChannelDiff),
        },
        heatmap: d.heatmap,
        triptych,
    };
}

export type ChangedEntry = PairResult & { triptych: string; heatmap: string };
export type Report = {
    generatedFor: string | null;
    changed: ChangedEntry[];
    added: Array<{ name: string; image: string }>;
    removed: Array<{ name: string; image: string }>;
    unchangedCount: number;
    /** many changes, mostly drift-like ⇒ probably a host Mesa/font refresh; re-promote rather than debug */
    driftLikely: boolean;
};

const DRIFT_BULK = 20;

/** key (`<engine>/<name>`) → absolute baseline path. */
function baselineIndex(root: string): Map<string, string> {
    const abs = path.join(root, BASELINE_ROOT);
    const index = new Map<string, string>();
    for (const key of listEngineKeys(abs)) index.set(key, path.join(abs, key));
    return index;
}

function loadManifest(root: string): Manifest | undefined {
    const p = path.join(root, MANIFEST_PATH);
    if (!fs.existsSync(p)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
    } catch (e) {
        console.warn(`[compare] could not parse ${MANIFEST_PATH}: ${(e as Error).message}`);
        return undefined;
    }
}

/** Flat, collision-free artifact filename for an engine-qualified key. */
function artifactName(key: string, suffix: string): string {
    return `${key.replace('/', '_')}.${suffix}.png`;
}

/** Full gate run: classify baselines vs the current run's screenshots, per engine. */
export function classify(root: string, sha: string | null): Report {
    const baselines = baselineIndex(root);
    const resultsDir = path.join(root, RESULTS_DIR);
    const actuals = new Set(listEngineKeys(resultsDir));
    // Drop excluded screenshots from both sides so they're never compared or counted.
    for (const key of [...baselines.keys()]) if (isIgnored(key)) baselines.delete(key);
    for (const key of [...actuals]) if (isIgnored(key)) actuals.delete(key);
    const manifest = loadManifest(root);
    const outDir = path.join(root, DIFF_OUT_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const { specFor } = buildSpecResolver(root); // bare name → spec, for the caption strip

    const report: Report = {
        generatedFor: sha,
        changed: [],
        added: [],
        removed: [],
        unchangedCount: 0,
        driftLikely: false,
    };

    // Changed / unchanged / removed: iterate the committed baselines.
    for (const [key, baselinePath] of baselines) {
        const { engine, name } = splitKey(key);
        if (!actuals.has(key)) {
            // Missing output. Only call it REMOVED when the manifest expects it — otherwise
            // a flaky/OOM'd/skipped spec that simply didn't write a PNG would masquerade as
            // an intentional removal. (The stronger "did the spec actually run" cross-check
            // against the Playwright JSON report lands with the manifest work.)
            if (manifest?.screenshots.some((e) => e.name === name && e.engine === engine)) {
                // Removed now gets a captioned image (the old baseline) so it's visible in Discord.
                const imageRel = path.join(DIFF_OUT_DIR, artifactName(key, 'removed'));
                const labeled = withBottomLabel(loadPng(baselinePath), labelText('removed', key, specFor(name)), LABEL.colors.removed);
                savePng(path.join(root, imageRel), labeled);
                report.removed.push({ name: key, image: imageRel });
            }
            continue;
        }
        const { result, heatmap, triptych } = comparePair(
            loadPng(baselinePath),
            loadPng(path.join(resultsDir, key)),
            key,
            floorFor(key)
        );
        if (result.verdict === 'unchanged') {
            report.unchangedCount++;
            continue;
        }
        const triptychRel = path.join(DIFF_OUT_DIR, artifactName(key, 'triptych'));
        const heatmapRel = path.join(DIFF_OUT_DIR, artifactName(key, 'heatmap'));
        savePng(path.join(root, triptychRel), withBottomLabel(triptych, labelText('changed', key, specFor(name)), LABEL.colors.changed));
        savePng(path.join(root, heatmapRel), heatmap);
        report.changed.push({ ...result, triptych: triptychRel, heatmap: heatmapRel });
    }

    // Added: an actual with no committed baseline.
    for (const key of actuals) {
        if (baselines.has(key)) continue;
        const imageRel = path.join(DIFF_OUT_DIR, artifactName(key, 'added'));
        const labeled = withBottomLabel(loadPng(path.join(resultsDir, key)), labelText('added', key, specFor(splitKey(key).name)), LABEL.colors.added);
        savePng(path.join(root, imageRel), labeled);
        report.added.push({ name: key, image: imageRel });
    }

    const driftLike = report.changed.filter((c) => c.driftHint === 'drift-like').length;
    report.driftLikely = report.changed.length >= DRIFT_BULK && driftLike * 2 >= report.changed.length;

    report.changed.sort((a, b) => b.changedRatio - a.changedRatio);
    report.added.sort((a, b) => a.name.localeCompare(b.name));
    report.removed.sort((a, b) => a.name.localeCompare(b.name));
    return report;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--fail-on-change') out.failOnChange = true;
        else if (a === '--pair') {
            out.oldPath = argv[++i];
            out.newPath = argv[++i];
        } else if (a === '--name') out.name = argv[++i];
        else if (a === '--out') out.out = argv[++i];
        else if (a === '--sha') out.sha = argv[++i];
    }
    return out;
}

function runPair(args: Record<string, string | boolean>): void {
    const name = (args.name as string) || 'pair';
    const outDir = (args.out as string) || path.join(RESULTS_DIR, 'screenshot-diff');
    fs.mkdirSync(outDir, { recursive: true });
    const oldPng = fs.existsSync(args.oldPath as string)
        ? loadPng(args.oldPath as string)
        : new PNG({ width: 1, height: 1 });
    const newPng = fs.existsSync(args.newPath as string)
        ? loadPng(args.newPath as string)
        : new PNG({ width: 1, height: 1 });
    const { result, heatmap, triptych } = comparePair(oldPng, newPng, name, floorFor(name));
    savePng(path.join(outDir, `${name}.triptych.png`), triptych);
    savePng(path.join(outDir, `${name}.heatmap.png`), heatmap);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (args.oldPath && args.newPath) {
        runPair(args);
        return;
    }
    const root = process.cwd();
    // Baselines are a local cache fetched from R2 (`npm run screenshots:fetch`).
    // The gate only runs against a COMPLETE cache: a partial one (an R2 blip on
    // a few objects — the CI fetch step is continue-on-error) would misreport
    // the un-fetched baselines' renders as ADDED and silently disable removed-
    // detection for them. Fully missing = fetch skipped (no credentials) or a
    // dev who hasn't fetched. Either way skip without writing report.json —
    // post-discord posts a distinct "gate SKIPPED" line when it's absent.
    const gateManifest = loadManifest(root);
    const wanted = (gateManifest?.screenshots ?? []).filter((e) => !isIgnored(`${e.engine}/${e.name}`));
    const missing = wanted.filter((e) => !fs.existsSync(path.join(root, BASELINE_ROOT, e.engine, e.name)));
    if (wanted.length && missing.length) {
        const what = missing.length === wanted.length ? 'empty' : `INCOMPLETE (${missing.length}/${wanted.length} missing — partial fetch?)`;
        console.log(`[compare] baseline cache is ${what} — run \`npm run screenshots:fetch\` (needs R2 credentials); skipping`);
        return;
    }
    const report = classify(root, (args.sha as string) || process.env.GITHUB_SHA || null);
    fs.writeFileSync(path.join(root, DIFF_OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    const { changed, added, removed, unchangedCount, driftLikely } = report;
    console.log(
        `[compare] changed=${changed.length} added=${added.length} removed=${removed.length} ` +
            `unchanged=${unchangedCount}${driftLikely ? ' (looks like environment drift → re-promote)' : ''}`
    );
    for (const c of changed.slice(0, 10)) {
        console.log(`  CHANGED ${c.name} ratio=${(c.changedRatio * 100).toFixed(3)}% ${c.driftHint}`);
    }
    if (args.failOnChange && (changed.length || added.length || removed.length)) {
        process.exitCode = 1;
    }
}

if (require.main === module) main();
