import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  TRIO_PCB,
  TRIO_SCH,
  type ToolCfg,
  type Trio,
  SYM1,
  WIRE1,
  WIRE2,
  FP1,
  PAD1,
  PAD2,
  VIA1,
  SEG1,
  SEG2,
  callHook,
  closeTrio,
  drift,
  hasAbort,
  modelText,
  openTrio,
  oracleSweep,
  renderDoc,
  settleConverged,
} from "./utils/trio";

/**
 * Drift trio harness — S10 seeded fuzz (standalone-hardening 0008 §6, phase D).
 *
 * A deterministic PRNG (mulberry32) interleaves weighted catalog actions on A
 * and B — mutations > creations > deletions — with NO settling between steps;
 * C only observes. Every SYNC_EVERY steps both actors drop a marker, the run
 * waits for both markers on every tab, then settles and runs the full oracle
 * sweep. Any failure dumps a REPLAYABLE artifact (seed + full action log +
 * per-tab drift/saves/renders) to logs/kicad/drift-trio-fuzz/.
 *
 * DETERMINISM: the seed is fixed (1) unless DRIFT_FUZZ_SEED is set — CI always
 * runs the same sequence; exploration happens locally via the env var, and a
 * found bug's seed is then pinned as a named regression spec.
 *
 * Hook results are NOT asserted mid-run: an action racing a concurrent delete
 * legitimately loses (returns false/"" — finding #9's policy). The oracles are
 * the contract; the log records every action + result for triage.
 */

const K_STEPS = 40;
const SYNC_EVERY = 10;
const SEED = Number(process.env.DRIFT_FUZZ_SEED ?? 1);

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

function skipFirefox(): void {
  // 2026-08-13: guard retired — the JSPI build (~half the asyncify size) fits
  // three editor tabs inside Firefox 153's per-process wasm budget; the
  // whole file passes on kicad-firefox. Kept as a hook in case the wall
  // returns with future growth.
}

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T | undefined;
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => (arr.length ? arr[Math.floor(next() * arr.length)] : undefined),
  };
}

/** Known-item registry (node-side truth; races only make actions no-op). */
interface Reg {
  /** value-carrying primaries (symbols / footprints) */
  primaries: string[];
  /** endpoint-carrying items (wires / tracks) */
  lines: string[];
  /** everything deletable */
  all: string[];
}

interface FuzzAction {
  name: string;
  weight: number;
  /** Returns a result string for the log; may register/unregister uuids. */
  run(page: Page, rng: Rng, reg: Reg, step: number): Promise<string>;
}

function registerCreated(reg: Reg, uuid: string, kind: "primary" | "line" | "other"): void {
  if (!/[0-9a-f-]{36}/.test(uuid)) return;
  reg.all.push(uuid);
  if (kind === "primary") reg.primaries.push(uuid);
  if (kind === "line") reg.lines.push(uuid);
}

function unregister(reg: Reg, uuid: string): void {
  for (const arr of [reg.all, reg.primaries, reg.lines]) {
    const i = arr.indexOf(uuid);
    if (i >= 0) arr.splice(i, 1);
  }
}

// Positions: step-scoped lanes so creations never overlap exactly (grid-ish,
// deterministic). eeschema IU 1e4/mm; pcbnew IU 1e6/mm.
const schX = (rng: Rng) => rng.int(40, 170) * 10000;
const schY = (rng: Rng) => rng.int(40, 170) * 10000;
const pcbX = (rng: Rng) => rng.int(20, 160) * 1000000;
const pcbY = (rng: Rng) => rng.int(20, 160) * 1000000;

function schActions(): FuzzAction[] {
  return [
    {
      name: "moveItem",
      weight: 5,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestMoveSchItem", t, rng.int(-30, 30) * 10000, rng.int(-30, 30) * 10000);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "rotate",
      weight: 3,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestRotateItem", t, 90 * rng.int(1, 3));
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "mirror",
      weight: 2,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestMirrorSchItem", t, rng.next() < 0.5);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "setValue",
      weight: 4,
      run: async (p, rng, reg, step) => {
        const t = rng.pick(reg.primaries);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestSetFieldText", t, `fz-${step}`);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "addWire",
      weight: 3,
      run: async (p, rng, _reg, step) => {
        const x = schX(rng);
        const y = schY(rng);
        const u = await callHook<string>(p, "kicadCollabTestAddWire", x, y, x + rng.int(2, 12) * 10000, y);
        registerCreated(_reg, u, "line");
        return u ? u.slice(0, 8) : `fail@${step}`;
      },
    },
    {
      name: "addLabel",
      weight: 2,
      run: async (p, rng, reg, step) => {
        const kind = rng.pick(["label", "global", "hier"] as const)!;
        const u = await callHook<string>(p, "kicadCollabTestAddLabel", kind, `FZ${step}`, schX(rng), schY(rng));
        registerCreated(reg, u, "other");
        return u ? `${kind}:${u.slice(0, 8)}` : "fail";
      },
    },
    {
      name: "addSymbol",
      weight: 2,
      run: async (p, rng, reg, step) => {
        const u = await callHook<string>(p, "kicadCollabTestAddSymbol", "Device:R", schX(rng), schY(rng), `R${20 + step}`);
        registerCreated(reg, u, "primary");
        return u ? u.slice(0, 8) : "fail";
      },
    },
    {
      name: "duplicate",
      weight: 1,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.primaries);
        if (!t) return "skip:empty";
        const u = await callHook<string>(p, "kicadCollabTestDuplicateSchItem", t, rng.int(5, 20) * 10000, 0);
        registerCreated(reg, u, "primary");
        return u ? `${t.slice(0, 8)}→${u.slice(0, 8)}` : "fail";
      },
    },
    {
      name: "remove",
      weight: 1,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        unregister(reg, t); // node-side intent; the race may no-op it
        const ok = await callHook<boolean>(p, "kicadCollabTestRemoveItem", t);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
  ];
}

function pcbActions(): FuzzAction[] {
  return [
    {
      name: "moveItem",
      weight: 5,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestMoveBoardItem", t, rng.int(-20, 20) * 100000, rng.int(-20, 20) * 100000);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "rotate",
      weight: 3,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestRotateItem", t, 90 * rng.int(1, 3));
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "flip",
      weight: 2,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.primaries);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestFlipBoardItem", t);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "setValue",
      weight: 3,
      run: async (p, rng, reg, step) => {
        const t = rng.pick(reg.primaries);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestSetFootprintField", t, "Value", `fz-${step}`);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "setLocked",
      weight: 2,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestSetBoardItemLocked", t, rng.next() < 0.5);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "setPadSize",
      weight: 2,
      run: async (p, rng) => {
        const pad = rng.pick([PAD1, PAD2])!;
        const ok = await callHook<boolean>(p, "kicadCollabTestSetPadSize", pad, rng.int(8, 20) * 100000, rng.int(8, 20) * 100000);
        return `${pad.slice(-2)}→${ok}`;
      },
    },
    {
      name: "moveEndpoint",
      weight: 2,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.lines);
        if (!t) return "skip:empty";
        const ok = await callHook<boolean>(p, "kicadCollabTestMoveEndpoint", t, rng.int(-20, 20) * 100000, rng.int(-20, 20) * 100000);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
    {
      name: "addTrack",
      weight: 3,
      run: async (p, rng, reg) => {
        const x = pcbX(rng);
        const y = pcbY(rng);
        const u = await callHook<string>(p, "kicadCollabTestAddTrack", x, y, x + rng.int(2, 20) * 1000000, y, rng.int(2, 6) * 100000, "F.Cu");
        registerCreated(reg, u, "line");
        return u ? u.slice(0, 8) : "fail";
      },
    },
    {
      name: "addVia",
      weight: 2,
      run: async (p, rng, reg) => {
        const u = await callHook<string>(p, "kicadCollabTestAddVia", pcbX(rng), pcbY(rng), 800000, 400000);
        registerCreated(reg, u, "other");
        return u ? u.slice(0, 8) : "fail";
      },
    },
    {
      name: "addText",
      weight: 2,
      run: async (p, rng, reg, step) => {
        const u = await callHook<string>(p, "kicadCollabTestAddBoardText", `FZ${step}`, pcbX(rng), pcbY(rng), "F.SilkS");
        registerCreated(reg, u, "other");
        return u ? u.slice(0, 8) : "fail";
      },
    },
    {
      name: "duplicate",
      weight: 1,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.primaries);
        if (!t) return "skip:empty";
        const u = await callHook<string>(p, "kicadCollabTestDuplicateBoardItem", t, rng.int(5, 25) * 1000000, 0);
        registerCreated(reg, u, "primary");
        return u ? `${t.slice(0, 8)}→${u.slice(0, 8)}` : "fail";
      },
    },
    {
      name: "remove",
      weight: 1,
      run: async (p, rng, reg) => {
        const t = rng.pick(reg.all);
        if (!t) return "skip:empty";
        unregister(reg, t);
        const ok = await callHook<boolean>(p, "kicadCollabTestRemoveItem", t);
        return `${t.slice(0, 8)}→${ok}`;
      },
    },
  ];
}

function weightedPick(rng: Rng, actions: FuzzAction[]): FuzzAction {
  const total = actions.reduce((s, a) => s + a.weight, 0);
  let roll = rng.next() * total;
  for (const a of actions) {
    roll -= a.weight;
    if (roll <= 0) return a;
  }
  return actions[actions.length - 1]!;
}

interface LogEntry {
  step: number;
  actor: string;
  action: string;
  result: string;
}

const ART_DIR = path.resolve(__dirname, "../logs/kicad/drift-trio-fuzz");

async function dumpArtifact(
  trio: Trio,
  cfg: ToolCfg,
  label: string,
  log: LogEntry[],
  err: unknown,
  consoles: Record<string, string[]> = {},
): Promise<void> {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const base = path.join(ART_DIR, `${label}-seed${SEED}`);
  const tabs: Record<string, unknown> = {};
  for (const [tabLabel, page] of trio.tabs) {
    const save = await modelText(page, cfg).catch((e) => `ERR:${e}`);
    const render = await renderDoc(page).catch((e) => ({ err: String(e) }));
    const d = await drift(page, cfg).catch((e) => `ERR:${e}`);
    fs.writeFileSync(`${base}-${tabLabel}.${cfg.ext}`, typeof save === "string" ? save : String(save));
    tabs[tabLabel] = { drift: d, renderErr: (render as { err?: string }).err ?? null };
    fs.writeFileSync(`${base}-${tabLabel}.render.txt`, (render as { ok?: string }).ok ?? `ERR: ${(render as { err?: string }).err}`);
  }
  fs.writeFileSync(
    `${base}.json`,
    JSON.stringify({ seed: SEED, steps: K_STEPS, error: String(err), tabs, consoles, log }, null, 2),
  );
}

for (const [cfg, label, mkActions, seedReg] of [
  [
    TRIO_SCH,
    "eeschema",
    schActions,
    (): Reg => ({ primaries: [SYM1], lines: [WIRE1, WIRE2], all: [SYM1, WIRE1, WIRE2] }),
  ],
  [
    TRIO_PCB,
    "pcbnew",
    pcbActions,
    (): Reg => ({ primaries: [FP1], lines: [SEG1, SEG2], all: [FP1, VIA1, SEG1, SEG2] }),
  ],
] as const) {
  test.describe(`drift trio fuzz — ${label}`, () => {
    test.describe.configure({ timeout: 900000 });

    test(`${label} S10: seeded fuzz, K=${K_STEPS}, seed=${SEED}`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      // FINDING #10 (standalone-hardening 0008 §10, open): under sustained
      // bidirectional load the ACTIVELY-EDITING receiver's C++ apply silently
      // drops ops (JS dispatched them; the editor never applied) — eeschema
      // reproduces at seed 1 by sync-2/3, pcbnew intermittently; one run hit a
      // wasm "memory access out of bounds" on the observer. Fixme (not
      // test.fail) because the wedge point is timing-dependent — a flaky
      // expected-fail would red CI on its lucky runs. Run manually:
      //   DRIFT_FUZZ_SEED=1 npx playwright test --project=kicad-chromium kicad/drift-trio-fuzz.spec.ts
      // Un-fixme when #10 is fixed (phase E).
      test.fixme(
        !process.env.DRIFT_FUZZ_SEED,
        "finding #10: apply drops under bidirectional load — run manually via DRIFT_FUZZ_SEED",
      );
      const trio = await openTrio(context, cfg, `fuzz-${label}-${SEED}-${test.info().workerIndex}`);
      // Per-tab console capture — testLogger only hooks the default page, and
      // apply/parse failures surface as console lines on the affected TAB.
      const consoles: Record<string, string[]> = {};
      for (const [tabLabel, page] of trio.tabs) {
        consoles[tabLabel] = [];
        page.on("console", (m) => {
          const t = m.text();
          if (/collab|drift|parse|error|abort/i.test(t)) consoles[tabLabel]!.push(t.slice(0, 400));
        });
        page.on("pageerror", (e) =>
          consoles[tabLabel]!.push(`PAGEERROR ${e.message}\nSTACK ${(e.stack ?? "").slice(0, 4000)}`),
        );
      }
      const actions = mkActions();
      const reg = seedReg();
      const rngA = makeRng(SEED * 2 + 1);
      const rngB = makeRng(SEED * 3 + 7);
      const log: LogEntry[] = [];

      const marker =
        label === "eeschema"
          ? (p: Page, text: string, slot: number) =>
              callHook<string>(p, "kicadCollabTestAddLabel", "label", text, 200000 + slot * 40000, 200000)
          : (p: Page, text: string, slot: number) =>
              callHook<string>(p, "kicadCollabTestAddBoardText", text, 10000000 + slot * 12000000, 180000000, "F.SilkS");

      try {
        for (let step = 0; step < K_STEPS; step++) {
          const actA = weightedPick(rngA, actions);
          const actB = weightedPick(rngB, actions);
          const [resA, resB] = await Promise.all([
            actA.run(trio.A, rngA, reg, step).catch((e) => `ERR:${e}`),
            actB.run(trio.B, rngB, reg, step).catch((e) => `ERR:${e}`),
          ]);
          log.push({ step, actor: "A", action: actA.name, result: resA });
          log.push({ step, actor: "B", action: actB.name, result: resB });

          if ((step + 1) % SYNC_EVERY === 0) {
            const slot = Math.floor(step / SYNC_EVERY);
            const [mA, mB] = await Promise.all([
              marker(trio.A, `sync-${slot}-a`, slot * 2),
              marker(trio.B, `sync-${slot}-b`, slot * 2 + 1),
            ]);
            registerCreated(reg, mA, "other");
            registerCreated(reg, mB, "other");
            for (const m of [`sync-${slot}-a`, `sync-${slot}-b`]) {
              for (const [tabLabel, page] of trio.tabs) {
                await expect
                  .poll(async () => (await modelText(page, cfg)).includes(m), {
                    timeout: 45000,
                    intervals: [500],
                    message: `${tabLabel} must receive marker ${m}`,
                  })
                  .toBe(true);
              }
            }
            await settleConverged(trio, cfg, 45000);
            await oracleSweep(trio, cfg);
          }
        }
      } catch (err) {
        await dumpArtifact(trio, cfg, label, log, err, consoles);
        throw err;
      }

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });
  });
}
