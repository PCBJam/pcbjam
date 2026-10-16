/**
 * The panel's side of the AI chat's editor bridge (ai-chat 0003 step 5): over
 * the chat's own WebSocket it tells the chat which file this tab shows, and
 * carries out the chat's edits on it with the agent executor (step 4), so they
 * are KiCad's own: one undo step each, a placement that follows the cursor. On a
 * board it runs Update PCB (step 5b), asking the person through `confirm`.
 * Frames: `agent-editor-wire` in @pcbjam/shared.
 */
import {
  agentEditorFrame,
  parseAgentEditorToPanel,
  type AgentApplyResult,
  type AgentEditorExec,
  type AgentPlaceResult,
  type AgentReadResult,
  type AgentUpdatePcbResult,
} from '@pcbjam/shared';
import { applyAgentEdit, placeAgentPart, readParts, updatePcb, type ConfirmUpdatePcb } from './executor';

/** The chat connection (`useAgent`'s socket), as far as the bridge needs it. */
export interface BridgeSocket {
  send(text: string): void;
  addEventListener(type: 'message' | 'open' | 'close', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'open' | 'close', listener: (event: MessageEvent) => void): void;
}

/** What this tab shows right now. */
export interface BridgeView {
  scope: string;
  project: string;
  /** The working copy's room segment: null for the default copy. */
  copy: string | null;
  file: string;
  tool: string;
}

export interface BridgeExecutor {
  apply: typeof applyAgentEdit;
  place: typeof placeAgentPart;
  read: typeof readParts;
  updatePcb: typeof updatePcb;
}
const kicad: BridgeExecutor = { apply: applyAgentEdit, place: placeAgentPart, read: readParts, updatePcb };

/** Without a panel to ask in, nothing that needs the person's approval is applied. */
const declineAll: ConfirmUpdatePcb = async () => false;

/** One exec, refused when this tab no longer shows its file or is not the editor it needs. */
export async function runAgentExec(
  exec: AgentEditorExec,
  view: BridgeView,
  signal: AbortSignal,
  executor: BridgeExecutor = kicad,
  confirm: ConfirmUpdatePcb = declineAll,
): Promise<AgentApplyResult | AgentPlaceResult | AgentReadResult | AgentUpdatePcbResult> {
  // Exactly this tab's project, working copy and file: after a switch, an exec in flight must not land on a
  // same-named file elsewhere (working copies share uuids, so it would apply cleanly; ai-chat 0006 A3).
  if (exec.scope !== view.scope || exec.project !== view.project || (exec.copy ?? null) !== view.copy || exec.copy === undefined) {
    return { error: 'The editor now shows another project or working copy.', code: 'OTHER_FILE' };
  }
  if (exec.file !== view.file) return { error: `The editor now shows ${view.file}, not ${exec.file}.`, code: 'OTHER_FILE' };
  if (exec.op === 'update_pcb') {
    if (view.tool !== 'pcbnew') return { error: `Update PCB runs in the board editor: open ${exec.file}.`, code: 'NO_EDITOR' };
    return executor.updatePcb({ dryRun: exec.dryRun, deleteUnused: exec.deleteUnused }, signal, confirm);
  }
  if (view.tool !== 'eeschema') return { error: 'Open the schematic editor for this.', code: 'NO_EDITOR' };
  switch (exec.op) {
    case 'apply':
      return executor.apply(exec.edit, signal, view.tool);
    case 'place':
      return executor.place(exec.blob, signal, { tool: view.tool });
    case 'read':
      return executor.read();
  }
}

/**
 * Attach this tab's editor to the chat: announce the file (again after every
 * reconnect), answer each exec, honour cancels. `confirm` asks the person to
 * approve an Update PCB that would remove or rewire anything. Returns the detach.
 */
export function attachEditorBridge(
  socket: BridgeSocket,
  view: () => BridgeView,
  executor: BridgeExecutor = kicad,
  confirm: ConfirmUpdatePcb = declineAll,
): () => void {
  const running = new Map<string, AbortController>();
  const attach = () => {
    const { scope, project, copy, file, tool } = view();
    socket.send(agentEditorFrame({ type: 'pcbjam.editor.attach', scope, project, copy, file, tool }));
  };
  const onMessage = (event: MessageEvent) => {
    const msg = parseAgentEditorToPanel(event.data);
    if (!msg) return;
    if (msg.type === 'pcbjam.editor.cancel') {
      running.get(msg.id)?.abort();
      return;
    }
    const stop = new AbortController();
    running.set(msg.id, stop);
    void runAgentExec(msg, view(), stop.signal, executor, confirm)
      .catch((error: unknown) => ({ error: (error as Error)?.message || 'The editor failed', code: 'FAILED' }))
      .then((result) => {
        running.delete(msg.id);
        socket.send(agentEditorFrame({ type: 'pcbjam.editor.result', id: msg.id, result }));
      });
  };
  // A dropped connection already told the chat "detached": withdraw what still runs here
  // (an open Update PCB card among it), so nothing applies that the chat counts as failed.
  const onClose = () => {
    for (const stop of running.values()) stop.abort();
  };
  socket.addEventListener('open', attach);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  attach();
  return () => {
    socket.removeEventListener('open', attach);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    for (const stop of running.values()) stop.abort();
    socket.send(agentEditorFrame({ type: 'pcbjam.editor.detach' }));
  };
}
