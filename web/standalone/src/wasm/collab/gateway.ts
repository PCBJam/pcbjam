/**
 * Client side of the ProjectRoom gateway (load-path-rework 0003): ONE
 * websocket per (endpoint, project) carrying every per-doc collab room plus
 * the `~presence` channel, replacing one socket per room. Facades implement
 * the existing {@link YjsProvider} seam, so sheet-manager / sibling-restage /
 * cross-app keep working unchanged; the sheet manager's warm pool additionally
 * uses `passive` subscriptions (register interest, no doc sync) + `activate()`
 * so parked sheets never wake their BoardRoom (the 0001 §5 lazy amendment).
 *
 * The per-facade y-protocol client is the ~150 lines y-partyserver's provider
 * used to do for us (Step1/Step2/Update via y-protocols/sync, awareness via
 * y-protocols/awareness), reading/writing frames tagged with the facade's
 * channel id (@pcbjam/shared gateway-wire).
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";
import {
  type GatewayClientMsg,
  type GatewayFileChange,
  type GatewayServerMsg,
  type GatewaySubMode,
  parseGatewayServerMsg,
  FILES_DOC_PATH,
  PRESENCE_DOC_PATH,
  projectRoomName,
  tagGatewayFrame,
  untagGatewayFrame,
} from "@pcbjam/shared";
import { cwarn } from "./debug";
import type { YjsProvider } from "./provider";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

const MAX_BACKOFF_MS = 30_000;
const ACTIVATE_TIMEOUT_MS = 30_000;

/**
 * The gateway refused a subscription (`suberr`): 409 invalid-file, 403
 * presence-as-readonly… Terminal for the channel — retrying cannot help until
 * the underlying condition changes, so callers must NOT enter a retry ladder
 * (sheet-manager treats it like SexprVersionError).
 */
export class CollabSubRejectedError extends Error {
  constructor(
    public readonly docPath: string,
    public readonly status: number,
    message: string,
  ) {
    super(`collab subscription to ${docPath} rejected (${status}): ${message}`);
    this.name = "CollabSubRejectedError";
  }
}

function gatewayWsUrl(endpoint: string, room: string, token?: string): string {
  let base = endpoint.replace(/\/$/, "");
  if (!/^[a-z]+:\/\//i.test(base)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(base);
    base = `${local ? "ws" : "wss"}://${base}`;
  }
  base = base.replace(/^http/, "ws");
  const url = new URL(
    `${base}/parties/project-room/${encodeURIComponent(room)}`,
  );
  url.searchParams.set("_pk", Math.random().toString(36).slice(2, 12));
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

// --- the shared per-project socket ------------------------------------------

class GatewayConnection {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private chSeq = 0;
  private readonly facades = new Map<number, GatewayDocFacade>();
  refs = 0;

  constructor(
    private readonly endpoint: string,
    private readonly room: string,
    private readonly token: string | undefined,
    private readonly onGone: () => void,
  ) {
    this.dial();
  }

  private dial(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(gatewayWsUrl(this.endpoint, this.room, this.token));
    } catch (err) {
      cwarn(`[gateway] dial failed for ${this.room}`, err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      this.open = true;
      this.attempts = 0;
      // Re-establish every live subscription, then let each facade run its
      // (re)open protocol — sub before Step1, ordered on one socket.
      for (const facade of this.facades.values()) {
        this.sendControl(facade.subMsg());
        facade.handleSocketOpen();
      }
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const data: unknown = e.data;
      if (typeof data === "string") {
        const msg = parseGatewayServerMsg(data);
        if (msg) this.facades.get(msg.ch)?.handleControl(msg);
        return;
      }
      if (data instanceof ArrayBuffer) {
        const tagged = untagGatewayFrame(new Uint8Array(data));
        if (tagged) this.facades.get(tagged.ch)?.handleFrame(tagged.frame);
      }
    };
    const down = () => {
      if (this.ws !== ws) return;
      const wasOpen = this.open;
      this.open = false;
      this.ws = null;
      if (wasOpen) {
        for (const facade of this.facades.values()) facade.handleSocketDown();
      }
      this.scheduleReconnect();
    };
    ws.onclose = down;
    ws.onerror = down;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    // Same ladder the per-room provider used (100ms · 2^n, capped) — but ONE
    // ladder for the whole project instead of one per room.
    const delay = Math.min(100 * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.dial();
    }, delay);
  }

  isOpen(): boolean {
    return this.open;
  }

  register(facade: GatewayDocFacade): number {
    const ch = this.chSeq++;
    this.facades.set(ch, facade);
    return ch;
  }

  /** Called by a registered facade once it knows its ch (post-construction). */
  announce(facade: GatewayDocFacade): void {
    if (this.open) {
      this.sendControl(facade.subMsg());
      facade.handleSocketOpen();
    }
  }

  unregister(ch: number): void {
    if (!this.facades.delete(ch)) return;
    this.sendControl({ t: "unsub", ch });
    this.refs--;
    if (this.refs <= 0) this.shutdown();
  }

  sendControl(msg: GatewayClientMsg): void {
    if (this.open && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendFrame(ch: number, frame: Uint8Array): void {
    if (this.open && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(tagGatewayFrame(ch, frame));
    }
  }

  private shutdown(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.ws?.close();
    } catch {
      /* already dead */
    }
    this.ws = null;
    this.open = false;
    this.onGone();
  }
}

const connections = new Map<string, GatewayConnection>();

function acquireConnection(
  endpoint: string,
  scopeId: string,
  projectId: string,
  token?: string,
): GatewayConnection {
  const room = projectRoomName(scopeId, projectId);
  const key = `${endpoint}|${token ?? ""}|${room}`;
  let conn = connections.get(key);
  if (!conn) {
    const created: GatewayConnection = new GatewayConnection(
      endpoint,
      room,
      token,
      () => {
        if (connections.get(key) === created) connections.delete(key);
      },
    );
    conn = created;
    connections.set(key, conn);
  }
  conn.refs++;
  return conn;
}

// --- per-doc facade ----------------------------------------------------------

export interface GatewayFacadeOpts {
  endpoint: string;
  scopeId: string;
  projectId: string;
  docPath: string;
  token?: string;
  /** Passive = register interest only (parked warm-pool sheet): no SyncStep1,
   *  no BoardRoom wake; `touched` hints + awareness still flow. */
  passive?: boolean;
  /**
   * Passive PULL (load-path-rework 0004 §2.2): while passive, send SyncStep1
   * on subscribe and on every `touched` — the gateway answers from the doc's
   * at-rest state (R2, or the live room's RPC), never by dialing its
   * BoardRoom. The doc then tracks the server without ever being a
   * participant. Ignored for active/presence/hint channels.
   */
  passiveSync?: boolean;
}

/**
 * A YjsProvider backed by one gateway sub-channel. Owns its own Awareness
 * (skeleton presence publishes a different state per parked room — 0003 §6).
 */
export class GatewayDocFacade implements YjsProvider {
  readonly awareness: Awareness;
  private readonly conn: GatewayConnection;
  private readonly ch: number;
  private readonly isPresence: boolean;
  private mode: GatewaySubMode;
  private readonly passiveSync: boolean;
  private dead: CollabSubRejectedError | null = null;
  private destroyed = false;
  /** The doc holds server state (a Step2 arrived) — in EITHER mode. */
  private synced = false;
  /** Sync state was reached as an ACTIVE participant (relay-backed). */
  private activeSynced = false;
  private subEverSent = false;
  private readonly touchedCbs: Array<() => void> = [];
  private readonly resetCbs: Array<() => void> = [];
  /** `files` hints (project-sync 0002) — only ever delivered on `~files`. */
  private readonly filesCbs: Array<(seq: number, changes: GatewayFileChange[]) => void> = [];
  /** The hint-only channel: no doc, no awareness — control frames only. */
  private readonly isHintOnly: boolean;
  private readonly syncWaiters: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];
  private readonly subWaiters: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];

  constructor(
    private readonly doc: Y.Doc,
    opts: GatewayFacadeOpts,
  ) {
    this.isPresence = opts.docPath === PRESENCE_DOC_PATH;
    this.isHintOnly = opts.docPath === FILES_DOC_PATH;
    this.docPath = opts.docPath;
    this.mode =
      (opts.passive && !this.isPresence) || this.isHintOnly ? "passive" : "active";
    this.passiveSync =
      this.mode === "passive" && !this.isHintOnly && opts.passiveSync === true;
    this.awareness = new Awareness(doc);
    this.conn = acquireConnection(
      opts.endpoint,
      opts.scopeId,
      opts.projectId,
      opts.token,
    );
    this.ch = this.conn.register(this);

    this.awareness.on("update", this.onAwarenessUpdate);
    if (!this.isPresence) this.doc.on("update", this.onDocUpdate);

    this.conn.announce(this);
  }

  readonly docPath: string;

  // --- YjsProvider ----------------------------------------------------------

  whenSynced(): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    if (this.mode === "active" && !this.isPresence) return this.activate();
    // Passive pull: "synced" = the first at-rest Step2 landed (0004 §2.2).
    if (this.passiveSync && this.mode === "passive") {
      if (this.synced) return Promise.resolve();
      return new Promise((resolve, reject) => {
        this.syncWaiters.push({ resolve, reject });
      });
    }
    // Passive/presence: "synced" = the subscription reached an open socket.
    if (this.subEverSent) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.subWaiters.push({ resolve, reject });
    });
  }

  /**
   * Upgrade to a real y-protocol participant and resolve once the doc holds
   * the server state (first SyncStep2). Idempotent; rejects with
   * {@link CollabSubRejectedError} if the gateway killed the channel.
   */
  activate(): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    if (this.isPresence || this.isHintOnly) return this.whenSynced();
    // A passive pull may already have filled the doc — that is NOT active
    // sync: the gateway must still see `act` (relay demand) and a fresh
    // Step1 as a participant before writes may flow.
    if (this.activeSynced) return Promise.resolve();
    const wasPassive = this.mode === "passive";
    this.mode = "active";
    if (this.conn.isOpen()) {
      if (wasPassive) this.conn.sendControl({ t: "act", ch: this.ch });
      this.beginSync();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      // Bounded: doSwitch serializes on this — a dead socket must surface as
      // a retryable failure, not a hung queue.
      const timer = setTimeout(() => {
        const i = this.syncWaiters.indexOf(waiter);
        if (i >= 0) this.syncWaiters.splice(i, 1);
        reject(
          new Error(
            `gateway activate for ${this.docPath} exceeded ${ACTIVATE_TIMEOUT_MS}ms`,
          ),
        );
      }, ACTIVATE_TIMEOUT_MS);
      this.syncWaiters.push(waiter);
    });
  }

  /** `touched` hints (doc changed while passive) — sheet dirty flag. */
  onTouched(cb: () => void): void {
    this.touchedCbs.push(cb);
  }

  /** `reset` (0004 §2.3): this doc's history was replaced server-side and
   *  our copy cannot be merged — the owner must drop doc + facade and
   *  subscribe afresh. Never fires for active channels. */
  onReset(cb: () => void): void {
    this.resetCbs.push(cb);
  }

  /**
   * See {@link YjsProvider.repull} — a manual SyncStep1 so a passive replica
   * can refresh without waiting for a `touched` frame (which the gateway
   * debounces leading-edge and may drop entirely).
   */
  repull(): void {
    if (this.destroyed || this.dead || this.isPresence || this.isHintOnly) return;
    if (!this.conn.isOpen()) return;
    this.sendSyncStep1();
  }

  /** `files` hints — project rows changed on the files route (0002 §1). */
  onFiles(cb: (seq: number, changes: GatewayFileChange[]) => void): void {
    this.filesCbs.push(cb);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Clean departure: the removal frame reaches peers while the socket is
    // still up (the gateway's synthesized tombstone is only the crash path).
    try {
      removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    } catch {
      /* awareness already torn down */
    }
    this.awareness.off("update", this.onAwarenessUpdate);
    if (!this.isPresence) this.doc.off("update", this.onDocUpdate);
    this.awareness.destroy();
    this.conn.unregister(this.ch);
    const err = this.dead ?? new Error("gateway facade destroyed");
    for (const w of this.syncWaiters.splice(0)) w.reject(err);
    for (const w of this.subWaiters.splice(0)) w.reject(err);
  }

  // --- wire (called by GatewayConnection) -----------------------------------

  subMsg(): GatewayClientMsg {
    return { t: "sub", ch: this.ch, doc: this.docPath, mode: this.mode };
  }

  handleSocketOpen(): void {
    if (this.destroyed || this.dead) return;
    this.subEverSent = true;
    for (const w of this.subWaiters.splice(0)) w.resolve();
    if (this.isHintOnly) return; // nothing to announce, nothing to sync
    // (Re)announce presence: a query for peers' states + our own, if any.
    this.sendQueryAwareness();
    if (this.awareness.getLocalState() !== null) this.publishLocalAwareness();
    if (this.mode === "active" && !this.isPresence) this.beginSync();
    // Passive pull: fill (or refresh, after a reconnect) from the at-rest state.
    else if (this.passiveSync && this.mode === "passive") this.sendSyncStep1();
  }

  handleSocketDown(): void {
    // Same as y-websocket: peers' awareness is stale the moment the socket
    // drops; local state survives and re-publishes on reconnect.
    const remote = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.doc.clientID,
    );
    if (remote.length > 0) {
      removeAwarenessStates(this.awareness, remote, "connection closed");
    }
    this.synced = false;
    this.activeSynced = false;
  }

  handleControl(msg: GatewayServerMsg): void {
    if (this.destroyed) return;
    if (msg.t === "suberr") {
      this.dead = new CollabSubRejectedError(
        this.docPath,
        msg.status,
        msg.message,
      );
      cwarn(`[gateway] ${this.dead.message}`);
      for (const w of this.syncWaiters.splice(0)) w.reject(this.dead);
      for (const w of this.subWaiters.splice(0)) w.reject(this.dead);
      return;
    }
    if (msg.t === "resync") {
      // The doc's relay (re)connected server-side — our Step1 pulls the news.
      if (this.mode === "active" && !this.isPresence) this.sendSyncStep1();
      return;
    }
    if (msg.t === "files") {
      for (const cb of this.filesCbs) cb(msg.seq, msg.changes);
      return;
    }
    if (msg.t === "gone") {
      // A peer connection died; the gateway names its awareness clients. The
      // clock-ordered binary tombstone may have been rejected (stale clock
      // after a hibernation wake) — this removal is authoritative. A live
      // client with one of these ids simply re-appears on its next update.
      const remote = msg.clients.filter(
        (id) => id !== this.doc.clientID && this.awareness.getStates().has(id),
      );
      if (remote.length > 0) {
        removeAwarenessStates(this.awareness, remote, "gateway-gone");
      }
      return;
    }
    if (msg.t === "reset") {
      // Only a passive puller can be ahead of a replaced epoch; an active
      // channel never receives this (its Step1 goes to the BoardRoom).
      for (const cb of this.resetCbs) cb();
      return;
    }
    // touched: a passive puller re-pulls (diff against its own SV); every
    // passive channel still gets the dirty-flag callback.
    if (this.passiveSync && this.mode === "passive" && this.conn.isOpen()) {
      this.sendSyncStep1();
    }
    for (const cb of this.touchedCbs) cb();
  }

  handleFrame(frame: Uint8Array): void {
    if (this.destroyed || frame.length === 0) return;
    try {
      this.handleFrameInner(frame);
    } catch (err) {
      // A malformed frame must never take down the shared socket's handler.
      cwarn(`[gateway] dropped undecodable frame for ${this.docPath}`, err);
    }
  }

  private handleFrameInner(frame: Uint8Array): void {
    const decoder = decoding.createDecoder(frame.slice());
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      if (this.isPresence) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const messageType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        this.doc,
        this,
      );
      if (encoding.length(encoder) > 1) {
        this.send(encoding.toUint8Array(encoder));
      }
      if (messageType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
        if (this.mode === "active") this.activeSynced = true;
        for (const w of this.syncWaiters.splice(0)) w.resolve();
      }
      return;
    }
    if (type === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        "gateway-remote",
      );
      return;
    }
    if (type === MESSAGE_QUERY_AWARENESS) {
      // A peer asks who is here — answer with our own state only.
      if (this.awareness.getLocalState() !== null) this.publishLocalAwareness();
    }
  }

  // --- internals ------------------------------------------------------------

  private send(frame: Uint8Array): void {
    this.conn.sendFrame(this.ch, frame);
  }

  private beginSync(): void {
    this.sendSyncStep1();
  }

  private sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
  }

  private sendQueryAwareness(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_QUERY_AWARENESS);
    this.send(encoding.toUint8Array(encoder));
  }

  private publishLocalAwareness(): void {
    if (this.isHintOnly) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(encoder));
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return; // our own readSyncMessage apply
    if (this.mode === "passive") {
      // A local write into a passive doc (activate-before-write slipped) —
      // auto-activate so the edit is neither dropped nor pushed unsynced.
      void this.activate().catch(() => {
        /* surfaced via the activate caller/suberr path */
      });
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private readonly onAwarenessUpdate = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === "gateway-remote") return; // no echo loops
    const changed = added.concat(updated).concat(removed);
    if (changed.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(this.awareness, changed),
    );
    this.send(encoding.toUint8Array(encoder));
  };
}
