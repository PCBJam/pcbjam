// repro for R-3 (docs/features/findings/groups/R-fixed-during-demo-record.md)
//
// The CDN worker once stamped EVERY range-less GET as `206 Partial Content`:
// current workerd reports a DEFINED `object.range` (full span) even for a
// range-less `bucket.get()`, and the worker gated 206 on `object.range`.
// Chrome shrugs at a 206 <script>; Firefox fires onload but refuses to
// execute it, so every Firefox boot on staging died ("runtime did not
// initialize (no FS)"). The fix gates 206 on the REQUEST's Range header and
// only passes a range option to `get()` when one was asked for.
//
// The bucket stub below reproduces the workerd behaviour that caused the bug
// (always-defined `range`), so the pre-fix code path yields 206 here.
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

type GetCall = { key: string; options: unknown };

function stubBucket(opts: {
  size?: number;
  contentEncoding?: string;
  missing?: boolean;
  etag?: string;
}) {
  const size = opts.size ?? 1000;
  const etag = opts.etag ?? '"etag-1"';
  const calls: GetCall[] = [];
  const bucket = {
    calls,
    async get(key: string, options: { range?: Headers | { offset?: number; length?: number } } = {}) {
      calls.push({ key, options });
      if (opts.missing) return null;

      // workerd: `range` is DEFINED (full span) even when no range was asked.
      let range: { offset: number; length: number } = { offset: 0, length: size };
      const r = options.range;
      if (r instanceof Headers) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(r.get("Range") ?? "");
        if (m) {
          const offset = Number(m[1]);
          const end = m[2] === "" ? size - 1 : Number(m[2]);
          range = { offset, length: end - offset + 1 };
        }
      } else if (r && typeof r === "object") {
        range = { offset: r.offset ?? 0, length: r.length ?? size - (r.offset ?? 0) };
      }

      return {
        size,
        range,
        httpEtag: etag,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(range.length));
            c.close();
          },
        }),
        writeHttpMetadata(h: Headers) {
          h.set("Content-Type", "text/javascript");
          if (opts.contentEncoding) h.set("Content-Encoding", opts.contentEncoding);
        },
      };
    },
  };
  return bucket;
}

const env = (bucket: ReturnType<typeof stubBucket>) => ({ BUCKET: bucket as never });
const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://cdn.example${path}`, init);

describe("cdn worker — range-less GET is a 200, never a 206 (R-3)", () => {
  it("plain GET → 200 with the full Content-Length and no Content-Range", async () => {
    const bucket = stubBucket({ size: 1234, contentEncoding: "br" });
    const res = await worker.fetch(req("/v1/kicad_editor.js"), env(bucket));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe("1234");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    // Pre-compressed body: the stored encoding must survive to the client.
    expect(res.headers.get("Content-Encoding")).toBe("br");
    expect(res.headers.get("ETag")).toBe('"etag-1"');
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // No range option reaches the bucket for a range-less request.
    expect(bucket.calls).toHaveLength(1);
    expect(bucket.calls[0]!.key).toBe("v1/kicad_editor.js");
    expect(bucket.calls[0]!.options).toEqual({});
  });

  it("GET with a Range header → 206 with the matching Content-Range", async () => {
    const bucket = stubBucket({ size: 1000 });
    const res = await worker.fetch(
      req("/v1/a.wasm", { headers: { Range: "bytes=10-19" } }),
      env(bucket),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 10-19/1000");
    expect(res.headers.get("Content-Length")).toBe("10");
    // The request headers were forwarded as the range option.
    const opt = bucket.calls[0]!.options as { range?: unknown };
    expect(opt.range).toBeInstanceOf(Headers);
  });

  it("HEAD → same headers, no body", async () => {
    const bucket = stubBucket({ size: 77 });
    const res = await worker.fetch(req("/v1/a.js", { method: "HEAD" }), env(bucket));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("77");
    expect(res.body).toBeNull();
  });

  it("If-None-Match hit → 304", async () => {
    const bucket = stubBucket({ etag: '"e2"' });
    const res = await worker.fetch(
      req("/v1/a.js", { headers: { "If-None-Match": '"e2"' } }),
      env(bucket),
    );
    expect(res.status).toBe(304);
  });

  it("missing key → 404; percent-encoded keys are decoded", async () => {
    const bucket = stubBucket({ missing: true });
    const res = await worker.fetch(req("/v1/my%20lib.kicad_sym"), env(bucket));
    expect(res.status).toBe(404);
    expect(bucket.calls[0]!.key).toBe("v1/my lib.kicad_sym");
  });

  it("non-GET methods → 405; OPTIONS → 204 with CORS allowances", async () => {
    const bucket = stubBucket({});
    expect((await worker.fetch(req("/x", { method: "POST" }), env(bucket))).status).toBe(405);
    const opt = await worker.fetch(req("/x", { method: "OPTIONS" }), env(bucket));
    expect(opt.status).toBe(204);
    expect(opt.headers.get("Access-Control-Allow-Headers")).toContain("Range");
  });
});
