import { describe, expect, it } from "vitest";
import { openFileInTool } from "./open-flow";

/**
 * The programmatic-open settle gate (open_gate.h / kicadOpenFileBusy): the
 * shell must not report the open finished — and so must not go on to drive
 * bare embind entries (collab snapshot, presence bind) — while the
 * kicadOpenFile Asyncify chain is still parked mid-load. Regression tests for
 * the prod "indirect call signature mismatch" trap at board load.
 */

function makeElement(partial: Partial<WxElementInfo>): WxElementInfo {
  return {
    id: "e1",
    typeName: "wxFrame",
    name: "MainFrame",
    label: "",
    visible: true,
    enabled: true,
    screenX: 0,
    screenY: 0,
    centerX: 0,
    centerY: 0,
    width: 100,
    height: 100,
    ...partial,
  };
}

function makeWin(opts: {
  busy?: () => boolean;
  open?: (path: string) => boolean | Promise<boolean>;
  elements?: () => WxElementInfo[];
  title?: () => string;
}) {
  const opened: string[] = [];
  const elements =
    opts.elements ?? (() => [makeElement({ typeName: "PCB_EDIT_FRAME" })]);
  const win = {
    document: {
      get title() {
        return opts.title ? opts.title() : "PCB Editor";
      },
    },
    Module: {
      kicadOpenFile: (p: string) => {
        opened.push(p);
        return opts.open?.(p) ?? false; // legacy Asyncify placeholder by default
      },
      ...(opts.busy ? { kicadOpenFileBusy: opts.busy } : {}),
    },
    wxElementRegistry: {
      findAll: (filter?: { visible?: boolean }) =>
        elements().filter((e) => (filter?.visible === undefined ? true : e.visible)),
      findByLabel: () => [],
      findRenderedByLabel: () => [],
    },
  };
  return { win: win as unknown as ToolWindow, opened };
}

const log = () => {};

describe("openFileInTool settle gate", () => {
  it("waits for kicadOpenFileBusy to clear before reporting success", async () => {
    let busy = true;
    setTimeout(() => (busy = false), 350);
    const { win, opened } = makeWin({ busy: () => busy });
    const result = await openFileInTool(win, "/p/board.kicad_pcb", { log });
    expect(result).toBe("programmatic");
    expect(opened).toEqual(["/p/board.kicad_pcb"]);
    expect(busy).toBe(false); // returned only after the chain settled
  });

  it("returns failed when the open chain never settles", async () => {
    const { win } = makeWin({ busy: () => true });
    const result = await openFileInTool(win, "/p/board.kicad_pcb", {
      log,
      settleTimeoutMs: 300,
    });
    expect(result).toBe("failed");
  });

  it("proceeds when a modal input dialog is up (must stay answerable)", async () => {
    const elements = [makeElement({ typeName: "PCB_EDIT_FRAME" })];
    setTimeout(
      () => elements.push(makeElement({ id: "d1", typeName: "wxRichMessageDialog" })),
      250,
    );
    const { win } = makeWin({ busy: () => true, elements: () => elements });
    const result = await openFileInTool(win, "/p/board.kicad_pcb", {
      log,
      settleTimeoutMs: 5000,
    });
    expect(result).toBe("programmatic");
  });

  it("uses the exact owned-open Promise, not the legacy busy probe", async () => {
    const elements = [makeElement({ typeName: "PCB_EDIT_FRAME" })];
    let finish!: (value: boolean) => void;
    const owned = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const visibility: boolean[] = [];
    const { win } = makeWin({
      busy: () => true,
      elements: () => elements,
      open: () => owned,
    });

    const pending = openFileInTool(win, "/p/board.kicad_pcb", {
      log,
      onInputDialog: (visible) => visibility.push(visible),
    });
    setTimeout(
      () => elements.push(makeElement({ id: "d1", typeName: "wxRichMessageDialog" })),
      50,
    );
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(visibility).toContain(true);
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed, "modal visibility is not native-owner completion").toBe(false);

    finish(true);
    await expect(pending).resolves.toBe("programmatic");
    expect(visibility.at(-1)).toBe(false);
    // The legacy probe deliberately remains true. A current owned-open ticket
    // is authoritative and must not fall back to this TOCTOU poll.
  });

  it("does NOT treat the load's own progress dialog as an input dialog", async () => {
    const elements = [
      makeElement({ typeName: "PCB_EDIT_FRAME" }),
      makeElement({ id: "d1", typeName: "wxGenericProgressDialog" }),
    ];
    const { win } = makeWin({ busy: () => true, elements: () => elements });
    const result = await openFileInTool(win, "/p/board.kicad_pcb", {
      log,
      settleTimeoutMs: 300,
    });
    expect(result).toBe("failed"); // progress dialog must not open the gate
  });

  it("falls back to the legacy title heuristic on wasm without the probe", async () => {
    let title = "untitled [Unsaved] — Schematic Editor";
    setTimeout(() => (title = "board — Schematic Editor"), 250);
    const { win } = makeWin({ title: () => title });
    const result = await openFileInTool(win, "/p/main.kicad_sch", { log });
    expect(result).toBe("programmatic");
  });
});
