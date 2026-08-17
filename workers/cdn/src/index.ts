interface Env {
  BUCKET: R2Bucket;
}

const baseHeaders = (): Headers => {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      const headers = baseHeaders();
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Range, If-None-Match");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: baseHeaders(),
      });
    }

    const url = new URL(request.url);
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return new Response("Bad Request", { status: 400, headers: baseHeaders() });
    }
    if (!key) {
      return Response.json(
        { ok: true, service: "pcbjam-cdn-staging" },
        { headers: baseHeaders() },
      );
    }

    // 206 must be gated on the REQUEST asking for a range, not on
    // `object.range`: current workerd reports a DEFINED object.range (full
    // span) even for a range-less get() — with OR without range options — so
    // every plain GET went out as 206 + Content-Range. Chrome shrugs at a 206
    // <script>; Firefox fires onload but refuses to EXECUTE it, so on hosts
    // with no masking edge cache (staging's workers.dev) the editor glue never
    // ran — "runtime did not initialize (no FS) in 90s" on every Firefox boot.
    const rangeRequested = request.headers.has("Range");
    const object = await env.BUCKET.get(
      key,
      rangeRequested ? { range: request.headers } : {},
    );
    if (!object) {
      return new Response("Not Found", { status: 404, headers: baseHeaders() });
    }

    const headers = baseHeaders();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");

    if (request.headers.get("If-None-Match") === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    let status = 200;
    if (rangeRequested && object.range) {
      const suffix = "suffix" in object.range ? object.range.suffix : undefined;
      const length = suffix
        ? Math.min(suffix, object.size)
        : "length" in object.range && object.range.length !== undefined
          ? object.range.length
          : object.size - ("offset" in object.range ? (object.range.offset ?? 0) : 0);
      const offset = suffix
        ? object.size - length
        : "offset" in object.range
          ? (object.range.offset ?? 0)
          : 0;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
      status = 206;
    } else {
      headers.set("Content-Length", String(object.size));
    }

    // The bucket stores artifacts PRE-COMPRESSED (publish-wasm --compress br,
    // Content-Encoding in the object metadata). `encodeBody: "manual"` tells
    // the runtime the body already matches the Content-Encoding header, so it
    // passes both through untouched. The default "automatic" mode DROPS a
    // user-set Content-Encoding and re-negotiates against the client's
    // Accept-Encoding — behind prod's custom-domain edge that happened to
    // round-trip, but on workers.dev it served the raw brotli bytes with NO
    // encoding header: binary garbage where the browser expected JS/wasm.
    // Firefox executed the garbage <script> to nothing (silently — onload
    // still fires), leaving the editor glue inert: the second half of the
    // "runtime did not initialize (no FS)" staging boot failure.
    return new Response(request.method === "HEAD" ? null : object.body, {
      status,
      headers,
      encodeBody: "manual",
    });
  },
};
