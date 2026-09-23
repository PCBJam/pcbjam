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
      setError("");
    } catch {
      if (current === generation.current) {
        // An old account's catalog must not survive a failed fresh identity check.
        setPlugins([]);
        setPermissions({});
        setError(
          hostedPlugins
            ? "Plugins unavailable. Sign in with an account enabled for the plugin preview."
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
  return { plugins, permissions, error, loaded, refresh };
}
export type PluginCatalog = ReturnType<typeof usePluginCatalog>;
