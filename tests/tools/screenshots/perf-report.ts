/**
 * Renders the track-only runtime-perf block for the CI-on-main Discord comment.
 *
 * The perf e2e (tests/kicad/{eeschema,pcbnew}-perf.spec.ts) already writes
 * test-results/perf-{app}.json — schema { app, when, loadMs, openMs, fps:[{throttle,fps,galFps}] }.
 * We read those, fetch the PREVIOUS successful main run's perf via `gh run
 * download` (so we can show a Δ without committing a baseline — stays
 * no-write-back), and format an aligned monospace table (Discord doesn't render
 * markdown tables, so it goes in a ``` code block).
 *
 * Track-only: nothing here gates the build. A regression past REGRESSION_PCT on
 * the stable metrics (loadMs/openMs) is only flagged (a `*`), never failed. Both
 * FPS columns are measured on CI's software rasteriser (ANGLE over Mesa llvmpipe,
 * under Xvfb — there is no GPU on the runner), so they are a regression signal
 * only and never a user-facing frame rate.
 *
 * CLI (from tests/):
 *   tsx tools/screenshots/perf-report.ts [--results DIR] [--prev DIR] [--repo owner/repo]
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { RESULTS_DIR } from './config';

export const PERF_APPS = ['eeschema', 'pcbnew'] as const;
const REGRESSION_PCT = 10; // stable-metric regression past this is flagged with `*`
const CI_WORKFLOW = 'ci-ubicloud.yml';

/** `fps` is the legacy rAF tick count; `galFps` is the real frame rate. */
export type Fps = { throttle: number; fps: number; galFps?: number };
export type PerfData = { app: string; when?: string; loadMs: number; openMs: number; fps: Fps[] };

export function readPerf(dir: string): Map<string, PerfData> {
    const out = new Map<string, PerfData>();
    for (const app of PERF_APPS) {
        const p = path.join(dir, `perf-${app}.json`);
        if (!fs.existsSync(p)) continue;
        try {
            out.set(app, JSON.parse(fs.readFileSync(p, 'utf8')) as PerfData);
        } catch (e) {
            console.warn(`[perf] could not parse ${p}: ${(e as Error).message}`);
        }
    }
    return out;
}

/**
 * Best-effort fetch of the previous successful main CI run's perf JSONs into a
 * temp dir. Returns the dir, or null if gh is unavailable / no prior run.
 * `currentSha` is skipped so a re-run doesn't diff against itself.
 */
export function fetchPreviousPerf(repo: string | undefined, currentSha: string | undefined): string | null {
    try {
        const gh = (args: string[]) =>
            execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const repoArgs = repo ? ['--repo', repo] : [];
        const runs = JSON.parse(
            gh([
                'run', 'list', '--workflow', CI_WORKFLOW, '--branch', 'main', '--status', 'success',
                '--limit', '15', '--json', 'databaseId,headSha', ...repoArgs,
            ])
        ) as Array<{ databaseId: number; headSha: string }>;
        const prev = runs.find((r) => r.headSha !== currentSha);
        if (!prev) return null;
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-prev-'));
        // Artifact is named ubicloud-e2e-<run_id>; -D extracts it under tmp/<artifact>/...
        gh(['run', 'download', String(prev.databaseId), '-D', tmp, ...repoArgs]);
        // Find the dir that actually holds the perf-*.json (artifact nests test-results/).
        const hit = findPerfDir(tmp);
        return hit;
    } catch {
        return null;
    }
}

function findPerfDir(root: string): string | null {
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        if (entries.some((e) => e.isFile() && /^perf-\w+\.json$/.test(e.name))) return dir;
        for (const e of entries) if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
    return null;
}

function pct(cur: number, prev: number): number {
    return prev === 0 ? 0 : ((cur - prev) / prev) * 100;
}

/** Format a stable-metric value with a Δ vs previous (lower is better). */
function fmtMetric(cur: number, prev?: number): string {
    if (prev === undefined) return `${cur}`;
    const p = pct(cur, prev);
    const arrow = p < 0 ? '▼' : p > 0 ? '▲' : '·';
    const flag = p > REGRESSION_PCT ? '*' : ''; // regression (slower) beyond threshold
    return `${cur} ${arrow}${Math.abs(p).toFixed(0)}%${flag}`;
}

/**
 * GAL fps with a Δ vs the previous main run, flagged on REGRESSION.
 *
 * Higher is better here, so the sign convention is inverted relative to
 * fmtMetric: a DROP past the threshold gets the `*`. Only the 1x-throttle
 * number drives the flag — it is the one that repeats within ~2% (pan-only
 * drive, zoom-to-fit before each measurement), so it is safe to act on.
 * CI has no GPU, so this is a software-rasteriser redraw rate: useful precisely
 * because it is consistent, not because it is the user-facing frame rate.
 */
function fmtGalFps(fps: Fps[], prev?: Fps[]): string {
    const triple = fmtFps(fps, 'galFps');
    const cur = fps.find((f) => f.throttle === 1)?.galFps;
    const was = prev?.find((f) => f.throttle === 1)?.galFps;
    if (cur === undefined || was === undefined || was === 0) return triple;
    const p = pct(cur, was); // + = faster than before
    const arrow = p > 0 ? '▲' : p < 0 ? '▼' : '·';
    const flag = -p > REGRESSION_PCT ? '*' : '';
    return `${triple} ${arrow}${Math.abs(p).toFixed(0)}%${flag}`;
}

function fmtFps(fps: Fps[], key: 'fps' | 'galFps' = 'fps'): string {
    return [1, 4, 6].map((t) => {
        const hit = fps.find((f) => f.throttle === t);
        const v = hit?.[key];
        return v === undefined ? '–' : Math.round(v);
    }).join('/');
}

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export type PerfReport = { block: string; regressed: boolean };

/** Build the fenced code-block perf table for the Discord comment. */
export function buildPerfReport(opts: { resultsDir?: string; prevDir?: string | null } = {}): PerfReport {
    const cur = readPerf(opts.resultsDir ?? RESULTS_DIR);
    if (cur.size === 0) return { block: '', regressed: false };
    const prev = opts.prevDir ? readPerf(opts.prevDir) : new Map<string, PerfData>();

    const headers = ['app', 'loadMs (Δ)', 'openMs (Δ)', 'GAL fps 1/4/6 (Δ@1x)', 'rAF 1/4/6'];
    const rows: string[][] = [];
    let regressed = false;
    for (const app of PERF_APPS) {
        const c = cur.get(app);
        if (!c) continue;
        const p = prev.get(app);
        const loadCell = fmtMetric(c.loadMs, p?.loadMs);
        const openCell = fmtMetric(c.openMs, p?.openMs);
        const galCell = fmtGalFps(c.fps, p?.fps);
        if (loadCell.endsWith('*') || openCell.endsWith('*') || galCell.endsWith('*')) regressed = true;
        rows.push([app, loadCell, openCell, galCell, fmtFps(c.fps, 'fps')]);
    }
    if (rows.length === 0) return { block: '', regressed: false };

    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join('  ');
    const body = [line(headers), rows.map((r) => line(r)).join('\n')].join('\n');
    const footnote = `${prev.size ? 'Δ vs previous main run. ' : 'no prior main run for Δ. '}` +
        `* = >${REGRESSION_PCT}% slower (track-only, non-gating). ` +
        `GAL fps = completed GAL frames on CI's software rasteriser (llvmpipe) — a regression signal, ` +
        `NOT user-facing frame rate; its Δ/* are computed on the 1x number. rAF is the legacy tick count, ` +
        `kept for continuity: it ticks on the compositor's schedule whether or not anything rendered, so ` +
        `it can read 120 while the renderer is stalled.`;
    return { block: '**Runtime perf** (eeschema + pcbnew)\n```\n' + body + '\n```\n' + footnote, regressed };
}

function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--results') out.results = argv[++i];
        else if (a === '--prev') out.prev = argv[++i];
        else if (a === '--repo') out.repo = argv[++i];
    }
    return out;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const prevDir = args.prev ?? fetchPreviousPerf(args.repo || process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA);
    const { block, regressed } = buildPerfReport({ resultsDir: args.results, prevDir });
    process.stdout.write((block || '(no perf-*.json found)') + '\n');
    if (regressed) console.error('[perf] a stable metric regressed >10% vs previous main (track-only, not failing)');
}

if (require.main === module) main();
