#!/usr/bin/env bash
# Build the site and run it the way Cloudflare Pages will, then sweep it. This is
# the gate: 05-deploy.sh refuses to deploy a tree that has not passed here.
#
#   deploy/site/02-verify-local.sh [--port 8788] [--skip-build] [--keep-running]
#
# Writes a TEMPORARY .dev.vars containing a deliberately BOGUS RESEND_API_KEY.
# That is on purpose: a valid-email POST must then come back 502 send_failed,
# which proves the `resend` SDK actually resolved and issued a request under the
# Pages runtime. A module-resolution error instead means nodejs_compat isn't
# taking effect (it is declared in site/wrangler.toml).
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/parity.sh"

require_cmd curl jq awk sed node npm npx

PORT=8788; SKIP_BUILD=0; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep-running) KEEP=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

cd "$SITE_DIR"

section "structural checks (before spending time on a build)"
[ -f functions/api/waitlist.ts ] || die "functions/api/waitlist.ts is missing — the waitlist endpoint would 404"
grep -q 'adapter:' astro.config.mjs && die "astro.config.mjs still configures an adapter; this deploy is pure static"
grep -q 'astro:env/server' functions/api/waitlist.ts && \
  die "functions/api/waitlist.ts imports astro:env/server, which does not exist in a Pages Function"
for n in RESEND_API_KEY RESEND_SEGMENT_ID WAITLIST_FROM_EMAIL WAITLIST_ALLOWED_ORIGINS; do
  grep -q "$n" functions/api/waitlist.ts || die "functions/api/waitlist.ts never reads $n"
done
echo "ok: no adapter, Function present, reads all four env names"

if [ "$SKIP_BUILD" = 0 ]; then
  section "npm ci + test + build"
  npm ci
  npm test
  npm run build
fi

section "build output"
for f in dist/404.html dist/_headers dist/_routes.json dist/index.html; do
  [ -e "$f" ] || die "$f missing after build"
  echo "  ok $f"
done
[ -d dist/server ] && die "dist/server exists — an adapter crept back in"
[ -d .vercel ] && die ".vercel/ was produced — the Vercel adapter is still wired up"
# A /* rule would isolate the landing page and break the YouTube hero embed.
if grep -qE '^/\*[[:space:]]*$' dist/_headers; then
  die "_headers contains a bare /* rule — that would apply COOP/COEP site-wide and break the YouTube embed on /"
fi
grep -q 'porting-kicad-graphics-to-webgl-in-2026/\*' dist/_headers \
  || die "_headers has no trailing-slash rule for the blog post; COOP/COEP would land on the redirect, not the document"
echo "ok: _headers scoped correctly, 404.html present"

section "starting wrangler pages dev on :$PORT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already in use — stop the other process or pass --port"
fi

DEV_VARS_CREATED=0
if [ -f .dev.vars ]; then
  warn ".dev.vars already exists; leaving it alone (the 502 probe may not apply)"
else
  printf 'RESEND_API_KEY=re_bogus_key_for_local_verification_only\nRESEND_SEGMENT_ID=seg_local\nWAITLIST_FROM_EMAIL=PCBJam <hello@pcbjam.com>\n' > .dev.vars
  DEV_VARS_CREATED=1
fi

LOG="$STATE_DIR/logs/pages-dev-$(date +%s).log"
$WRANGLER pages dev --port "$PORT" --ip 127.0.0.1 > "$LOG" 2>&1 &
DEV_PID=$!

cleanup() {
  [ "$KEEP" = 1 ] && { echo; echo "left running: http://127.0.0.1:$PORT (pid $DEV_PID)"; return; }
  kill "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  [ "$DEV_VARS_CREATED" = 1 ] && rm -f "$SITE_DIR/.dev.vars"
  return 0
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 \
  || die "pages dev never became ready — see $LOG"
grep -q 'valid header rules' "$LOG" && echo "ok: $(grep -o '[0-9]* valid header rules' "$LOG" | head -1) parsed"

rc=0
assert_parity "http://127.0.0.1:$PORT" --scope local --live-post || rc=$?

section "resend SDK loads under the Pages runtime"
# With the bogus key in .dev.vars this MUST be 502 send_failed. 200 would mean the
# key never reached the Function; a 500 would mean the module failed to resolve.
code="$(curl -sS -o "$STATE_DIR/state/live-post.json" -w '%{http_code}' \
  -X POST "http://127.0.0.1:$PORT/api/waitlist" \
  -H 'content-type: application/json' \
  --data '{"email":"sdk-probe@example.com","source":"cfm-verify"}' 2>/dev/null || true)"
body="$(cat "$STATE_DIR/state/live-post.json" 2>/dev/null || true)"
if [ "$DEV_VARS_CREATED" = 1 ]; then
  case "$code:$body" in
    502:*send_failed*) echo "ok: 502 send_failed — SDK resolved and called Resend" ;;
    200:*) echo "FAIL: 200 — the bogus RESEND_API_KEY never reached the Function"; rc=1 ;;
    *) echo "FAIL: status=$code body=$body (expected 502 send_failed; a module error means nodejs_compat isn't applying)"; rc=1 ;;
  esac
else
  echo "skipped (pre-existing .dev.vars): status=$code"
fi

[ "$rc" -eq 0 ] || die "local verification FAILED — do not deploy. Logs: $LOG"

stamp_write 02-local-parity "port=$PORT"
section "done"
echo "done: local parity ok (ctx=$(ctx_hash)) — 05-deploy.sh will accept this tree"
