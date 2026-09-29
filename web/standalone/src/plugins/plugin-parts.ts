/**
 * `parts.save` for QuickJS plugins (overlay-system 0003 phase 4): a part the
 * plugin ships goes into the plugin's OWN team library (`plugin_<id>`, chosen
 * here, never by the plugin), through the same validated path as a remote
 * provider's part (`savePartAndPlace`), after the user confirms.
 *
 * The call answers as soon as the part is stored. With `place`, the symbol
 * then follows the cursor until the user clicks — possibly longer than a
 * plugin command may run — so placement is not awaited; its failures reach
 * the user through `onPlacementIssue`.
 */
import { pluginLibName, SavePartError, type PartPack, type SavePartOptions, type SavePartResult } from "@/libs/save-part";

export interface PluginPartRequest {
  displayName: string;
  symbol?: { name: string; text: string };
  footprint?: { name: string; text: string };
  place: boolean;
}

export interface PluginPartSummary {
  displayName: string;
  library: string;
  symbol?: string;
  footprint?: string;
  bytes: number;
  place: boolean;
}

export type PluginPartResult =
  | { status: "saved"; library: string; symbolLibId?: string; footprintLibId?: string }
  | { status: "cancelled" };

export function pluginPartSaver(opts: {
  pluginId: string;
  /** The trusted confirmation (true = save). */
  confirm(summary: PluginPartSummary, signal: AbortSignal): Promise<boolean>;
  /** Authorize `parts.save` right before the effect (hosted platform). */
  authorize(): Promise<void>;
  save(pack: PartPack, options: SavePartOptions): Promise<SavePartResult>;
  onPlacementIssue?(message: string): void;
}) {
  const library = pluginLibName(opts.pluginId);
  const encoder = new TextEncoder();

  return async (request: PluginPartRequest, signal: AbortSignal): Promise<PluginPartResult> => {
    const symbol = request.symbol && { name: request.symbol.name, bytes: encoder.encode(request.symbol.text) };
    const footprint = request.footprint && { name: request.footprint.name, bytes: encoder.encode(request.footprint.text) };
    const summary: PluginPartSummary = {
      displayName: request.displayName,
      library,
      symbol: symbol?.name,
      footprint: footprint?.name,
      bytes: (symbol?.bytes.byteLength ?? 0) + (footprint?.bytes.byteLength ?? 0),
      place: request.place,
    };
    if (!(await opts.confirm(summary, signal))) return { status: "cancelled" };
    signal.throwIfAborted();
    await opts.authorize();

    const pack: PartPack = {
      providerOrigin: "",
      providerId: opts.pluginId,
      libraryName: library,
      partId: request.displayName,
      displayName: request.displayName,
      ...(symbol ? { symbol } : {}),
      ...(footprint ? { footprint } : {}),
    };

    let savedResult: SavePartResult | null = null;
    let resolveSaved!: (r: SavePartResult) => void;
    const stored = new Promise<SavePartResult>((resolve) => (resolveSaved = resolve));
    const run = opts.save(pack, {
      place: request.place,
      signal,
      onSaved: (r) => {
        savedResult = r;
        resolveSaved(r);
      },
    });
    // Before the part is stored every failure is the plugin's to hear; after it, only
    // placement can fail, and that is the user's business.
    void run.catch((error: unknown) => {
      if (savedResult) opts.onPlacementIssue?.(error instanceof Error ? error.message : "Placement failed");
    });
    let result: SavePartResult;
    try {
      result = await Promise.race([stored, run]);
    } catch (error) {
      if (error instanceof SavePartError) throw new Error(`${error.code}: ${error.message}`);
      throw error;
    }
    return {
      status: "saved",
      library: result.libNickname,
      ...(result.symbolLibId ? { symbolLibId: result.symbolLibId } : {}),
      ...(result.footprintLibId ? { footprintLibId: result.footprintLibId } : {}),
    };
  };
}
