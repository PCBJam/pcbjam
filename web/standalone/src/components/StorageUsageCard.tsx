import * as React from "react";
import { Database, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@pcbjam/ui";

/**
 * Browser-storage usage for the editor's library caches, by kind, with a
 * "delete 3D model cache" action.
 *
 * All library data lives in r2-idb-sync IndexedDB databases named
 * `sync:<namespace>` (one per lib), each with a `bodies` store keyed
 * `"<kind>/<name>"`. Symbols/footprints are bulk-synced (whole-lib bundles);
 * 3D models are SPARSE — only the models boards actually rendered are stored
 * (namespaces `kicad-models:…`), which makes them the one cache that is both
 * potentially large and always safe to drop: manifests re-sync in one small
 * fetch and bodies lazily re-download exactly when a board needs them again.
 */

const SYNC_PREFIX = "sync:";
const MODELS_NS_PREFIX = `${SYNC_PREFIX}kicad-models:`;

interface KindUsage {
  bytes: number;
  items: number;
}

interface StorageBreakdown {
  symbol: KindUsage;
  footprint: KindUsage;
  model3d: KindUsage;
  /** Whole-origin estimate (all IDB + caches), from navigator.storage. */
  originUsage: number | null;
  originQuota: number | null;
  /** Names of the model DBs (the delete target). */
  modelDbs: string[];
}

function emptyUsage(): KindUsage {
  return { bytes: 0, items: 0 };
}

/** Sum body sizes per kind in one `sync:*` DB via a cursor (no bulk getAll —
 *  a model cache can be hundreds of MB and we only need the sizes). */
function measureDb(name: string, into: StorageBreakdown): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    // Never upgrade here (no version passed); a DB from a newer schema still
    // opens read-only for measuring.
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("bodies")) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction("bodies", "readonly");
      const cursorReq = tx.objectStore("bodies").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return; // tx completes → oncomplete below
        const key = String(cursor.key);
        const value = cursor.value as { byteLength?: number } | undefined;
        const size = value?.byteLength ?? 0;
        const kind = key.startsWith("symbol/")
          ? "symbol"
          : key.startsWith("footprint/")
            ? "footprint"
            : key.startsWith("model3d/")
              ? "model3d"
              : null;
        if (kind) {
          into[kind].bytes += size;
          into[kind].items += 1;
        }
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    };
  });
}

async function measureAll(): Promise<StorageBreakdown> {
  const breakdown: StorageBreakdown = {
    symbol: emptyUsage(),
    footprint: emptyUsage(),
    model3d: emptyUsage(),
    originUsage: null,
    originQuota: null,
    modelDbs: [],
  };
  // indexedDB.databases() is supported everywhere we run (Chromium, FF 126+,
  // Safari 14+); without it we just show the origin estimate.
  const dbs = (await indexedDB.databases?.()) ?? [];
  for (const db of dbs) {
    const name = db.name;
    if (!name || !name.startsWith(SYNC_PREFIX)) continue;
    if (name.startsWith(MODELS_NS_PREFIX)) breakdown.modelDbs.push(name);
    await measureDb(name, breakdown);
  }
  try {
    const est = await navigator.storage?.estimate?.();
    breakdown.originUsage = est?.usage ?? null;
    breakdown.originQuota = est?.quota ?? null;
  } catch {
    // estimate unavailable — the per-kind rows still stand on their own
  }
  return breakdown;
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function StorageUsageCard() {
  const [data, setData] = React.useState<StorageBreakdown | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      setData(await measureAll());
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearModels = React.useCallback(async () => {
    if (!data) return;
    setClearing(true);
    try {
      for (const name of data.modelDbs) await deleteDb(name);
      await refresh();
    } finally {
      setClearing(false);
    }
  }, [data, refresh]);

  const rows = data
    ? ([
        ["Symbols", data.symbol],
        ["Footprints", data.footprint],
        ["3D models", data.model3d],
      ] as const)
    : null;

  return (
    <section className="mb-10 rounded-lg border p-5">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-medium">
        <Database size={16} /> Storage
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Library data cached in this browser. Everything re-downloads on demand —
        clearing is always safe. 3D models are fetched per board, so their cache
        is the one worth reclaiming.
      </p>

      {!data ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" size={14} /> Measuring…
        </p>
      ) : (
        <div className="space-y-2">
          <table className="w-full max-w-md text-sm">
            <tbody>
              {rows!.map(([label, usage]) => (
                <tr key={label} className="border-b last:border-b-0">
                  <td className="py-1.5 text-muted-foreground">{label}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {usage.items.toLocaleString()} items
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums">
                    {formatBytes(usage.bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.originUsage !== null && (
            <p className="text-xs text-muted-foreground">
              Site total (all caches): {formatBytes(data.originUsage)}
              {data.originQuota ? ` of ${formatBytes(data.originQuota)} available` : ""}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void clearModels()}
              disabled={clearing || data.model3d.items === 0}
            >
              {clearing ? (
                <Loader2 className="mr-1 animate-spin" size={14} />
              ) : (
                <Trash2 className="mr-1" size={14} />
              )}
              Delete 3D model cache
              {data.model3d.bytes > 0 ? ` (${formatBytes(data.model3d.bytes)})` : ""}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={busy}
              aria-label="Refresh storage usage"
            >
              <RefreshCw className={busy ? "animate-spin" : ""} size={14} />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
