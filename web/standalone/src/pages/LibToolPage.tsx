import { useParams, useSearchParams } from "react-router-dom";
import { parseToolParam } from "@pcbjam/shared";
import { libsSourceForLib } from "@/lib/config";
import { WasmTool } from "@/components/WasmTool";
import { PreflightGate } from "@/preflight/PreflightGate";

/**
 * Open one library scoped to itself in its editor, addressed by URL:
 *   /:scope/libs/<name>            (symbol_editor — the default)
 *   /:scope/libs/<name>?tool=footprint_editor
 *
 * The lib's editor is chosen by `?tool=` (the home page appends it from the lib's
 * kind); absent ⇒ the symbol editor. `<name>` is the lib's opaque token (its CDN
 * name or backend id). Deep-linkable + reload-safe. The editor boots with no
 * project/files and a `scopedLibsSource` showing exactly this one library.
 */
export function LibToolPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const libId = params.name ?? "";
  const tool = parseToolParam(search.get("tool")) ?? "symbol_editor";

  const libsSource = libsSourceForLib(libId, "local");

  return (
    <PreflightGate>
      <WasmTool
        tool={tool}
        slug="local"
        scopeId="local"
        projectId="local"
        files={[]}
        libsSource={libsSource}
        libScoped
        fetchBytes={async (relPath) => {
          throw new Error(`no project file to fetch: ${relPath}`);
        }}
      />
    </PreflightGate>
  );
}
