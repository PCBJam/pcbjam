/// <reference lib="webworker" />
// The narrow entry: the package root would pull every contract module into the worker.
import { indexFootprintItem, indexSymbolItem, type LibIndexKind } from "@pcbjam/shared/lib-index";

/**
 * Library index rows off the main thread (libs 0028 section 8.1): a library
 * with no server rows (a live team layer, a CDN snapshot) is indexed from its
 * bodies here, so a full set (2-4 s of parsing) never blocks the editor.
 */
export interface LibIndexWorkerRequest {
  id: number;
  kind: LibIndexKind;
  items: Array<[path: string, body: Uint8Array]>;
}

declare const self: DedicatedWorkerGlobalScope;

const dec = new TextDecoder();

self.onmessage = (e: MessageEvent<LibIndexWorkerRequest>) => {
  const { id, kind, items } = e.data;
  const rows = items.map(([path, body]) => {
    const name = path.slice(path.indexOf("/") + 1);
    const text = dec.decode(body);
    return kind === "symbol" ? indexSymbolItem(name, text) : indexFootprintItem(name, text);
  });
  self.postMessage({ id, rows });
};
