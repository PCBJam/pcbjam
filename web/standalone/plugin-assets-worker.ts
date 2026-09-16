// Static runtime assets must never fall through to the editor's SPA index.
// This handler only sees /plugin-runtime/*; normal editor requests remain static.
import runtime from "./src/generated/plugin-runtime.json";
const CSP =
  "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";
export default {
  async fetch(
    request: Request,
    env: { ASSETS: { fetch(request: Request): Promise<Response> } }
  ) {
    const url = new URL(request.url),
      prefix = `/plugin-runtime/${runtime.version}/`;
    const name = url.pathname.slice(prefix.length);
    const headers = {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    };
    if (
      !["GET", "HEAD"].includes(request.method) ||
      url.search ||
      !url.pathname.startsWith(prefix) ||
      !runtime.files.concat("manifest.json").includes(name)
    )
      return new Response("Runtime asset unavailable", {
        status: 404,
        headers: { ...headers, "Cache-Control": "no-store" },
      });
    const result = await env.ASSETS.fetch(request);
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
