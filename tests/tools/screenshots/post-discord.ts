/**
 * The always-on CI-on-main Discord report.
 *
 * One message leads with the commit SHA + e2e pass/fail + the runtime-perf table
 * (perf-report.ts), then screenshot changes are attached as triptychs
 * (old | new+boxes | heatmap), ADDED images, and a REMOVED list. Because perf is
 * always present, the comment fires on every main commit even with no screenshot
 * change — "see it in hindsight on every commit."
 *
 * Safety / robustness:
 *  - Posts only on push to main (unless --force); a missing DISCORD_WEBHOOK_URL is
 *    a silent no-op, so it's inert on PRs / forks (which can't see the secret).
 *  - Attachments batched ≤10/message and downscaled to fit Discord's size caps;
 *    429 Retry-After honoured; first-run flood (hundreds of ADDED) collapsed.
 *  - --dry-run composes everything and prints it without POSTing (how it's tested).
 *
 * CLI (from tests/):
 *   tsx tools/screenshots/post-discord.ts [--dry-run] [--force] [--e2e pass|fail] [--subject S]
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { DIFF_OUT_DIR, splitKey } from './config';
import { loadPng, encodeWithinCap } from './image-ops';
import { buildPerfReport, fetchPreviousPerf } from './perf-report';
import type { Report } from './compare';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MSG_BYTES = 24 * 1024 * 1024;
const MAX_FILES_PER_MSG = 9; // ≤9 images per Discord message; the rest spill into more messages
const MAX_CONTENT = 1000; // split message text into multiple messages beyond this many chars
const MAX_TOTAL_FILES = 30; // ~4 messages of images; excess is summarized, not posted
const FLOOD_N = 12; // more ADDED than this ⇒ show a few exemplars, not all
const REMOVED_CAP = 40; // cap the REMOVED name list in the message body

type Attachment = { name: string; buffer: Buffer };
type Message = { content: string; files: Attachment[] };

function sanitize(name: string): string {
    return name.replace(/[^\w.-]+/g, '_');
}

function e2eBadge(status: string | undefined): string {
    if (status === 'pass') return '✅ e2e passed';
    if (status === 'fail') return '❌ e2e failed';
    return 'ℹ️ e2e status unknown';
}

function commitSubject(sha: string | undefined): string {
    if (!sha) return '';
    try {
        return execFileSync('git', ['log', '-1', '--pretty=%s', sha], { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

function readReport(root: string): Report | null {
    const p = path.join(root, DIFF_OUT_DIR, 'report.json');
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
    } catch {
        return null;
    }
}

/** Encode a PNG path to a within-cap attachment, or null if missing/unreadable. */
function attach(root: string, rel: string, name: string): Attachment | null {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) return null;
    try {
        return { name: sanitize(name), buffer: encodeWithinCap(loadPng(abs), MAX_FILE_BYTES) };
    } catch {
        return null;
    }
}

/** One status line for the 3D-renderer regression suite (tests/3d-regression),
 *  from the compare-dirs report.json of each level that ran. Empty when the
 *  suite didn't run (reports absent) so the message stays inert for builds
 *  without the 3D harness. Triptychs live in the run artifact, not Discord. */
function threeDStatusLine(): string[] {
    const levels: Array<{ tag: string; dir: string }> = [
        { tag: 'parity', dir: '3d-regression/output/diff/parity' },
        { tag: 'webgl-self', dir: '3d-regression/output/diff/webgl-self' },
    ];
    const parts: string[] = [];
    let drift = false;

    for (const { tag, dir } of levels) {
        const file = path.join(dir, 'report.json');
        if (!fs.existsSync(file)) continue;
        try {
            const r = JSON.parse(fs.readFileSync(file, 'utf8'));
            const changed = (r.changed?.length ?? 0) + (r.added?.length ?? 0) + (r.removed?.length ?? 0);
            const total = (r.unchangedCount ?? 0) + (r.changed?.length ?? 0);
            if (changed === 0) {
                parts.push(`${tag} ${total}/${total}`);
            } else {
                drift = true;
                const worst = r.changed?.[0];
                const worstNote = worst ? ` (worst \`${worst.name}\` ${(worst.changedRatio * 100).toFixed(1)}%)` : '';
                parts.push(`**${tag} ${changed} changed**${worstNote}`);
            }
        } catch {
            /* unreadable report — skip the level */
        }
    }

    if (!parts.length) return [];
    return [`${drift ? '⚠️' : '✅'} 3D renderer: ${parts.join(' · ')}${drift ? ' — triptychs in the run artifact' : ''}`];
}

/** Build the header text: SHA, subject, e2e, perf table, screenshot summary, removed list. */
function buildHeader(report: Report | null, perfBlock: string, meta: { sha?: string; subject: string; e2e?: string }): string {
    const shortSha = meta.sha ? meta.sha.slice(0, 7) : 'local';
    const lines = [`📸 **CI screenshot + perf report** · \`${shortSha}\``];
    if (meta.subject) lines.push(`> ${meta.subject}`);
    lines.push(e2eBadge(meta.e2e));
    if (perfBlock) lines.push('', perfBlock);

    // Per-engine breakdown suffix, e.g. " (2 chromium / 1 firefox)"; single-engine
    // sets show just the engine name so the origin is always visible.
    const byEngine = (entries: Array<{ name: string }>): string => {
        if (!entries.length) return '';
        const counts = new Map<string, number>();
        for (const e of entries) {
            const eng = splitKey(e.name).engine;
            counts.set(eng, (counts.get(eng) ?? 0) + 1);
        }
        if (counts.size < 2) return ` (${[...counts.keys()][0]})`;
        return ` (${[...counts.entries()].map(([e, n]) => `${n} ${e}`).join(' / ')})`;
    };

    lines.push('');
    if (!report) {
        // No report.json = the compare gate never ran (baseline fetch skipped or
        // incomplete). Saying "no drift" here would make a disabled pipeline
        // indistinguishable from a healthy one.
        lines.push('⚠️ screenshot gate SKIPPED — no baseline comparison ran (R2 fetch skipped/failed; check CI_SCREENSHOTS_S3_* secrets and the fetch step log)');
    } else if (!report.changed.length && !report.added.length && !report.removed.length) {
        lines.push('✅ no screenshot drift');
    } else if (report.driftLikely) {
        lines.push(`⚠️ **${report.changed.length} screenshots changed broadly** — looks like host env drift → re-promote (\`npm run screenshots:promote\`)`);
    } else {
        lines.push(
            `⚠️ **screenshot drift**: ${report.changed.length} changed${byEngine(report.changed)}, ` +
                `${report.added.length} added${byEngine(report.added)}, ` +
                `${report.removed.length} removed${byEngine(report.removed)}`
        );
    }
    if (report?.removed.length) {
        const shown = report.removed.slice(0, REMOVED_CAP).map((r) => `\`${r.name}\``).join(', ');
        const extra = report.removed.length > REMOVED_CAP ? ` (+${report.removed.length - REMOVED_CAP} more)` : '';
        lines.push('➖ REMOVED: ' + shown + extra);
    }
    lines.push(...threeDStatusLine());
    return lines.join('\n');
}

/** Collect the image attachments (changed triptychs + added images) with flood-collapse + total cap. */
export function buildAttachments(root: string, report: Report | null): { files: Attachment[]; notes: string[] } {
    const files: Attachment[] = [];
    const notes: string[] = [];
    if (!report) return { files, notes };

    for (const c of report.changed) {
        if (files.length >= MAX_TOTAL_FILES) break;
        const a = attach(root, c.triptych, `CHANGED_${c.name}`);
        if (a) files.push(a);
    }
    const addedToShow = report.added.length > FLOOD_N ? report.added.slice(0, 3) : report.added;
    if (report.added.length > FLOOD_N) {
        notes.push(`➕ ${report.added.length} added (showing ${addedToShow.length})`);
    }
    for (const ad of addedToShow) {
        if (files.length >= MAX_TOTAL_FILES) break;
        const a = attach(root, ad.image, `ADDED_${ad.name}`);
        if (a) files.push(a);
    }
    const removedToShow = report.removed.length > FLOOD_N ? report.removed.slice(0, 3) : report.removed;
    if (report.removed.length > FLOOD_N) {
        notes.push(`➖ ${report.removed.length} removed (showing ${removedToShow.length})`);
    }
    for (const rm of removedToShow) {
        if (files.length >= MAX_TOTAL_FILES) break;
        const a = attach(root, rm.image, `REMOVED_${rm.name}`);
        if (a) files.push(a);
    }
    const shown = files.length;
    const wanted = report.changed.length + addedToShow.length + removedToShow.length;
    if (wanted > shown) notes.push(`(${wanted - shown} more images omitted — see the CI artifact)`);
    return { files, notes };
}

/**
 * Assemble Discord messages: first the text content split into ≤MAX_CONTENT-char
 * messages (at line boundaries, never inside a ``` fence so the perf table stays
 * intact), then the image attachments in messages of ≤MAX_FILES_PER_MSG files.
 */
export function paginate(header: string, files: Attachment[]): Message[] {
    const messages: Message[] = [];

    // 1) Text content → one or more text-only messages.
    let cur = '';
    let inFence = false;
    for (const line of header.split('\n')) {
        const next = cur ? cur + '\n' + line : line;
        if (!inFence && cur && next.length > MAX_CONTENT) {
            messages.push({ content: cur, files: [] });
            cur = line;
        } else {
            cur = next;
        }
        if (line.trim().startsWith('```')) inFence = !inFence;
    }
    if (cur) messages.push({ content: cur, files: [] });

    // 2) Image attachments → messages of ≤MAX_FILES_PER_MSG files and ≤MAX_MSG_BYTES.
    let batch: Attachment[] = [];
    let bytes = 0;
    const flush = () => {
        if (batch.length) messages.push({ content: '', files: batch });
        batch = [];
        bytes = 0;
    };
    for (const f of files) {
        if (batch.length >= MAX_FILES_PER_MSG || bytes + f.buffer.length > MAX_MSG_BYTES) flush();
        batch.push(f);
        bytes += f.buffer.length;
    }
    flush();

    return messages.length ? messages : [{ content: header, files: [] }];
}

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export async function postMessage(webhook: string, msg: Message): Promise<void> {
    for (let attemptNo = 0; attemptNo < 6; attemptNo++) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ content: msg.content || '', allowed_mentions: { parse: [] } }));
        msg.files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.buffer)], { type: 'image/png' }), f.name));
        const res = await fetch(webhook, { method: 'POST', body: form });
        if (res.ok) return;
        if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after')) || 2;
            await sleep((retryAfter + 0.5) * 1000);
            continue;
        }
        throw new Error(`Discord POST failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    throw new Error('Discord POST failed after retries (429)');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--force') out.force = true;
        else if (a === '--e2e') out.e2e = argv[++i];
        else if (a === '--subject') out.subject = argv[++i];
        else if (a === '--repo') out.repo = argv[++i];
    }
    return out;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const root = process.cwd();
    const isMainPush = process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_EVENT_NAME === 'push';
    if (!args.force && !args.dryRun && !isMainPush) {
        console.log('[discord] not a push to main — skipping');
        return;
    }
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!webhook && !args.dryRun) {
        console.log('[discord] DISCORD_WEBHOOK_URL unset — skipping (inert on PRs/forks)');
        return;
    }

    const sha = process.env.GITHUB_SHA;
    const report = readReport(root);
    // Loud pipeline alert: if the run produced ZERO screenshots (every baseline shows as
    // "removed"), that's almost always a build/pipeline failure — not a real mass removal.
    // Post a distinct, image-less alert instead of dumping a giant REMOVED list.
    if (report && report.changed.length + report.added.length + report.unchangedCount === 0) {
        const shortSha = sha ? sha.slice(0, 7) : 'local';
        const runUrl =
            process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
                ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
                : '';
        const alert =
            `⚠️ **No screenshots produced this run** · \`${shortSha}\` — compare saw 0 rendered ` +
            `vs ${report.removed.length} baselines. Likely a build/pipeline failure, not a mass removal.` +
            (runUrl ? `\n${runUrl}` : '');
        if (args.dryRun) {
            console.log('--- message 1/1 (0 files) ---\n' + alert);
        } else {
            await postMessage(webhook!, { content: alert, files: [] });
            console.log('[discord] posted pipeline alert (0 screenshots rendered)');
        }
        return;
    }
    const prevDir = fetchPreviousPerf((args.repo as string) || process.env.GITHUB_REPOSITORY, sha);
    const { block: perfBlock } = buildPerfReport({ prevDir });

    let header = buildHeader(report, perfBlock, {
        sha,
        subject: (args.subject as string) ?? commitSubject(sha),
        e2e: args.e2e as string,
    });
    const { files, notes } = buildAttachments(root, report);
    if (notes.length) header += '\n' + notes.join('\n');

    const messages = paginate(header, files);

    if (args.dryRun) {
        for (const [i, m] of messages.entries()) {
            console.log(`--- message ${i + 1}/${messages.length} (${m.files.length} files, ${m.files.reduce((s, f) => s + f.buffer.length, 0)} bytes) ---`);
            if (m.content) console.log(m.content);
            for (const f of m.files) console.log(`  [attach] ${f.name} (${f.buffer.length} bytes)`);
        }
        return;
    }

    for (const m of messages) await postMessage(webhook!, m);
    console.log(`[discord] posted ${messages.length} message(s)`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[discord] ${e.message}`);
        process.exitCode = 1;
    });
}
