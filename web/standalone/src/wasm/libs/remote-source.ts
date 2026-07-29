import {
  contract,
  PROJECT_HEADER,
  SCOPE_HEADER,
  USER_HEADER,
} from "@pcbjam/shared";
import { initClient } from "@ts-rest/core";
import type { LibInfo, LibItemInfo, LibsSource } from "./source";

/**
 * A `LibsSource` backed by a contract-conforming backend (the closed registry
 * server, or the GPL example backend). Read list ops go through the ts-rest
 * client; item bodies stream from the raw text route
 * `GET /api/scopes/:scope/libs/:lib/items/:kind/:name`, and writes hit the
 * symmetric `PUT` route. The `scope` is a path param; `user` (thin per-user) and
 * `project` (project-scoped resolution) ride USER_HEADER/PROJECT_HEADER.
 */
export function remoteLibsSource(
  apiBase: string,
  scope: string,
  user?: string,
  project?: string,
): LibsSource {
  const reqHeaders: Record<string, string> = {
    [SCOPE_HEADER]: scope,
    ...(user ? { [USER_HEADER]: user } : {}),
    ...(project ? { [PROJECT_HEADER]: project } : {}),
  };
  const client = initClient(contract, {
    baseUrl: apiBase,
    baseHeaders: reqHeaders,
    // Session-cookie auth (backends with real auth ignore the thin headers).
    credentials: "include",
  });
  const enc = encodeURIComponent;

  const itemUrl = (libId: string, kind: string, name: string) =>
    `${apiBase}/api/scopes/${enc(scope)}/libs/${enc(libId)}/items/` +
    `${enc(kind)}/${enc(name)}`;

  return {
    async listLibs(kind?: string): Promise<LibInfo[]> {
      const res = await client.listLibs({ params: { scope }, query: { kind } });
      if (res.status !== 200) return [];
      return res.body.map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description ?? null,
        type: l.type,
        itemCount: l.itemCount,
        // Cache identity + cold-download bytes (standalone-load-ux 0002) —
        // absent on backends predating the field.
        sync: l.sync ?? null,
      }));
    },

    async listItems(libId: string): Promise<LibItemInfo[]> {
      const res = await client.listLibItems({ params: { scope, lib: libId } });
      if (res.status !== 200) return [];
      return res.body.map((i) => ({ kind: i.kind, name: i.name }));
    },

    async getItemBody(
      libId: string,
      kind: string,
      name: string,
    ): Promise<string | null> {
      const res = await fetch(itemUrl(libId, kind, name), {
        headers: reqHeaders,
        credentials: "include",
      });
      if (!res.ok) return null;
      return await res.text();
    },

    async saveItemBody(
      libId: string,
      kind: string,
      name: string,
      body: string,
    ): Promise<boolean> {
      const res = await fetch(itemUrl(libId, kind, name), {
        method: "PUT",
        headers: { ...reqHeaders, "Content-Type": "text/plain; charset=utf-8" },
        body,
        credentials: "include",
      });
      return res.ok;
    },

    async createLib(name: string): Promise<LibInfo | null> {
      const res = await client.createLib({ params: { scope }, body: { name } });
      if (res.status !== 201) return null;
      return {
        id: res.body.id,
        name: res.body.name,
        description: res.body.description ?? null,
        type: res.body.type,
        sync: res.body.sync ?? null,
      };
    },
  };
}
