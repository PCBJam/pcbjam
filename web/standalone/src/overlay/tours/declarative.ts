/**
 * Declarative tours (overlay-system 0003 phase 2): a tour written as DATA —
 * steps with targets, texts and conditions — compiled into the state-driven
 * runner (`startTour`). This is the form plugins hand the host (their code
 * has no background life, so the host must run the tour), and the form the
 * built-in tours use too.
 *
 * Step choice: the current step is the first whose `when` holds (default
 * true) and whose `until` is not met.
 *   - state conditions (`dialogOpen`, `symbols`, `footprint`, `value`,
 *     `net`, `noConnect`, and on the board `boardFootprints`, `boardOutline`,
 *     `unrouted`, `tracks`, `activeLayer`) are re-evaluated live — undoing the work re-opens the step;
 *   - event conditions (`next`, `action`, `dialogOpened`, `dialogClosed`,
 *     `checkFinished`) only fire on the event, so a step whose `until` contains one LATCHES
 *     done once met while it is the current step. With a memory store the
 *     latches survive a reload or an editor switch (memory.ts).
 * The last step must finish on `{ next: true }`; its Next ends the tour.
 *
 * Back (tutorial round 2): with a checkpoint store, every step remembers the
 * document as it was when it first showed; Back restores the newest earlier
 * step's document and forgets the latches from that step on, so the
 * state-driven choice lands on it again (checkpoints.ts).
 */
import { z } from "zod";
import { ATTRIBUTION_MAX, TEXT_MAX, TITLE_MAX, type OverlayButton } from "../types";
import { parseTarget } from "../targets/parse";
import { parseBoardStatus, type BoardStatus } from "../board-status";
import type { Checkpoint, CheckpointStore } from "./checkpoints";
import type { TourMemoryStore } from "./memory";
import type { Tour, TourEvent, TourStepContent } from "./runner";

// ── Schema ──────────────────────────────────────────────────────────────────

const name64 = z.string().min(1).max(64);
const actionName = z.string().regex(/^[A-Za-z0-9_.]{1,128}$/);
const dialogClass = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const libId = z.string().min(1).max(128);

export const pinSelSchema = z
  .object({
    libId: libId.optional(),
    ref: z.string().min(1).max(32).optional(),
    power: z.string().min(1).max(64).optional(),
    pin: z.string().min(1).max(16).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((s) => [s.libId, s.ref, s.power].filter((v) => v !== undefined).length === 1, {
    message: "exactly one of libId, ref, power",
  })
  .refine((s) => (s.power === undefined ? s.pin !== undefined : s.pin === undefined && !s.all), {
    message: "pin selectors need `pin`; power selectors take neither `pin` nor `all`",
  });
export type PinSel = z.infer<typeof pinSelSchema>;

export type Cond =
  | { next: true }
  | { action: string }
  | { dialogOpened: string }
  | { dialogClosed: string }
  | { dialogOpen: string }
  /** ERC / DRC ran in its dialog — optionally with at most this many errors / warnings (event). */
  | { checkFinished: { kind: "erc" | "drc"; maxErrors?: number; maxWarnings?: number } }
  | { symbols: { libId: string; min: number; new?: boolean } }
  | { footprint: { libId?: string; ref?: string; set: true | string } }
  | { value: { libId?: string; ref?: string; is: string } }
  /** Every placed matching symbol is turned to one of these angles. */
  | { orientation: { libId?: string; ref?: string; angle: number[] } }
  | { net: PinSel[] }
  | { noConnect: PinSel }
  // PCB editor (overlay-system 0004 H4)
  | { boardFootprints: { ref?: string; fpid?: string; min?: number; inside?: true; angle?: number[] } }
  | { boardOutline: { closed: true } }
  | { unrouted: { max: number } }
  | { tracks: { min: number } }
  | { activeLayer: string }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

export const condSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ next: z.literal(true) }).strict(),
    z.object({ action: actionName }).strict(),
    z.object({ dialogOpened: dialogClass }).strict(),
    z.object({ dialogClosed: dialogClass }).strict(),
    z.object({ dialogOpen: dialogClass }).strict(),
    z
      .object({
        checkFinished: z
          .object({
            kind: z.enum(["erc", "drc"]),
            maxErrors: z.number().int().min(0).max(100000).optional(),
            maxWarnings: z.number().int().min(0).max(100000).optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        symbols: z.object({ libId, min: z.number().int().min(1).max(100), new: z.boolean().optional() }).strict(),
      })
      .strict(),
    z
      .object({
        footprint: z
          .object({ libId: libId.optional(), ref: z.string().min(1).max(32).optional(), set: z.union([z.literal(true), z.string().min(1).max(256)]) })
          .strict()
          .refine((f) => (f.libId === undefined) !== (f.ref === undefined), { message: "exactly one of libId, ref" }),
      })
      .strict(),
    z
      .object({
        value: z
          .object({ libId: libId.optional(), ref: z.string().min(1).max(32).optional(), is: z.string().min(1).max(64) })
          .strict()
          .refine((v) => (v.libId === undefined) !== (v.ref === undefined), { message: "exactly one of libId, ref" }),
      })
      .strict(),
    z
      .object({
        orientation: z
          .object({
            libId: libId.optional(),
            ref: z.string().min(1).max(32).optional(),
            angle: z.array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])).min(1).max(4),
          })
          .strict()
          .refine((o) => (o.libId === undefined) !== (o.ref === undefined), { message: "exactly one of libId, ref" }),
      })
      .strict(),
    z.object({ net: z.array(pinSelSchema).min(2).max(16) }).strict(),
    z.object({ noConnect: pinSelSchema }).strict(),
    z
      .object({
        boardFootprints: z
          .object({
            ref: z.string().min(1).max(32).optional(),
            fpid: libId.optional(),
            min: z.number().int().min(1).max(500).optional(),
            inside: z.literal(true).optional(),
            angle: z.array(z.number().min(0).max(360)).min(1).max(8).optional(),
          })
          .strict()
          .refine((f) => f.ref === undefined || f.fpid === undefined, { message: "at most one of ref, fpid" }),
      })
      .strict(),
    z.object({ boardOutline: z.object({ closed: z.literal(true) }).strict() }).strict(),
    z.object({ unrouted: z.object({ max: z.number().int().min(0).max(100000) }).strict() }).strict(),
    z.object({ tracks: z.object({ min: z.number().int().min(1).max(100000) }).strict() }).strict(),
    z.object({ activeLayer: z.string().regex(/^[A-Za-z0-9_.]{1,32}$/) }).strict(),
    z.object({ all: z.array(condSchema).min(1).max(16) }).strict(),
    z.object({ any: z.array(condSchema).min(1).max(16) }).strict(),
    z.object({ not: condSchema }).strict(),
  ]),
);

/** `new:<libId>` — the most recently placed NEW symbol of that library id. */
const NEW_TARGET = /^new:(.+)$/;

const target = z
  .string()
  .max(512)
  .refine((t) => NEW_TARGET.test(t) || parseTarget(t) !== null, { message: "unknown target" });

export const tourStepSchema = z
  .object({
    id: name64,
    target: target.optional(),
    title: z.string().max(TITLE_MAX).optional(),
    text: z.string().min(1).max(TEXT_MAX),
    lostText: z.string().max(TEXT_MAX).optional(),
    placement: z.enum(["auto", "top", "bottom", "left", "right"]).optional(),
    spotlight: z.boolean().optional(),
    pulse: z.boolean().optional(),
    /** A short host-drawn celebration when the step shows (e.g. ERC came back clean). */
    celebrate: z.literal("rainbow").optional(),
    when: condSchema.optional(),
    until: condSchema,
  })
  .strict();

/** Steps per tour. A beginner chapter with its sub-steps runs to ~40. */
export const TOUR_STEPS_MAX = 60;

export const tourDefSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: z.string().min(1).max(ATTRIBUTION_MAX).optional(),
    editor: z.enum(["eeschema", "pcbnew"]),
    steps: z.array(tourStepSchema).min(1).max(TOUR_STEPS_MAX),
  })
  .strict()
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    def.steps.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate step id ${s.id}`, path: ["steps", i, "id"] });
      ids.add(s.id);
    });
    // zod still runs this after `min(1)` failed: never assume a last step.
    const last = def.steps[def.steps.length - 1];
    if (last && !("next" in last.until)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the last step must finish on { next: true }", path: ["steps", def.steps.length - 1, "until"] });
    }
  });

export type TourStepDef = z.infer<typeof tourStepSchema>;
export type TourDef = z.infer<typeof tourDefSchema>;

export const TOUR_DEF_MAX_BYTES = 64 * 1024;

/** Validate an untrusted definition (plugins); throws with the first issue. */
export function parseTourDef(input: unknown): TourDef {
  const size = JSON.stringify(input ?? null).length;
  if (size > TOUR_DEF_MAX_BYTES) throw new Error(`tour definition too large (${size} > ${TOUR_DEF_MAX_BYTES} bytes)`);
  const r = tourDefSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new Error(`invalid tour: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return r.data;
}

// ── Engine data ─────────────────────────────────────────────────────────────

export interface SheetSymbol {
  uuid: string;
  libId: string;
  ref: string;
  value: string;
  footprint: string;
  /** 0 / 90 / 180 / 270 (undefined from engines before overlay-system 0005). */
  angle?: number;
  /** "x", "y" or "" when not mirrored. */
  mirror?: string;
  /** The symbol's anchor in world IU. */
  x?: number;
  y?: number;
}
export interface SheetPin {
  uuid: string;
  ref: string;
  libId: string;
  pin: string;
  /** Pin name as shown ("" for KiCad's unnamed "~"). */
  name: string;
  noConnect: boolean;
}
export interface SheetNet {
  net: string;
  pins: SheetPin[];
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** `Module.kicadSheetSymbols()` payload; null when not an array. */
export function parseSheetSymbols(raw: unknown): SheetSymbol[] | null {
  if (typeof raw !== "string") return null;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const out: SheetSymbol[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const uuid = str(r?.uuid);
    const lib = str(r?.libId);
    if (!uuid || !lib) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    out.push({
      uuid: uuid.toLowerCase(),
      libId: lib,
      ref: str(r.ref) ?? "",
      value: str(r.value) ?? "",
      footprint: str(r.footprint) ?? "",
      angle: num(r.angle),
      mirror: str(r.mirror) ?? undefined,
      x: num(r.x),
      y: num(r.y),
    });
  }
  return out;
}

/** `Module.kicadSheetNets()` payload; null when not an array. */
export function parseSheetNets(raw: unknown): SheetNet[] | null {
  if (typeof raw !== "string") return null;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const out: SheetNet[] = [];
  for (const r of rows as { net?: unknown; pins?: unknown }[]) {
    const net = str(r?.net);
    if (net === null || !Array.isArray(r.pins)) continue;
    const pins: SheetPin[] = [];
    for (const p of r.pins as Record<string, unknown>[]) {
      const uuid = str(p?.uuid);
      const pin = str(p?.pin);
      if (!uuid || pin === null) continue;
      pins.push({ uuid: uuid.toLowerCase(), ref: str(p.ref) ?? "", libId: str(p.libId) ?? "", pin, name: str(p.name) ?? "", noConnect: p.noConnect === true });
    }
    out.push({ net, pins });
  }
  return out;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export interface DeclState {
  symbols: SheetSymbol[];
  /** Null until read (only read when the tour references nets). */
  nets: SheetNet[] | null;
  /** UUIDs of symbols placed since the tour started, in sheet order. */
  added: Set<string>;
  /** Null until read (only read when the tour references the board) or off the PCB editor. */
  board?: BoardStatus | null;
  dialogOpen(cls: string): boolean;
}

const placed = (s: SheetSymbol) => !s.ref.startsWith("#");

function matchesSymbol(sel: PinSel, s: { libId: string; ref: string }): boolean {
  if (sel.libId !== undefined) return s.libId === sel.libId;
  if (sel.ref !== undefined) return s.ref === sel.ref;
  return false;
}

function netSatisfies(net: SheetNet, sel: PinSel, state: DeclState): boolean {
  if (sel.power !== undefined) return net.net === sel.power;
  const hits = net.pins.filter((p) => matchesSymbol(sel, p) && p.pin === sel.pin);
  if (!sel.all) return hits.length > 0;
  // Every placed matching symbol has this pin on the net (and there is one).
  const wanted = state.symbols.filter((s) => placed(s) && matchesSymbol(sel, s));
  return wanted.length > 0 && wanted.every((s) => hits.some((h) => h.uuid === s.uuid));
}

function allPins(state: DeclState): SheetPin[] {
  return (state.nets ?? []).flatMap((n) => n.pins);
}

const SI: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/**
 * A component value as something comparable: a number when it reads as one
 * (`39`, `39R`, `39Ω`, `39 ohm`, `0.039k`, RKM `4k7` = `4.7k`, `4R7` = 4.7;
 * `m` is milli, `M` mega, as in KiCad), otherwise the lower-cased text
 * (`white`).
 */
export function valueKey(raw: string): number | string {
  let s = raw.trim().replace(/\s+/g, "").replace(/(ohms?|Ω|ω)$/i, "");
  const rkm = /^(\d+)([pnuµmRrkKMG])(\d+)$/.exec(s);
  if (rkm) s = `${rkm[1]}.${rkm[3]}${rkm[2]}`;
  const m = /^(\d+(?:\.\d+)?|\.\d+)([pnuµmRrkKMG])?$/.exec(s);
  if (m) return Number(m[1]) * (m[2] ? SI[m[2]]! : 1);
  return raw.trim().toLowerCase();
}

export function sameValue(a: string, b: string): boolean {
  const x = valueKey(a);
  const y = valueKey(b);
  if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y));
  return x === y;
}

/** Evaluate `c`; event leaves are true only when a matching event is in `events`. */
export function evalCond(c: Cond, state: DeclState, events: readonly TourEvent[]): boolean {
  if ("next" in c) return events.some((e) => e.type === "button" && e.button === "next");
  if ("action" in c) return events.some((e) => e.type === "action" && e.name === c.action);
  if ("dialogOpened" in c) return events.some((e) => e.type === "dialogShown" && e.cls === c.dialogOpened);
  if ("dialogClosed" in c) return events.some((e) => e.type === "dialogClosed" && e.cls === c.dialogClosed);
  if ("dialogOpen" in c) return state.dialogOpen(c.dialogOpen);
  if ("checkFinished" in c) {
    const { kind, maxErrors, maxWarnings } = c.checkFinished;
    return events.some(
      (e) =>
        e.type === "checkFinished" &&
        e.kind === kind &&
        (maxErrors === undefined || e.errors <= maxErrors) &&
        (maxWarnings === undefined || e.warnings <= maxWarnings),
    );
  }
  if ("symbols" in c) {
    const { libId: lib, min } = c.symbols;
    const n = state.symbols.filter((s) => s.libId === lib && (!c.symbols.new || state.added.has(s.uuid))).length;
    return n >= min;
  }
  if ("footprint" in c) {
    const f = c.footprint;
    const hits = state.symbols.filter(
      (s) => placed(s) && (f.libId !== undefined ? s.libId === f.libId : s.ref === f.ref),
    );
    return hits.length > 0 && hits.every((s) => (f.set === true ? s.footprint !== "" : s.footprint === f.set));
  }
  if ("value" in c) {
    const v = c.value;
    const hits = state.symbols.filter((s) => placed(s) && (v.libId !== undefined ? s.libId === v.libId : s.ref === v.ref));
    return hits.length > 0 && hits.every((s) => sameValue(s.value, v.is));
  }
  if ("orientation" in c) {
    const o = c.orientation;
    const hits = state.symbols.filter((s) => placed(s) && (o.libId !== undefined ? s.libId === o.libId : s.ref === o.ref));
    return hits.length > 0 && hits.every((s) => s.angle !== undefined && o.angle.includes(s.angle));
  }
  if ("net" in c) {
    const sels = c.net;
    return (state.nets ?? []).some((n) => sels.every((sel) => netSatisfies(n, sel, state)));
  }
  if ("noConnect" in c) {
    const sel = c.noConnect;
    const pins = allPins(state).filter((p) => matchesSymbol(sel, p) && p.pin === sel.pin);
    if (!sel.all) return pins.some((p) => p.noConnect);
    const wanted = state.symbols.filter((s) => placed(s) && matchesSymbol(sel, s));
    return wanted.length > 0 && wanted.every((s) => pins.some((p) => p.uuid === s.uuid && p.noConnect));
  }
  if ("boardFootprints" in c) {
    const f = c.boardFootprints;
    const hits = (state.board?.footprints ?? []).filter((fp) =>
      f.ref !== undefined ? fp.ref === f.ref : f.fpid !== undefined ? fp.fpid === f.fpid : true,
    );
    const turned = (fp: { angle?: number }) =>
      fp.angle !== undefined && f.angle!.some((a) => Math.abs((((fp.angle! - a) % 360) + 540) % 360 - 180) < 0.5);
    return hits.length >= (f.min ?? 1) && (!f.inside || hits.every((fp) => fp.inside)) && (!f.angle || hits.every(turned));
  }
  if ("boardOutline" in c) return state.board?.outlineClosed === true;
  if ("unrouted" in c) return !!state.board && state.board.unrouted <= c.unrouted.max;
  if ("tracks" in c) return (state.board?.tracks ?? 0) >= c.tracks.min;
  if ("activeLayer" in c) return state.board?.activeLayer === c.activeLayer;
  if ("all" in c) return c.all.every((x) => evalCond(x, state, events));
  if ("any" in c) return c.any.some((x) => evalCond(x, state, events));
  return !evalCond(c.not, state, events);
}

/** True when `c` contains an event leaf (such steps latch). */
export function hasEventLeaf(c: Cond): boolean {
  if ("next" in c || "action" in c || "dialogOpened" in c || "dialogClosed" in c || "checkFinished" in c) return true;
  if ("all" in c) return c.all.some(hasEventLeaf);
  if ("any" in c) return c.any.some(hasEventLeaf);
  if ("not" in c) return hasEventLeaf(c.not);
  return false;
}

/** True when `c` can be met by the card's Next button (the step gets one). */
export function hasNextLeaf(c: Cond): boolean {
  if ("next" in c) return true;
  if ("all" in c) return c.all.some(hasNextLeaf);
  if ("any" in c) return c.any.some(hasNextLeaf);
  return false; // under `not`, Next can never complete the step
}

/**
 * True when `c` only holds while a dialog is open. Back cannot return to such a step:
 * restoring the document does not reopen the dialog (Back lands on the step before it).
 */
export function needsOpenDialog(c: Cond | undefined): boolean {
  if (!c) return false;
  if ("dialogOpen" in c) return true;
  if ("all" in c) return c.all.some(needsOpenDialog);
  if ("any" in c) return c.any.every(needsOpenDialog);
  return false;
}

function condUsesNets(c: Cond | undefined): boolean {
  if (!c) return false;
  if ("net" in c || "noConnect" in c) return true;
  if ("all" in c) return c.all.some(condUsesNets);
  if ("any" in c) return c.any.some(condUsesNets);
  if ("not" in c) return condUsesNets(c.not);
  return false;
}

export function tourUsesNets(def: TourDef): boolean {
  return def.steps.some((s) => condUsesNets(s.when) || condUsesNets(s.until));
}

const BOARD_KEYS = ["boardFootprints", "boardOutline", "unrouted", "tracks", "activeLayer"] as const;

function condUsesBoard(c: Cond | undefined): boolean {
  if (!c) return false;
  if (BOARD_KEYS.some((k) => k in c)) return true;
  if ("all" in c) return c.all.some(condUsesBoard);
  if ("any" in c) return c.any.some(condUsesBoard);
  if ("not" in c) return condUsesBoard(c.not);
  return false;
}

/** The board is read only for tours that ask about it (targets `footprint:` resolve on their own). */
export function tourUsesBoard(def: TourDef): boolean {
  return def.steps.some((s) => condUsesBoard(s.when) || condUsesBoard(s.until));
}

/** `new:<libId>` → `item:<uuid>` of the newest such added symbol; else as-is. */
export function resolveStepTarget(target: string | undefined, state: DeclState): string | undefined {
  const m = target ? NEW_TARGET.exec(target) : null;
  if (!m) return target;
  const newest = [...state.symbols].reverse().find((s) => s.libId === m[1] && state.added.has(s.uuid));
  return newest ? `item:${newest.uuid}` : undefined;
}

// ── Compiler ────────────────────────────────────────────────────────────────

/** What the compiled tour reads from the editor (engine + editor events). */
export interface TourDeps {
  symbols(): unknown;
  nets(): unknown;
  /** `Module.kicadBoardStatus()` (PCB editor; "{}" elsewhere). */
  board(): unknown;
  /** A file open is in flight: the engine answers an empty sheet. */
  openBusy(): boolean;
  dialogOpen(cls: string): boolean;
  /** Any dialog open: its modal loop may be running — no engine reads. */
  anyDialogOpen(): boolean;
}

export interface CompileOptions {
  /** Keeps latches and the `new:` baseline across reloads (memory.ts); default: in memory only. */
  memory?: TourMemoryStore;
  /** Lets Back take the work back (checkpoints.ts); default: no Back button. */
  checkpoints?: CheckpointStore;
}

export function compileTour(def: TourDef, deps: TourDeps, opts: CompileOptions = {}): Tour<DeclState> {
  const readNets = tourUsesNets(def);
  const readBoard = tourUsesBoard(def);
  const remembered = opts.memory?.load() ?? null;
  const latched = new Set<string>(remembered?.latched ?? []);
  let shown: string | null = null;
  let symbols: SheetSymbol[] = [];
  let nets: SheetNet[] | null = null;
  let board: BoardStatus | null = null;
  let baseline: Set<string> | null = remembered?.baseline ? new Set(remembered.baseline) : null;
  const remember = () => opts.memory?.save({ latched: [...latched], baseline: baseline ? [...baseline] : null });

  // The steps in the order they first showed, each with the document as it was then.
  const history: { id: string; checkpoint: Checkpoint | null }[] = [];
  const order = new Map(def.steps.map((s, i) => [s.id, i]));
  const enter = (id: string) => {
    const at = history.findIndex((h) => h.id === id);
    if (at >= 0) history.length = at + 1; // back on an earlier step: Back, or the work was undone
    else history.push({ id, checkpoint: opts.checkpoints?.capture() ?? null });
  };
  /** Index in `history` of the step Back returns to; -1 when there is none. */
  const backTarget = () => {
    for (let i = history.length - 2; i >= 0; i--) {
      const h = history[i]!;
      if (h.checkpoint && !needsOpenDialog(def.steps[order.get(h.id)!]!.when)) return i;
    }
    return -1;
  };

  const stateOf = (): DeclState => ({
    symbols,
    nets,
    board,
    added: new Set(baseline ? symbols.filter((s) => !baseline!.has(s.uuid)).map((s) => s.uuid) : []),
    dialogOpen: deps.dialogOpen,
  });

  const done = (step: TourStepDef, s: DeclState) => latched.has(step.id) || evalCond(step.until, s, []);

  return {
    id: def.id,
    editor: def.editor,
    title: def.title ?? "Guide",
    sample(events: TourEvent[]) {
      if (!deps.openBusy() && !deps.anyDialogOpen()) {
        const read = parseSheetSymbols(deps.symbols());
        if (read) {
          symbols = read;
          if (!baseline) {
            baseline = new Set(read.map((s) => s.uuid));
            remember();
          }
        }
        if (readNets) nets = parseSheetNets(deps.nets()) ?? nets;
        if (readBoard) board = parseBoardStatus(deps.board()) ?? board;
      }
      const s = stateOf();
      // Latch the step that was on screen when these events happened.
      const current = def.steps.find((st) => st.id === shown);
      if (current && !latched.has(current.id) && hasEventLeaf(current.until) && evalCond(current.until, s, events)) {
        latched.add(current.id);
        remember();
      }
      return s;
    },
    back() {
      // A dialog's modal loop may be running; the step it belongs to is the one to finish.
      if (!opts.checkpoints || deps.anyDialogOpen()) return false;
      const i = backTarget();
      if (i < 0) return false;
      const target = history[i]!;
      if (!opts.checkpoints.restore(target.checkpoint!)) return false;
      for (const st of def.steps.slice(order.get(target.id)!)) latched.delete(st.id);
      remember();
      history.length = i + 1;
      return true;
    },
    steps: def.steps.map((step, i) => ({
      id: step.id,
      position: i + 1,
      final: i === def.steps.length - 1,
      when: (s: DeclState) => (step.when ? evalCond(step.when, s, []) : true) && !done(step, s),
      content: (s: DeclState): TourStepContent => {
        shown = step.id;
        enter(step.id);
        const buttons: OverlayButton[] = [];
        if (opts.checkpoints && !deps.anyDialogOpen() && backTarget() >= 0) buttons.push("back");
        if (hasNextLeaf(step.until)) buttons.push("next");
        return {
          target: resolveStepTarget(step.target, s),
          title: step.title,
          text: step.text,
          lostText: step.lostText,
          placement: step.placement,
          spotlight: step.spotlight,
          pulse: step.pulse,
          celebrate: step.celebrate,
          buttons: buttons.length ? buttons : undefined,
        };
      },
    })),
  };
}
