import { describe, expect, it, vi } from "vitest";
import { SavePartError, type PartPack, type SavePartOptions, type SavePartResult } from "@/libs/save-part";
import { pluginPartSaver, type PluginPartSummary } from "./plugin-parts";

const RESULT: SavePartResult = {
  libId: "lib-1",
  libNickname: "plugin_usb_tutorial",
  symbolLibId: "plugin_usb_tutorial:USB_A_PCB_Edge",
  footprintLibId: "plugin_usb_tutorial:USB_A_PCB_Edge",
  skipped: [],
};
const REQUEST = {
  displayName: "USB-A PCB edge plug",
  symbol: { name: "USB_A_PCB_Edge", text: "(kicad_symbol_lib)" },
  footprint: { name: "USB_A_PCB_Edge", text: "(footprint \"USB_A_PCB_Edge\")" },
  place: true,
};

function setup(over: { confirm?: boolean; save?: (pack: PartPack, o: SavePartOptions) => Promise<SavePartResult>; authorize?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const summaries: PluginPartSummary[] = [];
  const packs: PartPack[] = [];
  const issues: string[] = [];
  const saver = pluginPartSaver({
    pluginId: "usb-tutorial",
    confirm: async (summary) => {
      calls.push("confirm");
      summaries.push(summary);
      return over.confirm ?? true;
    },
    authorize: over.authorize ?? (async () => void calls.push("authorize")),
    save:
      over.save ??
      (async (pack, o) => {
        calls.push("save");
        packs.push(pack);
        o.onSaved?.(RESULT);
        return { ...RESULT, placement: "placed" };
      }),
    onPlacementIssue: (m) => issues.push(m),
  });
  return { saver, calls, summaries, packs, issues };
}
const signal = () => new AbortController().signal;

describe("pluginPartSaver", () => {
  it("confirms, authorizes, then saves into plugin_<id> — never a plugin-named library", async () => {
    const { saver, calls, summaries, packs } = setup();
    expect(await saver(REQUEST, signal())).toEqual({
      status: "saved",
      library: "plugin_usb_tutorial",
      symbolLibId: "plugin_usb_tutorial:USB_A_PCB_Edge",
      footprintLibId: "plugin_usb_tutorial:USB_A_PCB_Edge",
    });
    expect(calls).toEqual(["confirm", "authorize", "save"]);
    expect(summaries[0]).toEqual({
      displayName: "USB-A PCB edge plug",
      library: "plugin_usb_tutorial",
      symbol: "USB_A_PCB_Edge",
      footprint: "USB_A_PCB_Edge",
      bytes: REQUEST.symbol.text.length + REQUEST.footprint.text.length,
      place: true,
    });
    expect(packs[0]).toMatchObject({ providerOrigin: "", providerId: "usb-tutorial", libraryName: "plugin_usb_tutorial" });
    expect(new TextDecoder().decode(packs[0]!.symbol!.bytes)).toBe(REQUEST.symbol.text);
  });

  it("a declined confirmation saves nothing", async () => {
    const { saver, calls } = setup({ confirm: false });
    expect(await saver(REQUEST, signal())).toEqual({ status: "cancelled" });
    expect(calls).toEqual(["confirm"]);
  });

  it("a refused authorization saves nothing", async () => {
    const { saver, calls } = setup({ authorize: async () => { throw new Error("Account changed"); } });
    await expect(saver(REQUEST, signal())).rejects.toThrow(/Account changed/);
    expect(calls).toEqual(["confirm"]);
  });

  it("answers once the part is stored, without waiting for the placement click", async () => {
    let finishPlacement!: () => void;
    const { saver } = setup({
      save: (_pack, o) => {
        o.onSaved?.(RESULT);
        return new Promise((resolve) => (finishPlacement = () => resolve({ ...RESULT, placement: "placed" })));
      },
    });
    await expect(saver(REQUEST, signal())).resolves.toMatchObject({ status: "saved" });
    finishPlacement();
  });

  it("errors before the save reach the plugin with their code; after it, the user", async () => {
    const before = setup({ save: async () => { throw new SavePartError("NOT_SIGNED_IN", "Sign in to save parts"); } });
    await expect(before.saver(REQUEST, signal())).rejects.toThrow("NOT_SIGNED_IN: Sign in to save parts");

    const after = setup({
      save: async (_pack, o) => {
        o.onSaved?.(RESULT);
        throw new SavePartError("PLACEMENT_UNAVAILABLE", "Placement is unavailable");
      },
    });
    await expect(after.saver(REQUEST, signal())).resolves.toMatchObject({ status: "saved" });
    await vi.waitFor(() => expect(after.issues).toEqual(["Placement is unavailable"]));
  });

  it("a footprint-only part saves without a symbol", async () => {
    const { saver, packs } = setup({
      save: async (pack, o) => {
        packs.push(pack);
        o.onSaved?.({ ...RESULT, symbolLibId: undefined });
        return RESULT;
      },
    });
    const { symbol: _omit, ...footprintOnly } = REQUEST;
    expect(await saver({ ...footprintOnly, place: false }, signal())).toEqual({
      status: "saved",
      library: "plugin_usb_tutorial",
      footprintLibId: "plugin_usb_tutorial:USB_A_PCB_Edge",
    });
    expect(packs[0]!.symbol).toBeUndefined();
  });
});
