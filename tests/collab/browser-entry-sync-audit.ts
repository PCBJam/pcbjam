/** Audit driver only: production converters, bindings, sheet manager and BC transport. */
import {
  collabRoomId, docToFile, fileToDoc, renderItem, syncLayoutToY, yToDoc,
  type KicadDoc,
} from '@pcbjam/shared';
import { attachKicadCollab, connectKicadDoc, type KicadDocSession } from '../../web/standalone/src/wasm/collab/index';
import { createSheetCollabManager, registerSheetChangedHook, registerSheetItemsHook, type SheetCollabManager } from '../../web/standalone/src/wasm/collab/sheet-manager';

const win = window as any;
const base = '/home/kicad/documents/';
let session: KicadDocSession;
let manager: SheetCollabManager | undefined;
let layoutBaseline: KicadDoc;
const rooms = new Map<string, KicadDocSession>();
const pending = new Set<Promise<void>>();
const audit = {
  tool: 'pcb' as 'pcb' | 'sch',
  sheetEvents: [] as { path: string; json: string }[],
  errors: [] as string[],
  emitted: [] as string[],
  heldLocal: [] as string[],
  heldRemote: [] as string[],
  get doc() { return manager ? manager.active()!.doc : session.doc; },
  get activePath() { return manager?.active()?.sheetPath; },
  get pending() { return pending.size; },
  room(project: string, file: string) { return collabRoomId('audit', project, file); },
  async connect(room: string) {
    session = await connectKicadDoc({ provider: { kind: 'broadcastchannel', settleMs: 400 }, room });
  },
  attach(seed: string, matches = false) {
    layoutBaseline = fileToDoc(seed);
    attachKicadCollab(win.Module, win, session, { seedDoc: layoutBaseline, editorMatchesDoc: matches });
    const emit = win.kicadCollab.onItems;
    win.kicadCollab.onItems = (json: string) => { this.emitted.push(json); emit(json); };
  },
  render() { return docToFile(yToDoc(this.doc)); },
  item(id: string, native = false) {
    const doc = native ? fileToDoc(this.model()) : yToDoc(this.doc);
    return doc.items[id] ? renderItem(doc, id) : '';
  },
  model() {
    const out = `${base}audit-readback.${this.tool === 'pcb' ? 'kicad_pcb' : 'kicad_sch'}`;
    if (this.tool === 'pcb') win.Module.kicadSaveBoard(out);
    else win.Module.kicadSaveSchematic(out);
    return win.FS.readFile(out, { encoding: 'utf8' }) as string;
  },
  saveLayout() {
    const next = fileToDoc(this.model());
    syncLayoutToY(next, this.doc, 'audit-native-save', layoutBaseline);
    layoutBaseline = next;
  },
  /** Hold the real serialized commit and native apply at the asynchronous boundary. */
  hold() {
    const emit = win.kicadCollab.onItems;
    const apply = win.Module.kicadCollabApplyItems;
    this.heldLocal = []; this.heldRemote = [];
    win.kicadCollab.onItems = (json: string) => this.heldLocal.push(json);
    win.Module.kicadCollabApplyItems = (json: string) => this.heldRemote.push(json);
    this.release = () => {
      win.kicadCollab.onItems = emit;
      win.Module.kicadCollabApplyItems = apply;
      for (const json of this.heldLocal) emit(json);
      for (const json of this.heldRemote) apply(json);
    };
  },
  release(): void { throw new Error('Call hold first'); },
  async sheets(project: string, paths: string[], initial: string) {
    manager = createSheetCollabManager({
      mod: win.Module, win, scopeId: 'audit', projectId: project,
      provider: { kind: 'broadcastchannel', settleMs: 400 },
      seedDocForPath: p => fileToDoc(win.FS.readFile(base + p, { encoding: 'utf8' })),
      log: m => console.log('[sync-audit]', m),
    });
    function track(p: Promise<void>) {
      pending.add(p);
      p.then(() => pending.delete(p), e => { pending.delete(p); audit.errors.push(String(e)); });
    }
    registerSheetChangedHook(win, abs => track(manager!.switchTo(abs.slice(base.length))));
    registerSheetItemsHook(win, (abs, json) => {
      audit.sheetEvents.push({ path: abs, json });
      track(manager!.writeOffSheet(abs.slice(base.length), json));
    });
    await manager.connectAll(paths);
    await manager.switchTo(initial);
    for (const p of paths) rooms.set(p, await connectKicadDoc({
      room: this.room(project, p), provider: { kind: 'broadcastchannel', settleMs: 400 },
    }));
  },
  sheetText(path: string) { return docToFile(yToDoc(rooms.get(path)!.doc)); },
  nativeSheet(path: string) { return win.Module.kicadCollabTestAuditSheetItems(base + path) as string; },
};
win.syncAudit = audit;
