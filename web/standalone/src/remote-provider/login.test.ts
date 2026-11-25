import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { LOGIN_CALLBACK_MARKER, LOGIN_CHANNEL_PREFIX, LOGIN_CALLBACK_PREFIX, authorizationUrl, judgeCallback, makePkcePair, randomToken, readCallback } from "./login";

const ISSUER = "https://auth.acme-parts.example";
const STATE = "s".repeat(43);
const PATH = LOGIN_CALLBACK_PREFIX + "auth.acme-parts.example";
const good = { as: "auth.acme-parts.example", state: STATE, code: ["abc"], error: [], iss: [ISSUER] };
const pending = { state: STATE, issuer: ISSUER };

describe("callback page: what it reads from its address", () => {
  it("copies the path segment and every value, as lists", () => {
    expect(readCallback(PATH, `?code=abc&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`)).toEqual(good);
    expect(readCallback(PATH, `?error=access_denied&error_description=x&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`))
      .toEqual({ ...good, code: [], error: ["access_denied"] });
    // Doubled and missing values travel as they are: the host judges them.
    expect(readCallback(PATH, `?code=a&code=b&state=${STATE}`)).toEqual({ ...good, code: ["a", "b"], iss: [] });
    // A local test server's host carries a port.
    expect(readCallback(LOGIN_CALLBACK_PREFIX + "127.0.0.1:4455", `?code=a&state=${STATE}`)?.as).toBe("127.0.0.1:4455");
  });
  it("posts nothing without exactly one well-formed state, or on another path", () => {
    for (const search of ["", "?code=abc", `?state=${STATE}&state=${STATE}`, "?state=short", `?state=${STATE}x`, `?state=${"s".repeat(42)}%2B`])
      expect(readCallback(PATH, search), search).toBeNull();
    for (const path of ["/", "/remote-provider-callback", LOGIN_CALLBACK_PREFIX, PATH + "/", PATH + "/x", LOGIN_CALLBACK_PREFIX + "Auth.Example", LOGIN_CALLBACK_PREFIX + "a%2Fb", LOGIN_CALLBACK_PREFIX + "host:port"])
      expect(readCallback(path, `?code=abc&state=${STATE}`), path).toBeNull();
  });
});

describe("host: accepting a callback", () => {
  it("takes one code from the pinned sign-in server", () => {
    expect(judgeCallback(good, pending)).toEqual({ kind: "code", code: "abc" });
  });
  it("ignores what is not this attempt's answer, so the attempt goes on", () => {
    for (const message of [null, "x", 1, {}, { ...good, state: "t".repeat(43) }, { ...good, as: "auth.other.example" }, { ...good, as: undefined }])
      expect(judgeCallback(message, pending)).toEqual({ kind: "ignore" });
  });
  it("fails on a missing, doubled or different iss, compared as text", () => {
    for (const iss of [[], [ISSUER, ISSUER], ["https://auth.other.example"], [ISSUER + "/"], [ISSUER + "/tenant"], [ISSUER.toUpperCase()], ["https://AUTH.acme-parts.example"], [encodeURIComponent(ISSUER)], [" " + ISSUER], "nope", [1]])
      expect(judgeCallback({ ...good, iss }, pending), JSON.stringify(iss)).toEqual({ kind: "failed" });
    // Also for an error answer: an error from another server is not shown as this one's.
    expect(judgeCallback({ ...good, code: [], error: ["access_denied"], iss: [] }, pending)).toEqual({ kind: "failed" });
  });
  it("fails unless there is exactly one code or exactly one error", () => {
    for (const patch of [
      { code: [] }, { code: ["a", "b"] }, { code: [""] }, { code: ["abc"], error: ["access_denied"] }, { code: [], error: ["a", "b"] }, { code: [], error: [""] },
      { code: ["line\nbreak"] }, { code: ["a".repeat(2049)] }, { code: "abc" }, { error: undefined },
    ])
      expect(judgeCallback({ ...good, ...patch }, pending), JSON.stringify(patch).slice(0, 50)).toEqual({ kind: "failed" });
  });
  it("turns an error into one of two fixed texts, never the server's own words", () => {
    expect(judgeCallback({ ...good, code: [], error: ["access_denied"] }, pending)).toEqual({ kind: "error", text: "Sign-in was cancelled" });
    for (const error of ["server_error", "invalid_scope", "<b>Call 555-0100 to unlock your account</b>"])
      expect(judgeCallback({ ...good, code: [], error: [error] }, pending)).toEqual({ kind: "error", text: "The provider refused the sign-in" });
  });
});

describe("the sign-in window's address", () => {
  const auth = { type: "oauth2" as const, issuer: ISSUER, clientId: "kicad remote&symbols", scopes: ["parts.read", "profile"], authorizationEndpoint: ISSUER + "/authorize", redirectUri: "https://editor.example" + PATH };
  it("is the code flow with PKCE S256, from the activation's values", () => {
    const url = new URL(authorizationUrl(auth, STATE, "challenge"));
    expect(url.origin + url.pathname).toBe(ISSUER + "/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", client_id: "kicad remote&symbols", redirect_uri: auth.redirectUri, scope: "parts.read profile",
      state: STATE, code_challenge_method: "S256", code_challenge: "challenge",
    });
    expect(new URL(authorizationUrl({ ...auth, scopes: [] }, STATE, "c")).searchParams.has("scope")).toBe(false);
  });
  it("uses a fresh verifier and its SHA-256 challenge each time", async () => {
    const a = await makePkcePair(), b = await makePkcePair();
    for (const text of [a.verifier, a.challenge, randomToken()]) expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier).not.toBe(b.verifier);
  });
});

// The callback page is one inline script without a bundle, so it cannot import `readCallback`.
// It is run here on the same addresses and must post exactly what `readCallback` returns.
describe("the callback page itself (remote-provider-callback.html)", () => {
  const page = readFileSync(path.resolve(__dirname, "../../remote-provider-callback.html"), "utf8");
  const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  const open = (pathname: string, search: string) => {
    const seen = { posted: [] as { channel: string; message: unknown }[], closedChannels: 0, windowClosed: false, address: pathname + search, text: "" };
    const message = { textContent: "" };
    vm.runInNewContext(scripts[0]![1]!, {
      URLSearchParams,
      location: { pathname, search },
      history: { replaceState: (_state: unknown, _title: string, url: string) => { seen.address = url; } },
      document: { getElementById: (id: string) => (id === "message" ? message : null) },
      BroadcastChannel: class {
        constructor(private name: string) {}
        postMessage(m: unknown) { seen.posted.push({ channel: this.name, message: JSON.parse(JSON.stringify(m)) }); }
        close() { seen.closedChannels++; }
      },
      window: { close: () => { seen.windowClosed = true; } },
    });
    seen.text = message.textContent;
    return seen;
  };
  it("is the page the editor's Worker looks for: the marker, one inline script, nothing loaded", () => {
    expect(page).toContain(LOGIN_CALLBACK_MARKER);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![0]).toMatch(/^<script>/);
    expect(page.match(/<style>/g)).toHaveLength(1);
    expect(page).not.toMatch(/\bsrc=|\bhref=|<link\b|<img\b|<iframe\b/);
  });
  it("posts what readCallback reads, on the channel named by state, takes the query out of the address and closes", () => {
    for (const [pathname, search] of [
      [PATH, `?code=abc&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`],
      [PATH, `?error=access_denied&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`],
      [PATH, `?code=a&code=b&state=${STATE}&iss=x&iss=y`],
      [PATH, `?state=${STATE}`],
      [LOGIN_CALLBACK_PREFIX + "127.0.0.1:4455", `?code=a%20b&state=${STATE}`],
    ] as const) {
      const seen = open(pathname, search);
      expect(seen.posted).toEqual([{ channel: LOGIN_CHANNEL_PREFIX + STATE, message: readCallback(pathname, search) }]);
      expect(seen.address).toBe(pathname);
      expect(seen.closedChannels).toBe(1);
      expect(seen.windowClosed).toBe(true);
      expect(seen.text).toBe("You can close this window.");
    }
  });
  it("posts nothing where readCallback returns null, and still takes the query out of the address", () => {
    for (const [pathname, search] of [
      [PATH, ""], [PATH, "?code=abc"], [PATH, `?code=abc&state=${STATE}&state=${STATE}`], [PATH, "?code=abc&state=short"], [PATH, `?state=${STATE}x`],
      [PATH + "/", `?code=abc&state=${STATE}`], [LOGIN_CALLBACK_PREFIX + "Auth.Example", `?code=abc&state=${STATE}`], [LOGIN_CALLBACK_PREFIX + "a%2Fb", `?code=abc&state=${STATE}`],
      [LOGIN_CALLBACK_PREFIX, `?code=abc&state=${STATE}`], ["/remote-provider-callback", `?code=abc&state=${STATE}`], [LOGIN_CALLBACK_PREFIX + "host:port", `?state=${STATE}`],
    ] as const) {
      expect(readCallback(pathname, search), pathname + search).toBeNull();
      const seen = open(pathname, search);
      expect(seen.posted, pathname + search).toEqual([]);
      expect(seen.address).toBe(pathname);
      expect(seen.windowClosed).toBe(false);
      expect(seen.text).toBe("Sign-in failed. Close this window and try again.");
    }
  });
});
