/**
 * The panel's side of the AI chat's editor bridge (ai-chat 0003 step 5): over
 * the chat's own WebSocket it tells the chat which file this tab shows, and
 * carries out the chat's edits on it with the agent executor (step 4), so they
 * are KiCad's own: one undo step each, a placement that follows the cursor.
 * Frames: `agent-editor-wire` in @pcbjam/shared.
 */
import {
  agentEditorFrame,
  parseAgentEditorToPanel,
  type AgentApplyResult,
  type AgentEditorExec,
  type AgentPlaceResult,
  type AgentReadResult,
} from '@pcbjam/shared';
import { applyAgentEdit, placeAgentPart, readParts } from './executor';

/** The chat connection (`useAgent`'s socket), as far as the bridge needs it. */
export interface BridgeSocket {
  send(text: string): void;
  addEventListener(type: 'message' | 'open', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'open', listener: (event: MessageEvent) => void): void;
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
}
const kicad: BridgeExecutor = { apply: applyAgentEdit, place: placeAgentPart, read: readParts };

/** One exec, refused when this tab no longer shows its file or is not a schematic editor. */
export async function runAgentExec(
  exec: AgentEditorExec,
  view: BridgeView,
  signal: AbortSignal,
  executor: BridgeExecutor = kicad,
): Promise<AgentApplyResult | AgentPlaceResult | AgentReadResult> {
  if (exec.file !== view.file) return { error: `The editor now shows ${view.file}, not ${exec.file}.`, code: 'OTHER_FILE' };
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
 * reconnect), answer each exec, honour cancels. Returns the detach.
 */
export function attachEditorBridge(socket: BridgeSocket, view: () => BridgeView, executor: BridgeExecutor = kicad): () => void {
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
    void runAgentExec(msg, view(), stop.signal, executor)
      .catch((error: unknown) => ({ error: (error as Error)?.message || 'The editor failed', code: 'FAILED' }))
      .then((result) => {
        running.delete(msg.id);
        socket.send(agentEditorFrame({ type: 'pcbjam.editor.result', id: msg.id, result }));
      });
  };
  socket.addEventListener('open', attach);
  socket.addEventListener('message', onMessage);
  attach();
  return () => {
    socket.removeEventListener('open', attach);
    socket.removeEventListener('message', onMessage);
    for (const stop of running.values()) stop.abort();
    socket.send(agentEditorFrame({ type: 'pcbjam.editor.detach' }));
  };
}
