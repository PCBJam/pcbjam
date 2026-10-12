// Static runtime assets must never fall through to the editor's SPA index.
// This handler only sees /plugin-runtime/*; normal editor requests remain static.
import runtime from "./src/generated/plugin-runtime.json";
import { sitesFromSegment, workerCsp } from "@pcbjam/plugin-platform/network-contract.mjs";
export default {
  async fetch(
    request: Request,
    env: { ASSETS: { fetch(request: Request): Promise<Response> } }
  ) {
    const url = new URL(request.url),
      prefix = `/plugin-runtime/${runtime.version}/`;
    // A plugin that may call sites directly (plugins 0022 M3) runs the same Worker script from
    // net/<sites>/package-worker.js, with connect-src limited to exactly those sites. Only the
    // editor's own code creates Workers, so a plugin cannot choose the list.
    const net = /^net\/([^/]+)\/package-worker\.js$/.exec(url.pathname.slice(prefix.length));
    const sites = net ? sitesFromSegment(net[1]) : [];
    const name = net ? "package-worker.js" : url.pathname.slice(prefix.length);
    const headers = {
      "Content-Security-Policy": workerCsp(sites ?? []),
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    };
    if (
      !["GET", "HEAD"].includes(request.method) ||
      url.search ||
      !url.pathname.startsWith(prefix) ||
      !sites ||
      !runtime.files.concat("manifest.json").includes(name)
    )
      return new Response("Runtime asset unavailable", {
        status: 404,
        headers: { ...headers, "Cache-Control": "no-store" },
      });
    const result = await env.ASSETS.fetch(
      net ? new Request(new URL(prefix + name, url), request) : request
    );
    if (!result.ok || result.headers.get("content-type")?.includes("text/html"))
      return new Response("Runtime asset unavailable", {
        status: 404,
        headers: { ...headers, "Cache-Control": "no-store" },
      });
    const response = new Response(result.body, result);
    for (const [key, value] of Object.entries(headers))
      response.headers.set(key, value);
    response.headers.set(
      "Cache-Control",
      "public, max-age=31536000, immutable"
    );
    return response;
  },
};
