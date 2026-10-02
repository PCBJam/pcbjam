import { execFile } from 'child_process';
import * as fs from 'fs';
import type { TestInfo } from '@playwright/test';

/**
 * Freeze diagnostics for a test that is about to time out.
 *
 * Seen on CI (2026-09-16, 2026-10-02): a Firefox page boots, draws its frame
 * and then stops answering — Playwright's own post-step snapshot never returns,
 * so the test just sits until its timeout and the trace shows nothing but a
 * frozen screencast. Nothing can be asked of such a page, so this looks at it
 * from the OUTSIDE instead: shortly before the timeout it records, for every
 * browser process this worker launched, what each thread is doing (state, CPU
 * over a one-second sample, current syscall) and — where gdb is installed — the
 * native stacks. That separates "main thread spinning in wasm/JS" from "main
 * thread blocked in a futex / sync IPC / GL call", which the trace cannot.
 *
 * Linux only (/proc); a no-op elsewhere. The dump is kept only if the test
 * then fails.
 */

const LEAD_MS = 30_000;
const POLL_MS = 2_000;
const SAMPLE_MS = 1_000;
const GDB_TIMEOUT_MS = 12_000;
const GDB_MAX_PROCS = 3;

interface ThreadStat {
  tid: number;
  name: string;
  state: string;
  ticks: number;
}

interface ProcStat {
  pid: number;
  ppid: number;
  cmd: string;
  threads: ThreadStat[];
}

// x86_64 numbers for the syscalls a blocked browser thread is usually parked in.
const SYSCALL_NAMES: Record<number, string> = {
  0: 'read', 7: 'poll', 23: 'select', 35: 'nanosleep', 45: 'recvfrom', 47: 'recvmsg',
  61: 'wait4', 202: 'futex', 230: 'clock_nanosleep', 232: 'epoll_wait', 270: 'pselect6',
  271: 'ppoll', 281: 'epoll_pwait',
};

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** `pid (comm) state ppid … utime stime …` — comm may itself contain spaces/parens. */
function parseStat(raw: string): { state: string; ppid: number; ticks: number } | null {
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const f = raw.slice(close + 2).split(' ');
  return { state: f[0] ?? '?', ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) };
}

function listPids(): number[] {
  try {
    return fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e)).map(Number);
  } catch {
    return [];
  }
}

function descendantsOf(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const pid of listPids()) {
    const stat = parseStat(readFile(`/proc/${pid}/stat`) ?? '');
    if (!stat) continue;
    children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

function snapshot(pids: number[]): ProcStat[] {
  const procs: ProcStat[] = [];
  for (const pid of pids) {
    const stat = parseStat(readFile(`/proc/${pid}/stat`) ?? '');
    if (!stat) continue;
    const cmd = (readFile(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean).join(' ');
    const threads: ThreadStat[] = [];
    let tids: string[] = [];
    try {
      tids = fs.readdirSync(`/proc/${pid}/task`);
    } catch {
      /* exited between the listing and here */
    }
    for (const tid of tids) {
      const t = parseStat(readFile(`/proc/${pid}/task/${tid}/stat`) ?? '');
      if (!t) continue;
      threads.push({
        tid: Number(tid),
        name: (readFile(`/proc/${pid}/task/${tid}/comm`) ?? '').trim(),
        state: t.state,
        ticks: t.ticks,
      });
    }
    procs.push({ pid, ppid: stat.ppid, cmd, threads });
  }
  return procs;
}

/** `nr args… sp pc`, `running`, or `-1 sp pc` (blocked outside a syscall). */
function syscallOf(pid: number, tid: number): string {
  const raw = (readFile(`/proc/${pid}/task/${tid}/syscall`) ?? '').trim();
  if (!raw) return 'syscall unreadable';
  if (raw === 'running') return 'running (not in a syscall)';
  const nr = Number(raw.split(' ')[0]);
  const name = process.arch === 'x64' ? SYSCALL_NAMES[nr] : undefined;
  return `syscall ${nr}${name ? ` (${name})` : ''}`;
}

/** Firefox content processes and Chromium renderers — where a page's main thread lives. */
function isPageProcess(cmd: string): boolean {
  return /-contentproc\b.*\btab\b/.test(cmd) || cmd.includes('--type=renderer');
}

function shortCmd(cmd: string): string {
  const exe = cmd.split(' ')[0]?.split('/').pop() ?? '?';
  const kind = /--type=(\S+)/.exec(cmd)?.[1] ?? (cmd.includes('-contentproc') ? `contentproc ${cmd.trim().split(' ').pop()}` : 'main');
  return `${exe} [${kind}]`;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? null : stdout);
    });
  });
}

/** Attaching to a sibling's child needs root under the default ptrace scope; CI runners have passwordless sudo. */
async function nativeStacks(pid: number): Promise<string> {
  const gdbArgs = ['-p', String(pid), '-batch', '-nx', '-ex', 'set pagination off', '-ex', 'thread apply all bt 14'];
  const out = (await run('sudo', ['-n', 'gdb', ...gdbArgs], GDB_TIMEOUT_MS)) ?? (await run('gdb', gdbArgs, GDB_TIMEOUT_MS));
  return out ?? '(gdb unavailable, not permitted, or timed out)';
}

async function collect(): Promise<string> {
  const pids = descendantsOf(process.pid);
  const before = snapshot(pids);
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  const after = snapshot(pids);

  const lines: string[] = [`worker pid ${process.pid}, ${after.length} descendant processes, CPU over a ${SAMPLE_MS}ms sample`, ''];
  const cpuOf = new Map<number, number>();
  for (const proc of after) {
    const prev = new Map((before.find((p) => p.pid === proc.pid)?.threads ?? []).map((t) => [t.tid, t.ticks]));
    const delta = (t: ThreadStat) => t.ticks - (prev.get(t.tid) ?? t.ticks);
    const total = proc.threads.reduce((sum, t) => sum + delta(t), 0);
    cpuOf.set(proc.pid, total);
    const states = new Map<string, number>();
    for (const t of proc.threads) states.set(t.state, (states.get(t.state) ?? 0) + 1);
    lines.push(
      `pid ${proc.pid} (ppid ${proc.ppid}) ${shortCmd(proc.cmd)}: ${total}% cpu, ${proc.threads.length} threads ` +
        `{${[...states].map(([s, n]) => `${s}:${n}`).join(' ')}}`,
    );
    // The main thread always; any other thread only if it is actually burning CPU.
    for (const t of proc.threads) {
      if (t.tid !== proc.pid && delta(t) < 5) continue;
      lines.push(
        `    ${t.tid === proc.pid ? 'MAIN' : 'tid '} ${t.tid} "${t.name}" state ${t.state}, ${delta(t)}% cpu, ` +
          `${t.ticks} ticks total, ${syscallOf(proc.pid, t.tid)}`,
      );
    }
  }

  const targets = after
    .filter((p) => isPageProcess(p.cmd))
    .sort((a, b) => (cpuOf.get(b.pid) ?? 0) - (cpuOf.get(a.pid) ?? 0) || b.threads.length - a.threads.length)
    .slice(0, GDB_MAX_PROCS);
  const stacks = await Promise.all(targets.map((p) => nativeStacks(p.pid)));
  targets.forEach((p, i) => lines.push('', `── native stacks: pid ${p.pid} ${shortCmd(p.cmd)} ──`, stacks[i]!));
  return lines.join('\n');
}

/**
 * Arm the watchdog for one test; call the returned function once the test body
 * is done (fixture teardown). It attaches the dump when the test did not pass.
 */
export function armHangDiagnostics(testInfo: TestInfo): () => Promise<void> {
  if (process.platform !== 'linux') return async () => {};

  const startedAt = Date.now();
  let pending: Promise<string> | null = null;
  // Polled rather than a single timer: test.setTimeout()/test.slow() move the
  // deadline after the fixture has been set up.
  const timer = setInterval(() => {
    if (pending || testInfo.timeout <= 0) return;
    const remaining = testInfo.timeout - (Date.now() - startedAt);
    if (remaining > Math.min(LEAD_MS, testInfo.timeout / 3)) return;
    pending = collect().catch((err: unknown) => `hang diagnostics failed: ${String(err)}`);
  }, POLL_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    if (!pending || testInfo.status === testInfo.expectedStatus) return;
    // A file next to the trace (the reporters only print the first lines of a body).
    const file = testInfo.outputPath('hang-diagnostics.txt');
    fs.writeFileSync(file, await pending);
    await testInfo.attach('hang-diagnostics', { path: file, contentType: 'text/plain' });
  };
}
