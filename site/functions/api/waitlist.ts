import { Resend } from 'resend';

/**
 * Waitlist endpoint — a Cloudflare Pages Function.
 *
 * The rest of the site is fully static, so this is the only server-side code we
 * ship. It lives in functions/ rather than src/pages/ because the Astro build
 * has no adapter; Pages routes /api/waitlist here (see public/_routes.json,
 * which keeps every other path a plain static asset request).
 *
 * Secrets arrive as bindings on `context.env`:
 *   wrangler pages secret put RESEND_API_KEY --project-name pcbjam-site
 * Locally they come from site/.dev.vars (gitignored). Without RESEND_API_KEY the
 * endpoint still accepts submits (logs + no email), so the form UX is testable
 * without keys.
 */
interface Env {
  RESEND_API_KEY?: string;
  RESEND_SEGMENT_ID?: string;
  WAITLIST_FROM_EMAIL?: string;
  WAITLIST_ALLOWED_ORIGINS?: string;
}

/**
 * These two used to be `default:` values in astro.config.mjs's env schema. That
 * schema is gone with the adapter, so they live here — WAITLIST_ALLOWED_ORIGINS
 * especially, since `undefined.split(',')` would throw on every preflight.
 */
const DEFAULT_FROM_EMAIL = 'PCBJam <hello@pcbjam.com>';
const DEFAULT_ALLOWED_ORIGINS = 'https://demo.pcbjam.com';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Redact an address for logs: keep the domain (useful for debugging a
 * misconfigured send) but mask the local-part so logs never hold the raw
 * address.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

/**
 * Best-effort per-key rate limit — an in-process sliding window that bounds
 * bursts from one warm isolate. NOT a complete defense (fresh isolates don't
 * share it), so production should ALSO front this with a shared store or a
 * CAPTCHA. Kept dependency-free so it runs.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX_PER_IP = 5;
const RATE_MAX_PER_EMAIL = 2;
const rateHits = new Map<string, number[]>();

function rateLimited(key: string, max: number, now: number): boolean {
  const hits = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= max) {
    rateHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return false;
}

/**
 * Client IP. Cloudflare sets CF-Connecting-IP and it cannot be spoofed by the
 * client; x-forwarded-for is kept as a fallback for `wrangler pages dev` and the
 * unit tests.
 */
function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = request.headers.get('x-forwarded-for');
  return (xff ? xff.split(',')[0] : '').trim() || 'unknown';
}

/**
 * CORS headers when the request Origin is in the configured allowlist — lets the
 * static demo (demo.pcbjam.com, no backend of its own) cross-post the form. A
 * same-origin submit sends no Origin and gets no CORS headers (it doesn't need
 * them). The JSON content-type triggers a preflight, hence the OPTIONS handler.
 *
 * Note this endpoint must be reachable on www WITHOUT a redirect: a CORS
 * preflight cannot follow one, so the demo posts to the canonical www host.
 */
function allowedOrigins(env: Env): string[] {
  return (env.WAITLIST_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  if (!allowedOrigins(env).includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(
  status: number,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

function redirect(status: 'ok' | 'error') {
  // No-JS native submit: bounce back to the page with a status flag.
  return new Response(null, {
    status: 303,
    headers: { Location: `/?waitlist=${status}#waitlist` },
  });
}

export const onRequestOptions: PagesFunction<Env> = ({ request, env }) =>
  new Response(null, { status: 204, headers: corsHeaders(request, env) });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const cors = corsHeaders(request, env);
  const ct = request.headers.get('content-type') ?? '';
  const wantsJson = ct.includes('application/json');

  /**
   * Cross-site form-POST guard.
   *
   * Vercel's edge did this for free ("Cross-site POST form submissions are
   * forbidden", HTTP 403) and Cloudflare Pages does not, so it is reproduced here
   * rather than silently lost in the migration. A form-encoded POST carrying a
   * foreign Origin is the classic CSRF shape: unlike fetch(), a cross-site <form>
   * submit needs no CORS permission to be *sent*, so the allowlist above cannot
   * stop it. Without this, any page could sign arbitrary addresses up and have us
   * email them.
   *
   * JSON posts are deliberately exempt — that is the demo's cross-origin path,
   * and it IS governed by the CORS allowlist. Browsers that omit Origin on a
   * same-origin form submit are unaffected: the check only fires when Origin is
   * present and foreign.
   */
  if (!wantsJson) {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin && !allowedOrigins(env).includes(origin)) {
      return new Response('Cross-site POST form submissions are forbidden', {
        status: 403,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      });
    }
  }

  let data: Record<string, unknown> = {};
  try {
    data = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());
  } catch {
    return wantsJson ? json(400, { ok: false, error: 'bad_request' }, cors) : redirect('error');
  }

  const email = String(data.email ?? '').trim().toLowerCase();
  const honeypot = String(data.company_url ?? ''); // hidden field — must stay empty
  const source = String(data.source ?? 'unknown');

  // Bot caught by honeypot: silently "succeed" so we don't tip them off. This
  // branch deliberately precedes validation, the rate limiter and any Resend
  // call, which also makes it the one probe that can exercise the full request
  // path against production without side effects.
  if (honeypot) return wantsJson ? json(200, { ok: true }, cors) : redirect('ok');

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return wantsJson ? json(400, { ok: false, error: 'invalid_email' }, cors) : redirect('error');
  }

  // Rate limit: bound per-IP and per-address submissions. Checked after
  // validation so invalid emails don't consume budget.
  const now = Date.now();
  const ip = clientIp(request);
  if (
    rateLimited(`ip:${ip}`, RATE_MAX_PER_IP, now) ||
    rateLimited(`email:${email}`, RATE_MAX_PER_EMAIL, now)
  ) {
    return wantsJson
      ? json(429, { ok: false, error: 'rate_limited' }, cors)
      : redirect('error');
  }

  // No key configured (e.g. local dev without secrets): accept + log, don't 500.
  if (!env.RESEND_API_KEY) {
    console.warn(
      `[waitlist] RESEND_API_KEY not set — skipping send. email=${maskEmail(email)} source=${source}`,
    );
    return wantsJson ? json(200, { ok: true }, cors) : redirect('ok');
  }

  const resend = new Resend(env.RESEND_API_KEY);

  try {
    // Add to the segment (the modern name for an "audience"). The SDK returns
    // { data, error } and does NOT throw on API errors. A duplicate contact has
    // no stable error code (it surfaces as a validation_error), so we treat the
    // contact step as best-effort: log any error but never fail the request on
    // it — the user-facing promise is the confirmation email below.
    if (env.RESEND_SEGMENT_ID) {
      const { error: contactError } = await resend.contacts.create({
        email,
        unsubscribed: false,
        segments: [{ id: env.RESEND_SEGMENT_ID }],
      });
      if (contactError) {
        console.error('[waitlist] contacts.create failed (non-fatal)', contactError);
      }
    }

    const { error: sendError } = await resend.emails.send({
      from: env.WAITLIST_FROM_EMAIL ?? DEFAULT_FROM_EMAIL,
      to: email,
      subject: "You're on the PCBJam waitlist",
      text: [
        "You're on the list. 🎉",
        '',
        "We'll send your early-access invite as seats open in waves, plus the occasional",
        'product update. Every update includes an unsubscribe link — and you can reply',
        'to this email at any time to be taken off the list.',
        '',
        "Didn't sign up? Just reply and we'll remove this address.",
        '',
        '— The PCBJam team, built by Emergence Engineering',
        'https://pcbjam.com/privacy',
      ].join('\n'),
    });

    // The confirmation send IS the user-facing promise — fail loudly if Resend
    // rejected it (bad key, unverified domain, invalid from-address, …).
    if (sendError) {
      console.error('[waitlist] emails.send failed', sendError);
      return wantsJson ? json(502, { ok: false, error: 'send_failed' }, cors) : redirect('error');
    }

    return wantsJson ? json(200, { ok: true }, cors) : redirect('ok');
  } catch (err) {
    // Defensive: unexpected throw (network error, bad construction).
    console.error('[waitlist] unexpected error', err);
    return wantsJson ? json(502, { ok: false, error: 'send_failed' }, cors) : redirect('error');
  }
};

// A bare GET (e.g. someone visiting the URL) shouldn't 500.
export const onRequestGet: PagesFunction<Env> = () =>
  json(405, { ok: false, error: 'method_not_allowed' });
