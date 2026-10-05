/**
 * Tutorials (overlay-system 0005): first-party guided plugins every signed-in account can start
 * without installing anything. Starting one makes a new project from the tutorial's template and
 * installs it for the account (the server's `source: 'tutorial'`), then the editor opens there
 * with `?tutorial=<slug>`, which opens the tutorial's panel.
 */
import * as React from "react";
import { API_BASE_URL } from "@/lib/config";
import { pluginKey, type PluginCatalog, type PluginView } from "./plugin-catalog";

export interface Tutorial {
  slug: string;
  title: string;
  summary: string;
  level: string;
  minutes: number;
  pluginId: string;
  version: string;
}

export interface StartedTutorial {
  scope: string;
  project: string;
  file: string;
  tutorial: string;
  pluginId: string;
}

export const TUTORIAL_LEVEL: Record<string, string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };

async function request<T>(path: string, method = "GET"): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API_BASE_URL}/api/plugin-platform/v1/${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-PCBJam-Plugin-Platform": "1" },
    signal: AbortSignal.timeout(method === "GET" ? 10000 : 30000),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
}

/** The published tutorials; null where tutorials are off (the server answers 404). */
export async function listTutorials(): Promise<Tutorial[] | null> {
  const { status, body } = await request<{ tutorials?: Tutorial[]; error?: string }>("tutorials");
  if (status === 404) return null;
  if (status !== 200 || !Array.isArray(body.tutorials)) throw new Error(body.error ?? "Tutorials unavailable");
  return body.tutorials;
}

/** Make the tutorial's project and install it for this account. */
export async function startTutorial(slug: string): Promise<StartedTutorial> {
  const { status, body } = await request<StartedTutorial & { error?: string }>(`tutorials/${encodeURIComponent(slug)}/start`, "POST");
  if (status !== 201) throw new Error(body.error ?? "The tutorial could not start");
  return body;
}

/** Where the editor opens a started tutorial. */
export function tutorialUrl(started: StartedTutorial): string {
  const file = started.file.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(started.scope)}/projects/${encodeURIComponent(started.project)}/${file}?tutorial=${encodeURIComponent(started.tutorial)}`;
}

/**
 * `?tutorial=<slug>`: the tutorial was just started here — open its panel once the plugin catalog
 * knows it, then drop the parameter (on a reload the remembered panel takes over). `enabled`
 * follows the session's toggles, which arrive after the first render, so the slug is read up
 * front and acted on once it turns true.
 */
export function useTutorialFromUrl(catalog: PluginCatalog, onViewChange: (view: PluginView) => void, enabled: boolean): void {
  const wanted = React.useRef(new URLSearchParams(window.location.search).get("tutorial"));
  React.useEffect(() => {
    const slug = wanted.current;
    if (!enabled || !slug || !catalog.loaded) return;
    wanted.current = null;
    let live = true;
    void listTutorials()
      .then((list) => {
        const tutorial = list?.find((t) => t.slug === slug);
        const plugin = tutorial && catalog.plugins.find((p) => p.pluginId === tutorial.pluginId);
        if (live && plugin) onViewChange({ kind: "plugin", id: pluginKey(plugin) });
      })
      .catch(() => {})
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("tutorial");
        window.history.replaceState(window.history.state, "", url);
      });
    return () => {
      live = false;
    };
  }, [enabled, catalog.loaded, catalog.plugins, onViewChange]);
}
