import type { LibInfo, LibItemInfo, LibsSource } from "./source";

/**
 * Write-path spike (no backend). Wraps a `LibsSource` with ONE in-memory writable
 * user lib so the editor's save flow has a target and we can exercise the full
 * save → enumerate → load round-trip through the same WASM bridge — without
 * committing to the backend design first.
 *
 * - Symbols (0004-A): `?libwrite=1` → `withSpikeWritableLib`.
 * - Footprints (0009-S): `?fpwrite=1` → `withSpikeWritableFpLib`.
 *
 * Saved bodies are mirrored onto `window.__pcbjamSaved` so the Playwright probe
 * can inspect them. Replaced by real remote writes once the backend lands.
 */
declare global {
  interface Window {
    __pcbjamSaved?: Record<string, string>;
  }
}

interface SpikeLibSpec {
  id: string;
  name: string;
  kind: "symbol" | "footprint";
}

function withSpikeKindLib(
  inner: LibsSource | null,
  log: (msg: string) => void,
  spec: SpikeLibSpec,
): LibsSource {
  const store = new Map<string, string>(); // item name -> body
  // Don't clobber an existing capture map (so symbol + footprint spikes coexist).
  window.__pcbjamSaved ??= Object.create(null) as Record<string, string>;

  const isSpike = (libId: string) => libId === spec.id;

  return {
    async listLibs(kind?: string): Promise<LibInfo[]> {
      // Resilient to a missing backend: the spike must boot standalone (the
      // writable lib is in-memory), so an unreachable inner source just yields
      // no origins rather than failing the whole table.
      let base: LibInfo[] = [];
      try {
        base = inner ? await inner.listLibs(kind) : [];
      } catch (e) {
        log(`[libs] spike: inner listLibs failed, origins omitted: ${String(e)}`);
      }
      // The spike lib is the writable target for its kind (mimics a user lib).
      return [...base, { id: spec.id, name: spec.name, type: "user" }];
    },

    async listItems(libId: string): Promise<LibItemInfo[]> {
      if (isSpike(libId))
        return [...store.keys()].map((name) => ({ kind: spec.kind, name }));
      return inner ? inner.listItems(libId) : [];
    },

    async getItemBody(
      libId: string,
      kind: string,
      name: string,
    ): Promise<string | null> {
      if (isSpike(libId)) return store.get(name) ?? null;
      return inner ? inner.getItemBody(libId, kind, name) : null;
    },

    async saveItemBody(
      libId: string,
      kind: string,
      name: string,
      body: string,
    ): Promise<boolean> {
      if (!isSpike(libId)) {
        return inner?.saveItemBody
          ? inner.saveItemBody(libId, kind, name, body)
          : false;
      }
      store.set(name, body);
      window.__pcbjamSaved![name] = body;
      log(`[libs] spike saved ${spec.kind} "${name}" (${body.length} bytes)`);
      return true;
    },

    async deleteItemBody(libId: string, kind: string, name: string): Promise<boolean> {
      if (!isSpike(libId)) {
        return inner?.deleteItemBody ? inner.deleteItemBody(libId, kind, name) : false;
      }
      return store.delete(name);
    },
  };
}

/** 0004-A symbol write spike (`?libwrite=1`). */
export function withSpikeWritableLib(
  inner: LibsSource | null,
  log: (msg: string) => void,
): LibsSource {
  return withSpikeKindLib(inner, log, {
    id: "spike-user",
    name: "My Symbols (spike)",
    kind: "symbol",
  });
}

/** 0009-S footprint write spike (`?fpwrite=1`). */
export function withSpikeWritableFpLib(
  inner: LibsSource | null,
  log: (msg: string) => void,
): LibsSource {
  return withSpikeKindLib(inner, log, {
    id: "spike-fp-user",
    name: "My Footprints (spike)",
    kind: "footprint",
  });
}
