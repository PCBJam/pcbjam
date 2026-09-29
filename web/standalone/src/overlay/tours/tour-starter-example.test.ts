import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolClipboard, resolveSymbolDefinition, withFootprintProperty } from "@pcbjam/shared";
import { pluginLibName } from "@/libs/save-part";
import { parseTourDef } from "./declarative";

// The shipped example plugin (plugin-platform/examples/tour-starter), run against the SAME
// validators the editor uses — so the example can never drift into something PCBJam refuses.
const main = readFileSync(
  path.resolve(__dirname, "../../../../pcbjam-shared/plugin-platform/examples/tour-starter/main.js"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../pcbjam-shared/plugin-platform/examples/tour-starter/manifest.json"), "utf8"),
);

// The platform's validators, loaded at run time: importing them statically would type-check the
// platform's sources under this package's stricter compiler settings.
const platformSrc = path.resolve(__dirname, "../../../../pcbjam-shared/plugin-platform/src");
type FootprintSemantics = {
  checkFootprintStructure(text: string): void;
  sanitizeFootprint(text: string, name: string): string;
  validateFootprintSemantics(text: string): void;
};
type PlacementSemantics = { validatePlacementSemantics(text: string, tool: string): void };

function load() {
  const handlers: Record<string, () => unknown> = {};
  const pcbjam = {
    handle: (name: string, fn: () => unknown) => void (handlers[name] = fn),
    tour: { start: (tour: unknown, options?: unknown) => ({ tour, options }), status: () => null },
    parts: { save: (part: unknown) => part },
  };
  new Function("pcbjam", main)(pcbjam);
  return handlers;
}

describe("tour-starter example plugin", () => {
  const handlers = load();

  it("registers its commands and hands PCBJam a valid tour", () => {
    expect(Object.keys(handlers).sort()).toEqual(["addPart", "resume", "start", "status"]);
    const { tour } = handlers.start!() as { tour: unknown };
    const def = parseTourDef(tour);
    expect(def.steps.map((s) => s.id)).toEqual(["tool", "search", "place", "part", "done"]);
    expect((handlers.resume!() as { options: unknown }).options).toEqual({ resume: true });
  });

  it("waits for its part under the library PCBJam will actually use", () => {
    const { tour } = handlers.start!() as { tour: { steps: { id: string; until: unknown }[] } };
    const lib = pluginLibName(manifest.id);
    expect(tour.steps.find((s) => s.id === "part")!.until).toEqual({ symbols: { libId: `${lib}:Demo_Part`, min: 1, new: true } });
  });

  it("ships a part that passes the editor's symbol and footprint validation", async () => {
    const { checkFootprintStructure, sanitizeFootprint, validateFootprintSemantics } = (await import(
      /* @vite-ignore */ path.join(platformSrc, "footprint-semantics.ts")
    )) as FootprintSemantics;
    const { validatePlacementSemantics } = (await import(
      /* @vite-ignore */ path.join(platformSrc, "placement-semantics.ts")
    )) as PlacementSemantics;
    const part = handlers.addPart!() as { symbol: { name: string; text: string }; footprint: { name: string; text: string } };
    checkFootprintStructure(part.footprint.text);
    const footprint = sanitizeFootprint(part.footprint.text, part.footprint.name);
    expect(() => validateFootprintSemantics(footprint)).not.toThrow();

    const lib = pluginLibName(manifest.id);
    const def = withFootprintProperty(resolveSymbolDefinition(part.symbol.text, part.symbol.name), `${lib}:${part.footprint.name}`);
    const clipboard = buildSymbolClipboard(def, lib, part.symbol.name, "11111111-1111-4111-8111-111111111111");
    expect(() => validatePlacementSemantics(clipboard.sexpr, "eeschema")).not.toThrow();
  });
});
