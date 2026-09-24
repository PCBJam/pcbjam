import * as React from "react";
import type { createDocumentAPI } from "./document-api";
import { API_BASE_URL } from "@/lib/config";

export interface Descriptor {
  pluginId?: string;
  generation?: number;
  storageEpoch?: number;
  policyDigest?: string;
  grants?: string[];
  installed?: boolean;
  enabled?: boolean;
  /** Installed from the marketplace (published by PCBJam) or a private upload. */
  source?: 'marketplace' | 'upload';
  fileMetadata?: Record<string, { sha256: string; bytes: number }>;
  backends?: Array<{endpoint:string;origin:string;paths?:string[];methods?:('GET'|'POST')[];auth?:'none'|'pcbjam-user';kind?:'remote-provider';registrationId?:string;policyDigest:string;status:string;ready:boolean;audience?:string;issuer?:string}>;
  /** Snapshot of a remote provider's /.well-known document (kind: "remote-provider" only). */
  providerMetadata?: { providerName: string; providerVersion: string; panelUrl: string; originSet: string[]; maxDownloadBytes: number; supportedAssetTypes: string[]; authType: string };
  digest: string;
  manifest: {
    kind?: 'plugin' | 'remote-provider';
    id: string;
    name: string;
    version: string;
    description: string;
    surfaces: string[];
    permissions: string[];
    uiSize?: { width: number; height: number };
    endpoints?: Record<string,{origin:string;paths:string[];methods:('GET'|'POST')[];auth:'none'|'pcbjam-user'}>;
    provider?: { origin: string };
  };
}
export interface PackageHost {
  configurePlatform(config: { apiBase: string; runtimeVersion: string }): void;
  setPluginEnabled(plugin: Descriptor, enabled: boolean): Promise<Descriptor>;
  resetPluginData(id: string): Promise<void>;
  cleanupPluginStorage(
    apiBase: string,
    userId: string,
    plugins: Descriptor[]
  ): Promise<void>;
  listPlugins(): Promise<{
    plugins: Descriptor[];
    permissions: Record<string, string>;
    userId?: string;
    runtimeVersion?: string;
    /** Account may upload private plugins (hosted platform only). */
    developer?: boolean;
  }>;
  preparePlugin(files: File[], zip: boolean): Promise<Descriptor>;
  installPlugin(plugin: Descriptor | string): Promise<Descriptor>;
  removePlugin(id: string): Promise<void>;
  mountPackagePlugin(
    container: HTMLElement,
    options: {
      plugin: Descriptor;
      signal: AbortSignal;
      context(): {
        tool: string;
        fileName: string;
        readOnly: boolean;
        canPlaceItems: boolean;
        canSelectItems?: boolean;
        canReadGeometry?: boolean;
      };
      chooseFile(
        extensions: string[],
        signal: AbortSignal
      ): Promise<File | null>;
      requestPlacement(
        proposal: { label: string; sexpr: string },
        signal: AbortSignal
      ): Promise<{ status: string }>;
      onDisconnected(message: string): void;
      documents?: ReturnType<typeof createDocumentAPI>;
      storageBinding?(): string | null;
      authorize?(signal: AbortSignal): Promise<void>;
      onAuthorizationReady?(check: (method: string) => Promise<void>): void;
      selectItems?(ids: string[], signal: AbortSignal): Promise<{ selected: string[]; held: string[]; missing: string[] }>;
      saveFile?(
        proposal: { name: string; text?: string; kind: "text" | "html" | "image"; bytes: Uint8Array; method: string },
        signal: AbortSignal
      ): Promise<{ status: "download-requested" | "cancelled" }>;
    }
  ): Promise<{ dispose(): void }>;
}

export const BUILTIN = "__board-inspector";
export type PluginView =
  | { kind: "manager" }
  | { kind: "plugin"; id: string }
  | null;
export const hostedPlugins = import.meta.env.VITE_PLUGIN_PLATFORM === "1";
export const packageHost = async (): Promise<PackageHost> => {
  const url =
    (import.meta.env.VITE_PLUGIN_RUNTIME_BASE ?? "/plugin-runtime/") +
    "package-host.js";
  const host: PackageHost = await import(/* @vite-ignore */ url);
  if (hostedPlugins)
    host.configurePlatform({
      apiBase: API_BASE_URL,
      runtimeVersion: import.meta.env.VITE_PLUGIN_RUNTIME_BASE!.split("/")[2]!,
    });
  return host;
};

export function usePluginCatalog(enabled: boolean) {
  const [plugins, setPlugins] = React.useState<Descriptor[]>([]);
  const [permissions, setPermissions] = React.useState<Record<string, string>>(
    {}
  );
  const [error, setError] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  // Local development always uploads; hosted accounts need developer access.
  const [developer, setDeveloper] = React.useState(!hostedPlugins);
  const generation = React.useRef(0);
  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const host = await packageHost();
      const result = await host.listPlugins();
      if (hostedPlugins && result.userId)
        await host.cleanupPluginStorage(
          API_BASE_URL,
          result.userId,
          result.plugins
        );
      if (current !== generation.current) return;
      setPlugins(result.plugins.filter((p) => p.installed !== false));
      setPermissions(result.permissions);
      setDeveloper(!hostedPlugins || result.developer === true);
      setError("");
    } catch {
      if (current === generation.current) {
        // An old account's catalog must not survive a failed fresh identity check.
        setPlugins([]);
        setPermissions({});
        setDeveloper(!hostedPlugins);
        setError(
          hostedPlugins
            ? "Plugins unavailable. Sign in to PCBJam and try again."
            : "Plugin list unavailable. Check the plugin development server and try again."
        );
      }
    } finally {
      if (current === generation.current) setLoaded(true);
    }
  }, [enabled]);
  React.useEffect(() => {
    if (!enabled) return;
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      generation.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, refresh]);
  return { plugins, permissions, developer, error, loaded, refresh };
}
export type PluginCatalog = ReturnType<typeof usePluginCatalog>;
/**
 * Identity of an installed plugin in the editor. The server's plugin id, since
 * one account may have a private upload and a marketplace plugin with the same
 * manifest id; local development packages only have the manifest id.
 */
export const pluginKey = (plugin: Descriptor) => plugin.pluginId ?? plugin.manifest.id;
