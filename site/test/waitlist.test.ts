import { describe, expect, it, vi } from "vitest";

/**
 * Waitlist Function hardening: per-key rate limiting, and no raw address in logs
 * on the no-key path.
 *
 * The endpoint is a Cloudflare Pages Function, so its config arrives as an `env`
 * object on the request context — no `astro:env/server` stub needed any more.
 * Only the Resend SDK is mocked. RESEND_API_KEY is left undefined so the no-key
 * branch (the one that logs) is exercised.
 */
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({}) };
    contacts = { create: async () => ({}) };
  },
}));

const { onRequestPost } = await import("../functions/api/waitlist.ts");

/**
 * WAITLIST_ALLOWED_ORIGINS must be present (as "") rather than omitted: the
 * Function falls back to its default allowlist when the key is absent, and these
 * tests should not depend on that default.
 */
const env = {
  RESEND_API_KEY: undefined,
  RESEND_SEGMENT_ID: undefined,
  WAITLIST_FROM_EMAIL: "hello@pcbjam.com",
  WAITLIST_ALLOWED_ORIGINS: "",
};

function post(email: string, ip: string): Promise<Response> {
  const request = new Request("https://www.pcbjam.com/api/waitlist", {
    method: "POST",
    // cf-connecting-ip, not x-forwarded-for: the Function prefers the Cloudflare
    // header. Using the wrong one here would silently key every request on
    // "unknown", collapsing both tests into one rate-limit bucket while the
    // assertions below still passed.
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ email }),
  });
  // Pages passes a full EventContext; the handler only reads `request` and `env`.
  return onRequestPost({ request, env } as unknown as Parameters<
    typeof onRequestPost
  >[0]) as Promise<Response>;
}

describe("waitlist function hardening", () => {
  it("rate-limits a burst from one IP (429 after the per-IP cap)", async () => {
    const ip = "203.0.113.9";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post(`u${i}@ex.com`, ip)).status);
    expect(statuses.filter((s) => s === 200).length).toBe(5); // RATE_MAX_PER_IP
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("does not write the raw email to logs in the no-key path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post("secret.person@example.com", "198.51.100.7");
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("secret.person@example.com"); // raw address masked
    expect(logged).toContain("@example.com"); // domain kept for debugging
    warn.mockRestore();
  });

  it("refuses a cross-site form POST (the guard Vercel's edge used to provide)", async () => {
    // A cross-site <form> submit needs no CORS permission to be SENT, so the
    // allowlist cannot stop it. Vercel's edge returned 403 for this; Cloudflare
    // Pages does not, so the Function has to.
    const request = new Request("https://www.pcbjam.com/api/waitlist", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "198.51.100.9",
        origin: "https://evil.example",
      },
      body: "email=victim%40example.com",
    });
    const res = (await onRequestPost({ request, env } as unknown as Parameters<
      typeof onRequestPost
    >[0])) as Response;
    expect(res.status).toBe(403);
  });

  it("allows a same-origin form POST (the no-JS path must keep working)", async () => {
    const request = new Request("https://www.pcbjam.com/api/waitlist", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "198.51.100.10",
        origin: "https://www.pcbjam.com",
      },
      body: "email=nojs%40example.com",
    });
    const res = (await onRequestPost({ request, env } as unknown as Parameters<
      typeof onRequestPost
    >[0])) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?waitlist=ok#waitlist");
  });

  it("sends no CORS headers for an origin outside the allowlist", async () => {
    const request = new Request("https://www.pcbjam.com/api/waitlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.8",
        origin: "https://not-allowed.example",
      },
      body: JSON.stringify({ email: "cors@example.com" }),
    });
    const res = (await onRequestPost({ request, env } as unknown as Parameters<
      typeof onRequestPost
    >[0])) as Response;
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
