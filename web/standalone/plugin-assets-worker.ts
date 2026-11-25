// Static runtime assets must never fall through to the editor's SPA index.
// This handler only sees /plugin-runtime/* and /remote-provider-callback/*; normal editor
// requests remain static.
import runtime from "./src/generated/plugin-runtime.json";
import { sitesFromSegment, workerCsp } from "@pcbjam/plugin-platform/network-contract.mjs";
import { ISSUER_HOST, LOGIN_CALLBACK_MARKER, LOGIN_CALLBACK_PREFIX } from "./src/remote-provider/login";

type Assets = { fetch(request: Request): Promise<Response> };

// Where a remote provider's sign-in server sends the sign-in window back (plugins 0028 §6.7):
// /remote-provider-callback/<sign-in server host>. The address has no file of its own, and
// both deployments answer a missing file with the editor's index.html, so this branch serves
// the built page itself and never lets a redirect or the editor through: the path, which
// names the sign-in server, would be lost.
const CALLBACK_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const callbackFailure = (status: number) =>
  new Response(
    '<!doctype html><meta charset="utf-8"><title>Sign-in - PCBJam</title><p>Sign-in failed. Close this window and try again.</p>',
    { status, headers: { ...CALLBACK_HEADERS, "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } }
  );
const sha256 = async (text: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
async function callbackPage(request: Request, url: URL, assets: Assets) {
  if (!["GET", "HEAD"].includes(request.method) || !ISSUER_HOST.test(url.pathname.slice(LOGIN_CALLBACK_PREFIX.length)))
    return callbackFailure(404);
  // A clean GET for the page's own address: no query (it carries the code), no conditional
  // headers, nothing else of the caller's. The name without ".html" is the one that is
  // answered with the file; the ".html" name is answered with a redirect to it.
  const result = await assets.fetch(new Request(new URL(LOGIN_CALLBACK_PREFIX.slice(0, -1), url), { redirect: "manual" }));
  const page = result.status === 200 && result.headers.get("content-type")?.includes("text/html") ? await result.text() : "";
  // The page has one inline script and one inline style; the policy allows exactly these two.
  const script = /<script>([\s\S]*?)<\/script>/.exec(page), style = /<style>([\s\S]*?)<\/style>/.exec(page);
  if (!page.includes(LOGIN_CALLBACK_MARKER) || !script || !style) return callbackFailure(503);
  return new Response(request.method === "HEAD" ? null : page, {
    headers: {
      ...CALLBACK_HEADERS,
      "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${await sha256(script[1]!)}'; style-src 'sha256-${await sha256(style[1]!)}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: { ASSETS: Assets }
  ) {
    const url = new URL(request.url),
      prefix = `/plugin-runtime/${runtime.version}/`;
    if (url.pathname.startsWith(LOGIN_CALLBACK_PREFIX)) return callbackPage(request, url, env.ASSETS);
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
