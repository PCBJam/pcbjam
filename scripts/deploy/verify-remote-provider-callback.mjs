#!/usr/bin/env node
// Verify the sign-in callback page of remote providers, in a local deployment
// directory or at an HTTPS editor origin. A provider's sign-in server sends the
// sign-in window to /remote-provider-callback/<its host>; that address has no
// file, so the editor's Worker (web/standalone/plugin-assets-worker.ts) serves
// the built page there. What must hold at the deployed address: the page
// itself (never a redirect, never the editor), its own strict headers, and a
// fixed failure for anything that is not a host name.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [target] = process.argv.slice(2);
assert.ok(target, "Usage: verify-remote-provider-callback.mjs <dist-directory|https://editor-origin>");
const remote = /^https:\/\//.test(target);
if (/^https?:/.test(target)) assert.ok(remote, "Deployed checks require HTTPS");
const MARKER = '<meta name="pcbjam-page" content="remote-provider-callback"';
const digest = (text) => createHash("sha256").update(text).digest("base64");
const inline = (page, tag) => [...page.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))];

function checkPage(page, what) {
  assert.ok(page.includes(MARKER), `${what}: the callback page's marker`);
  const scripts = inline(page, "script"), styles = inline(page, "style");
  assert.equal(scripts.length, 1, `${what}: exactly one script`);
  assert.match(scripts[0][0], /^<script>/, `${what}: the script is inline, without attributes`);
  assert.equal(styles.length, 1, `${what}: exactly one style`);
  assert.doesNotMatch(page, /\bsrc=|\bhref=|<link\b/, `${what}: the page loads nothing`);
  return `default-src 'none'; script-src 'sha256-${digest(scripts[0][1])}'; style-src 'sha256-${digest(styles[0][1])}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

if (!remote) {
  checkPage(await readFile(path.join(target, "remote-provider-callback.html"), "utf8"), "built file");
  console.log("Verified the built remote-provider callback page");
} else {
  const get = (address, init = {}) => fetch(new URL(address, target), { redirect: "manual", signal: AbortSignal.timeout(20000), ...init });
  // A made-up answer of a sign-in server; nothing of it may come back in the page.
  const query = "?code=verify-not-a-code&state=" + "v".repeat(43) + "&iss=https%3A%2F%2Fauth.example.com";
  const response = await get("/remote-provider-callback/auth.example.com" + query);
  assert.equal(response.status, 200, "callback page");
  assert.equal(response.headers.get("location"), null, "no redirect: the path names the sign-in server");
  const page = await response.text();
  const policy = checkPage(page, "deployed page");
  assert.doesNotMatch(page, /verify-not-a-code/, "the query is not in the answer");
  const headers = response.headers;
  assert.match(headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(headers.get("content-security-policy"), policy, "the policy allows exactly the page's script and style");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin");
  for (const [address, method] of [
    ["/remote-provider-callback/", "GET"],
    ["/remote-provider-callback/auth.example.com/more", "GET"],
    ["/remote-provider-callback/Auth.Example.com", "GET"],
    ["/remote-provider-callback/auth%2Fexample", "GET"],
    ["/remote-provider-callback/auth.example.com", "POST"],
  ]) {
    const refused = await get(address + query, { method });
    assert.equal(refused.status, 404, `${method} ${address}`);
    assert.equal(refused.headers.get("cache-control"), "no-store");
    const body = await refused.text();
    assert.match(body, /Sign-in failed/, address);
    assert.doesNotMatch(body, /<script|id="root"/i, `${address}: never the editor`);
  }
  console.log("Verified the deployed remote-provider callback page: its address, body, headers and refusals");
}
