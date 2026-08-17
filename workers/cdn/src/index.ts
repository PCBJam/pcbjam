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

    // Only ask R2 for a range when the request actually sent one: passing the
    // headers unconditionally makes R2 report a DEFINED object.range (full
    // span) even for range-less GETs, which stamped EVERY response 206 +
    // Content-Range. Chrome shrugs at a 206 <script>; Firefox fires onload but
    // refuses to EXECUTE it, so on hosts with no masking edge cache (staging's
    // workers.dev) the editor glue never ran — "runtime did not initialize
    // (no FS) in 90s" on every Firefox boot.
    const object = await env.BUCKET.get(
      key,
      request.headers.has("Range") ? { range: request.headers } : {},
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
    if (object.range) {
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

    return new Response(request.method === "HEAD" ? null : object.body, {
      status,
      headers,
    });
  },
};
