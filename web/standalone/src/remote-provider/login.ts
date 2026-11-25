// Sign-in of a remote-provider panel: the parts without DOM or network. Used by the host
// (host.ts) and by the callback page the sign-in server sends the popup back to
// (remote-provider-callback.ts), so it imports nothing.
//
// The popup has no opener (the editor is cross-origin isolated), so the callback page hands
// what it received to the editor over a same-origin BroadcastChannel named by the attempt's
// `state`. Other editor tabs never hear it, and a code is useless without the PKCE verifier
// that stays in the host's memory.

export const LOGIN_CHANNEL_PREFIX = "pcbjam-remote-provider-login:";
/** Where the sign-in server sends the popup back: this prefix, then the issuer's host. */
export const LOGIN_CALLBACK_PREFIX = "/remote-provider-callback/";
/**
 * The built callback page carries this text. The editor's Worker serves the page only when it
 * finds it: a missing file is answered with the editor's index.html, which must never appear
 * at the callback address.
 */
export const LOGIN_CALLBACK_MARKER = '<meta name="pcbjam-page" content="remote-provider-callback"';
/** `state` as the host makes it: 32 random bytes, base64url. */
const STATE = /^[A-Za-z0-9_-]{43}$/;
/** A host name, in local tests with a port. */
export const ISSUER_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
/** What the server accepts as a code (plugin-platform-contract.ts). */
const CODE = /^[\x20-\x7e]{1,2048}$/;

/** Values are lists, so the host sees a doubled or a missing one. */
export interface CallbackMessage {
  /** The callback's path segment: the host of the sign-in server it was registered for. */
  as: string;
  state: string;
  code: string[];
  error: string[];
  iss: string[];
}

/**
 * What the callback page posts, read from its own address. null when the address is not a
 * callback of ours or carries no single well-formed `state`: then nothing is posted.
 */
export function readCallback(pathname: string, search: string): CallbackMessage | null {
  if (!pathname.startsWith(LOGIN_CALLBACK_PREFIX)) return null;
  const as = pathname.slice(LOGIN_CALLBACK_PREFIX.length);
  if (!ISSUER_HOST.test(as)) return null;
  const query = new URLSearchParams(search);
  const states = query.getAll("state");
  if (states.length !== 1 || !STATE.test(states[0]!)) return null;
  return { as, state: states[0]!, code: query.getAll("code"), error: query.getAll("error"), iss: query.getAll("iss") };
}

export type CallbackVerdict =
  /** Not this attempt's answer: the attempt goes on. */
  | { kind: "ignore" }
  /** This attempt's answer, and it breaks a rule: the attempt ends, a code in it is never exchanged. */
  | { kind: "failed" }
  | { kind: "code"; code: string }
  | { kind: "error"; text: string };

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** The checks of plugins 0028 §6.6, in their order. `issuer` is the one the release is pinned to. */
export function judgeCallback(message: unknown, pending: { state: string; issuer: string }): CallbackVerdict {
  const m = message as Partial<CallbackMessage> | null;
  // 1. The attempt and the sign-in server it was started for.
  if (!m || typeof m !== "object" || m.state !== pending.state || m.as !== new URL(pending.issuer).host) return { kind: "ignore" };
  if (!strings(m.code) || !strings(m.error) || !strings(m.iss)) return { kind: "failed" };
  // 2. Exactly one `iss`, and it is the pinned issuer: compared as text, character for
  // character. Parsing it as a URL would let a path, a slash or another letter case through
  // (RFC 9207 §2.4). This holds for error answers too.
  if (m.iss.length !== 1 || m.iss[0] !== pending.issuer) return { kind: "failed" };
  // 3. Either one code or one error.
  if (m.code.length === 1 && !m.error.length && CODE.test(m.code[0]!)) return { kind: "code", code: m.code[0]! };
  if (m.error.length === 1 && !m.code.length && m.error[0])
    // Two fixed texts, never the server's own words.
    return { kind: "error", text: m.error[0] === "access_denied" ? "Sign-in was cancelled" : "The provider refused the sign-in" };
  return { kind: "failed" };
}

export interface SignInConfig {
  type: "oauth2";
  issuer: string;
  clientId: string;
  scopes: string[];
  authorizationEndpoint: string;
  /** `<editor origin>/remote-provider-callback/<issuer host>`, built by the server. */
  redirectUri: string;
}

/** The address the popup opens: the code flow with PKCE (S256). */
export function authorizationUrl(auth: SignInConfig, state: string, challenge: string): string {
  const url = new URL(auth.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientId);
  url.searchParams.set("redirect_uri", auth.redirectUri);
  if (auth.scopes.length) url.searchParams.set("scope", auth.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  return url.href;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** 32 random bytes as 43 base64url characters: a `state` or a PKCE verifier. */
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export interface PkcePair {
  verifier: string;
  challenge: string;
}
/** A PKCE verifier and its S256 challenge. The hash is asynchronous, so pairs are made ahead of the click. */
export async function makePkcePair(): Promise<PkcePair> {
  const verifier = randomToken();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
