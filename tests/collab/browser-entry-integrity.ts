// Browser bundle entry for the ysync-integrity e2e (ysync 0013): the PRODUCTION
// connect → materialize → attach pair WasmTool runs for the ydoc load path,
// exposed step by step so a spec can control the interval between the
// materialization and the native open/attach (finding #1's window), plus
// oracles over the live room doc and the native model.
//
// Build: node collab/build-integrity.mjs (tests/) → apps/kicad/collab-integrity.js
import { docToFile, fileToDoc, renderItem, yToDoc } from "@pcbjam/shared";
import {
  attachKicadCollab,
  connectKicadDoc,
  type KicadCollabHandle,
  type KicadDocSession,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "../../web/standalone/src/wasm/collab/index";

interface Win extends KicadItemsWindow {
  Module: KicadItemsModule & {
    kicadSaveBoard?: (path: string) => void;
    kicadSaveSchematic?: (path: string) => void;
  };
  FS: { readFile(p: string, o: { encoding: "utf8" }): string; unlink(p: string): void };
  integrity: typeof integrity;
}
const win = window as unknown as Win;

const state: { session?: KicadDocSession; handle?: KicadCollabHandle } = {};
function session(): KicadDocSession {
  if (!state.session) throw new Error("integrity: connect() first");
  return state.session;
}

const integrity = {
  /** The live room doc (yjs instance = the bundle's single copy). */
  get doc() {
    return session().doc;
  },
  get handle() {
    return state.handle;
  },
  shared: { renderItem, yToDoc, docToFile, fileToDoc },

  /** maybeConnectDocSession's connect half: provider up, initial state synced. */
  async connect(room: string): Promise<void> {
    state.session = await connectKicadDoc({
      provider: { kind: "broadcastchannel", settleMs: 400 },
      room,
    });
  },

  /**
   * maybeConnectDocSession's materialize half: the file text the editor is
   * handed. The FIRST render after connect also records the items as
   * materialized on the session (loadedView) exactly like production does;
   * attach() consumes it. Later renders are pure observation.
   */
  render(): string {
    const s = session();
    const kdoc = yToDoc(s.doc);
    if (s.loadedView === undefined) s.loadedView = kdoc.items;
    return docToFile(kdoc);
  },

  /** attachKicadCollab as WasmTool calls it (file-seed vs ydoc-load branches). */
  attach(seed?: string, matches = false): void {
    state.handle = attachKicadCollab(win.Module, win, session(), {
      seedDoc: seed ? fileToDoc(seed) : undefined,
      editorMatchesDoc: matches,
    });
  },

  /** The NATIVE model, serialized by the tool's own writer. */
  model(): string {
    const path = "/home/kicad/documents/integrity-model.tmp";
    if (win.Module.kicadSaveBoard) win.Module.kicadSaveBoard(path);
    else if (win.Module.kicadSaveSchematic) win.Module.kicadSaveSchematic(path);
    else throw new Error("integrity: no native save export");
    const text = win.FS.readFile(path, { encoding: "utf8" });
    try {
      win.FS.unlink(path);
    } catch {
      /* best effort */
    }
    return text;
  },
};

win.integrity = integrity;
