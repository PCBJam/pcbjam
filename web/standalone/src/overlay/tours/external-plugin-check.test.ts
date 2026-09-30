/**
 * Opt-in check of a plugin built OUTSIDE this repo (overlay-system 0004), against the SAME
 * validators the editor uses: every tour it hands PCBJam through `tour.start` (parseTourDef) and
 * every part through `parts.save` (footprint + placement semantics).
 *
 *   PLUGIN_CHECK_DIR=<plugin>/dist/plugin [PLUGIN_CHECK_SHEET=<finished-sheet.json>] \
 *     npx vitest run src/overlay/tours/external-plugin-check.test.ts
 *
 * The plugin's commands are unknown here, so the check calls every registered command in each
 * editor its manifest lists and collects what reaches the host. With PLUGIN_CHECK_SHEET (a
 * finished sheet as `kicadSheetSymbols`/`kicadSheetNets` report it:
 * `{ symbols, nets }`), every step's `until` that is pure state must hold on it — a wrong pin
 * number or lib id in a condition fails here, not halfway through someone's tutorial. With
 * PLUGIN_CHECK_BAD_SHEET (a broken sheet, e.g. shorted), at least one of them must NOT hold — a
 * tutorial must never report done on a board that cannot work. With PLUGIN_CHECK_BOARD (a
 * finished board as `kicadBoardStatus` reports it), the same for every PCB-editor tour.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolClipboard, resolveSymbolDefinition, withFootprintProperty } from "@pcbjam/shared";
import { pluginLibName } from "@/libs/save-part";
import { evalCond, hasEventLeaf, parseSheetNets, parseSheetSymbols, parseTourDef, type DeclState } from "./declarative";
import { parseBoardStatus } from "../board-status";

const DIR = process.env.PLUGIN_CHECK_DIR;
const SHEET = process.env.PLUGIN_CHECK_SHEET;
const BAD_SHEET = process.env.PLUGIN_CHECK_BAD_SHEET;
const BOARD = process.env.PLUGIN_CHECK_BOARD;
const platformSrc = path.resolve(__dirname, "../../../../pcbjam-shared/plugin-platform/src");
type FootprintSemantics = {
  checkFootprintStructure(text: string): void;
  sanitizeFootprint(text: string, name: string): string;
  validateFootprintSemantics(text: string): void;
};
type PlacementSemantics = { validatePlacementSemantics(text: string, tool: string): void };
type Part = { displayName: string; symbol?: { name: string; text: string }; footprint?: { name: string; text: string }; place: boolean };

/** Run every command of the plugin in `tool`; collect the tours and parts it hands the host. */
async function exercise(main: string, id: string, tool: string) {
  const handlers = new Map<string, (params?: unknown) => unknown>();
  const tours: unknown[] = [];
  const parts: Part[] = [];
  const storage = new Map<string, unknown>();
  let revision = 0;
  const lib = pluginLibName(id);
  const pcbjam = {
    handle: (name: string, fn: (params?: unknown) => unknown) => void handlers.set(name, fn),
    context: { get: async () => ({ tool, fileName: "check", readOnly: false, canPlaceItems: true, methods: [], limits: {} }) },
    storage: {
      get: async (key: string) => ({ revision, found: storage.has(key), value: storage.get(key) ?? null }),
      set: async (o: { key: string; value: unknown }) => (storage.set(o.key, o.value), { revision: ++revision }),
      delete: async (o: { key: string }) => (storage.delete(o.key), { revision: ++revision }),
      list: async () => ({ revision, keys: [...storage.keys()] }),
    },
    tour: {
      start: async (tour: unknown) => (tours.push(tour), { status: "started" }),
      stop: async () => null,
      status: async () => ({ id: null, step: 0, of: 0, state: "none" }),
    },
    ui: { overlay: { show: async () => ({ status: "shown" }), clear: async () => null } },
    parts: {
      save: async (part: Part) => {
        parts.push(part);
        return { status: "saved", library: lib, symbolLibId: part.symbol && `${lib}:${part.symbol.name}`, footprintLibId: part.footprint && `${lib}:${part.footprint.name}` };
      },
    },
    schematic: { symbols: async () => [], connectivity: async () => [] },
  };
  new Function("pcbjam", main)(pcbjam);
  for (const fn of handlers.values()) {
    try {
      await fn();
    } catch {
      /* a command that needs params or state it does not get here */
    }
  }
  return { commands: [...handlers.keys()], tours, parts };
}

describe.skipIf(!DIR)("external plugin check", () => {
  const manifest = DIR ? JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) : null;
  const main = DIR ? readFileSync(path.join(DIR, "main.js"), "utf8") : "";
  const editors: string[] = (manifest?.surfaces ?? []).map((s: string) => s.replace(/^editor:/, ""));

  it("hands PCBJam only tours the editor accepts, each for an editor the manifest lists", async () => {
    let count = 0;
    for (const tool of editors) {
      const { tours } = await exercise(main, manifest.id, tool);
      for (const tour of tours) {
        const def = parseTourDef(tour);
        expect(editors).toContain(def.editor);
        count++;
      }
    }
    expect(count, "the plugin started no tour from any command").toBeGreaterThan(0);
  });

  it("ships parts that pass the editor's symbol and footprint validation", async () => {
    const { checkFootprintStructure, sanitizeFootprint, validateFootprintSemantics } = (await import(
      /* @vite-ignore */ path.join(platformSrc, "footprint-semantics.ts")
    )) as FootprintSemantics;
    const { validatePlacementSemantics } = (await import(
      /* @vite-ignore */ path.join(platformSrc, "placement-semantics.ts")
    )) as PlacementSemantics;
    const lib = pluginLibName(manifest.id);
    const parts = (await Promise.all(editors.map((tool) => exercise(main, manifest.id, tool)))).flatMap((r) => r.parts);
    for (const part of parts) {
      if (part.footprint) {
        checkFootprintStructure(part.footprint.text);
        expect(() => validateFootprintSemantics(sanitizeFootprint(part.footprint!.text, part.footprint!.name))).not.toThrow();
      }
      if (part.symbol) {
        let def = resolveSymbolDefinition(part.symbol.text, part.symbol.name);
        if (part.footprint) def = withFootprintProperty(def, `${lib}:${part.footprint.name}`);
        const clipboard = buildSymbolClipboard(def, lib, part.symbol.name, "11111111-1111-4111-8111-111111111111");
        expect(() => validatePlacementSemantics(clipboard.sexpr, "eeschema")).not.toThrow();
      }
    }
  });

  /** Every state step of every schematic tour, evaluated on a sheet fixture. */
  async function stateSteps(file: string) {
    const sheet = JSON.parse(readFileSync(file, "utf8")) as { symbols: unknown; nets: unknown };
    const symbols = parseSheetSymbols(JSON.stringify(sheet.symbols));
    const nets = parseSheetNets(JSON.stringify(sheet.nets));
    expect(symbols, "fixture symbols").not.toBeNull();
    expect(nets, "fixture nets").not.toBeNull();
    const state: DeclState = { symbols: symbols!, nets: nets!, added: new Set(symbols!.map((s) => s.uuid)), dialogOpen: () => false };
    const { tours } = await exercise(main, manifest.id, "eeschema");
    const sch = tours.map((t) => parseTourDef(t)).filter((d) => d.editor === "eeschema");
    expect(sch.length).toBeGreaterThan(0);
    return sch.flatMap((def) => def.steps.filter((s) => !hasEventLeaf(s.until)).map((s) => ({ id: s.id, met: evalCond(s.until, state, []) })));
  }

  it.skipIf(!SHEET)("every state step is met on the finished sheet", async () => {
    for (const step of await stateSteps(SHEET!)) expect(step.met, `step ${step.id}`).toBe(true);
  });

  it.skipIf(!BOARD)("every state step of the PCB tours is met on the finished board", async () => {
    const board = parseBoardStatus(readFileSync(BOARD!, "utf8"));
    expect(board, "fixture board").not.toBeNull();
    const state: DeclState = { symbols: [], nets: [], added: new Set(), board, dialogOpen: () => false };
    const { tours } = await exercise(main, manifest.id, "pcbnew");
    const pcb = tours.map((t) => parseTourDef(t)).filter((d) => d.editor === "pcbnew");
    expect(pcb.length).toBeGreaterThan(0);
    for (const def of pcb) {
      for (const step of def.steps) {
        if (hasEventLeaf(step.until)) continue;
        expect(evalCond(step.until, state, []), `step ${step.id}`).toBe(true);
      }
    }
  });

  it.skipIf(!BAD_SHEET)("a broken sheet leaves at least one state step open", async () => {
    expect((await stateSteps(BAD_SHEET!)).filter((s) => !s.met).map((s) => s.id)).not.toEqual([]);
  });
});
