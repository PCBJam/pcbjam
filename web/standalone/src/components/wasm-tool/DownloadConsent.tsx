// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import * as React from "react";
import { Download } from "lucide-react";
import type { Tool } from "@pcbjam/shared";
import { TOOL_BUNDLE } from "@/wasm/constants";
import { fetchWasmStoredSize, hasAnyWasmDownload, type WasmMeta } from "@/wasm/wasm-assets";
import type { LibsSource, LibsSyncState } from "@/wasm/libs/source";
import { LIB_KIND_FOR_TOOL } from "./ui-helpers";

/** What the download-consent dialog quotes (standalone-load-ux 0001). */
export interface ConsentInfo {
  /** Over-the-wire (COMPRESSED) bytes for the editor bundle — null when the CDN
   *  carries no size info and HEAD yielded none ("large download" wording then).
   *  Quoted as "compressed" in the dialog: the load screen's progress bar counts
   *  RAW decoded bytes, which are several times this. */
  toolBytes: number | null;
  /** Raw (decoded) wasm bytes — the same total the progress bar counts, quoted
   *  next to `toolBytes` so the two figures can't read as a contradiction. Null
   *  when the manifest prices nothing (HEAD fallback knows the wire size only). */
  toolRawBytes: number | null;
  /** A previous version of this bundle was downloaded → word it as an update. */
  update: boolean;
  /** The lib kind this tool pre-syncs — warmed in parallel with the wasm
   *  download (the boot fan-out; see startLibPresync). Editors with a project
   *  file open without waiting on it; the lib editors wait (enumerate gate). */
  libNowKind: "symbol" | "footprint" | null;
  libNow: LibsSyncState | null;
  /** The other kind a merged-bundle session can pull lazily ("only if used"). */
  libLaterKind: "symbol" | "footprint" | null;
  libLater: LibsSyncState | null;
}

/**
 * Gather the consent dialog's figures. Everything is best-effort: only small
 * JSON/HEAD requests run here (never a bundle or the wasm), and any missing
 * piece degrades to vaguer wording rather than blocking the dialog.
 */
export async function gatherConsentInfo(
  meta: WasmMeta,
  source: LibsSource | null,
  tool: Tool,
): Promise<ConsentInfo> {
  let toolBytes = meta.sizes?.totalStored ?? null;
  if (toolBytes === null) {
    toolBytes = await fetchWasmStoredSize(meta.base, meta.bundle);
  }
  const libNowKind = LIB_KIND_FOR_TOOL[tool] ?? null;
  // The merged kicad_editor bundle seeds BOTH lib tables — the other kind loads
  // lazily per-lib when a cross-face feature reaches it (see boot.ts libKinds).
  const libLaterKind =
    TOOL_BUNDLE[tool] === "kicad_editor" && libNowKind
      ? libNowKind === "symbol"
        ? ("footprint" as const)
        : ("symbol" as const)
      : null;
  const state = async (
    kind: "symbol" | "footprint" | null,
  ): Promise<LibsSyncState | null> => {
    if (!kind || !source?.syncState) return null;
    try {
      return await source.syncState(kind);
    } catch {
      return null;
    }
  };
  return {
    toolBytes,
    // Only the manifest prices the DECODED wasm (wasm-assets WasmBundleSizes);
    // the HEAD fallback above sees the compressed body alone.
    toolRawBytes: meta.sizes?.wasm ?? null,
    update: hasAnyWasmDownload(meta.bundle),
    libNowKind,
    libNow: await state(libNowKind),
    libLaterKind,
    libLater: await state(libLaterKind),
  };
}

function approxMB(bytes: number): string {
  const mb = bytes / 1e6;
  return `~${mb >= 10 ? Math.round(mb) : Math.max(0.1, mb).toFixed(1)} MB`;
}

/** "1 library" / "155 libraries". */
function libCount(n: number): string {
  return `${n} librar${n === 1 ? "y" : "ies"}`;
}

/**
 * One consent row's size figure — MB only; the COUNTS live in the row's detail
 * line (libNowDetail/libLaterDetail), because "download" and "check" cover
 * different sets of libs and one number can't stand for both.
 */
function libStateLabel(s: LibsSyncState | null): string | null {
  if (!s || s.total === 0) return null;
  if (s.warm >= s.total) return "already cached";
  // sizesKnown false ⇒ some cold libs carry no published size, so coldBytes is a
  // FLOOR, never the total: say "at least", and quote nothing at all when not a
  // single cold lib was priced.
  if (!s.sizesKnown) {
    return s.coldBytes > 0 ? `at least ${approxMB(s.coldBytes)}` : null;
  }
  return approxMB(s.coldBytes);
}

/**
 * Detail line for the kind this editor PRE-SYNCS at boot. Two different numbers
 * matter here and quoting either alone reads as a lie: only the libs that aren't
 * cached yet download their contents ("1 library"), but the pre-sync walks EVERY
 * library of the kind to see whether it changed — and that walk is what the
 * "Syncing footprint libraries — 99/155" bar counts. A null state (source can't
 * tell) keeps the old count-free wording.
 */
function libNowDetail(s: LibsSyncState | null): string {
  const base = "this editor browses them";
  // No warmth answer at all: say only what stays true regardless of counts —
  // the warm-up runs alongside the editor download and finishes in the
  // background, so "downloaded now" would overpromise as well as vague.
  if (!s || s.total === 0) return `${base} — fetched in the background`;
  const cold = s.total - s.warm;
  if (cold === 0) {
    return `${base} — ${libCount(s.total)} already here, just checked for updates`;
  }
  if (s.warm === 0) return `${base} — downloads ${libCount(s.total)}`;
  return `${base} — downloads ${libCount(cold)}, checks all ${s.total} for updates`;
}

/**
 * Detail line for the OTHER kind of a merged-bundle session: never walked at
 * boot (no pre-sync, no update check) — each lib is fetched lazily the first
 * time a cross-face feature reaches it.
 */
function libLaterDetail(s: LibsSyncState | null): string {
  const base = "downloaded later, only if you use them";
  if (!s || s.total === 0) return base;
  const cold = s.total - s.warm;
  if (cold === 0) return `${libCount(s.total)} already here — nothing to download`;
  return `${base} (${libCount(cold)} not here yet)`;
}

/**
 * The editor bundle's figure. `toolBytes` is the OVER-THE-WIRE (compressed)
 * size, while the load screen's progress bar counts RAW decoded bytes — quoting
 * the first bare is what made "~32 MB" look like a lie next to a ~150 MB bar.
 * Show both whenever the manifest prices them; the HEAD fallback knows only the
 * wire size, so it says just that.
 */
function toolFigure(info: ConsentInfo): React.ReactNode {
  if (info.toolBytes === null) return "large (hundreds of MB)";
  const wire = `${approxMB(info.toolBytes)} compressed`;
  if (info.toolRawBytes === null) return wire;
  return (
    <>
      {wire}
      <br />
      <span className="text-white/50">
        {approxMB(info.toolRawBytes)} uncompressed
      </span>
    </>
  );
}

/**
 * The download-consent card (standalone-load-ux 0001): what's about to be
 * pulled onto this device — the editor bundle now, the tool's lib kind now,
 * the other kind later on demand — and an OK that actually gates the fetches.
 */
export function DownloadConsent({
  info,
  onAccept,
}: {
  info: ConsentInfo;
  onAccept: (always: boolean) => void;
}) {
  const [always, setAlways] = React.useState(false);
  const kindTitle = (k: "symbol" | "footprint") =>
    k === "symbol" ? "Symbol libraries" : "Footprint libraries";
  const row = (
    title: string,
    detail: string,
    figure: React.ReactNode,
    testid: string,
  ) => (
    <li
      data-testid={testid}
      className="flex items-baseline gap-3 border-t border-white/10 py-2 first:border-t-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white/90">{title}</p>
        <p className="text-xs text-white/50">{detail}</p>
      </div>
      {figure && (
        <span className="whitespace-nowrap text-right font-mono text-xs leading-snug text-white/70">
          {figure}
        </span>
      )}
    </li>
  );
  return (
    <div
      data-testid="download-consent"
      className="flex w-full max-w-md flex-col items-center gap-4 px-6"
    >
      <Download size={32} className="text-white/70" />
      <h2 className="text-base font-semibold">
        {info.update ? "Editor update available" : "One-time download needed"}
      </h2>
      <p className="text-center text-sm text-white/70">
        PCBJam runs KiCad fully in your browser.{" "}
        {info.update
          ? "This release ships a new editor build, so it needs downloading again — it's cached after that."
          : "Opening this tool downloads it once — repeat visits load from your browser's cache."}
      </p>
      <ul className="w-full rounded-lg bg-white/5 px-4 py-1">
        {row(
          "Editor engine",
          "the KiCad build, downloaded now",
          toolFigure(info),
          "consent-row-tool",
        )}
        {info.libNowKind &&
          row(
            kindTitle(info.libNowKind),
            libNowDetail(info.libNow),
            libStateLabel(info.libNow),
            "consent-row-now",
          )}
        {info.libLaterKind &&
          row(
            kindTitle(info.libLaterKind),
            libLaterDetail(info.libLater),
            libStateLabel(info.libLater),
            "consent-row-later",
          )}
      </ul>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          className="accent-white/80"
        />
        Always download without asking
      </label>
      <button
        data-testid="consent-accept"
        className="rounded bg-white/90 px-4 py-1.5 text-sm font-medium text-[#1a1a2e] hover:bg-white"
        onClick={() => onAccept(always)}
      >
        Download &amp; open
      </button>
    </div>
  );
}

/**
 * Fixed-width lib pre-sync line, e.g. "Checking symbol libraries —  42/208".
 * "Checking", not "downloading": the walk visits every lib of the kind but
 * downloads only the new/changed ones — a bare counter read as 155 downloads
 * (standalone-load-ux follow-up). The prefix is constant and `done` is
 * space-padded to `total`'s digit count, so the text stays still while the
 * counter ticks (render it in a font-mono + whitespace-pre element so the pad
 * spaces hold their width).
 */
export function libSyncLabel(s: { kind: string; done: number; total: number }): string {
  const total = String(s.total);
  const done = String(Math.min(s.done, s.total)).padStart(total.length, " ");
  return `Checking ${s.kind} libraries — ${done}/${total}`;
}

/**
 * WASM download progress for the boot overlay. A determinate bar when the server
 * sent a Content-Length the decoded stream agrees with; otherwise just MB so far
 * (gzip/br makes Content-Length the COMPRESSED size, so `loaded` can pass it).
 */
export function DownloadProgress({
  progress,
}: {
  progress: { loaded: number; total: number } | null;
}) {
  if (!progress) return null;
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  const determinate = progress.total > 0 && progress.loaded <= progress.total;
  const pct = determinate
    ? Math.round((progress.loaded / progress.total) * 100)
    : 0;
  return (
    <div className="w-64 max-w-[80vw]">
      {determinate ? (
        <>
          <div className="h-1.5 w-full overflow-hidden rounded bg-white/15">
            <div
              className="h-full rounded bg-white/70 transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-center font-mono text-xs text-white/50">
            {mb(progress.loaded)} / {mb(progress.total)} ({pct}%)
          </p>
        </>
      ) : (
        <p className="text-center font-mono text-xs text-white/50">
          {mb(progress.loaded)} downloaded…
        </p>
      )}
    </div>
  );
}

