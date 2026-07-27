#!/usr/bin/env bash
# The go/no-go after cutover. Read-only.
#
#   deploy/site/08-verify-prod.sh
#
# Also asserts the two probes that FAILED in 00-baseline.sh now pass, so the
# migration demonstrably fixed the COOP/COEP bug rather than carrying it over.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/parity.sh"
. "$(dirname "$0")/lib/cf-api.sh"

require_cmd curl dig jq awk sed

rc=0

section "DNS now resolves to Cloudflare"
www_cname="$(dig +short CNAME "www.$ZONE_NAME" || true)"
echo "  www CNAME: ${www_cname:-<none>}"
case "$www_cname" in
  *pages.dev*) echo "  PASS   points at Pages" ;;
  *vercel-dns*) echo "  FAIL   still points at Vercel — DNS has not propagated (or the swap did not run)"; rc=1 ;;
  *) echo "  WARN   unexpected target" ;;
esac

section "we are actually being served by Cloudflare, not a stale Vercel cache"
h="$(_headers "$PROD_BASE/")"
if [ -n "$(_hdr "$h" x-vercel-id)" ]; then
  echo "  FAIL   x-vercel-id still present — you are seeing cached DNS."
  echo "         Wait for the TTL and re-run; this is NOT a pass."
  rc=1
else
  echo "  PASS   no x-vercel-id"
fi
[ -n "$(_hdr "$h" cf-ray)" ] && echo "  PASS   cf-ray present" || echo "  WARN   no cf-ray header"

assert_parity "$PROD_BASE" --scope prod || rc=$?
assert_apex "$APEX_BASE" || rc=$?

section "the two baseline failures must now pass"
# This is the whole point of having captured a baseline: prove the fix.
for path in /blog/porting-kicad-graphics-to-webgl-in-2026 /blog/porting-kicad-graphics-to-webgl-in-2026/; do
  eff="$(_trace "$PROD_BASE$path" | cut -f1)"
  hh="$(_headers "$eff")"
  coop="$(_hdr "$hh" cross-origin-opener-policy)"; coep="$(_hdr "$hh" cross-origin-embedder-policy)"
  if [ "$coop" = same-origin ] && [ "$coep" = require-corp ]; then
    echo "  PASS   $path -> isolated ($eff)"
  else
    echo "  FAIL   $path -> coop='${coop:-absent}' coep='${coep:-absent}' ($eff)"
    echo "         this is the bug the migration was supposed to fix"
    rc=1
  fi
done

section "the demo integration (load-bearing)"
# demo.pcbjam.com has no backend; it cross-posts here. A CORS preflight cannot
# follow a redirect, so this must be 204 on www with zero hops.
hops="$(curl -sS -o /dev/null -w '%{num_redirects}' -X OPTIONS "$PROD_BASE/api/waitlist" \
         -H 'Origin: https://demo.pcbjam.com' 2>/dev/null || echo 9)"
st="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$PROD_BASE/api/waitlist" \
       -H 'Origin: https://demo.pcbjam.com' -H 'Access-Control-Request-Method: POST' 2>/dev/null || true)"
if [ "$st" = "204" ] && [ "$hops" = "0" ]; then
  echo "  PASS   preflight 204 with 0 redirects"
else
  echo "  FAIL   status=$st hops=$hops (both 204 and 0 hops are required)"; rc=1
fi

section "custom domains attached to $PAGES_PROJECT"
# Via wrangler (works with `wrangler login`); the REST endpoint would need an API
# token that nothing else in the serve-mode path requires.
doms="$($WRANGLER pages project list --json 2>/dev/null \
         | jq -r --arg n "$PAGES_PROJECT" '.[] | select(."Project Name"==$n) | ."Project Domains"')"
echo "  $doms"
want="www.$ZONE_NAME"
[ "${APEX_MODE:-serve}" = serve ] && want="$want $ZONE_NAME"
for d in $want; do
  case ",$(printf '%s' "$doms" | tr -d ' ')," in
    *",$d,"*) echo "  PASS   $d attached" ;;
    *) echo "  FAIL   $d NOT attached to $PAGES_PROJECT"; rc=1 ;;
  esac
done

section "summary"
if [ "$rc" -ne 0 ]; then
  echo "PROD VERIFICATION FAILED."
  echo "Rollback is one command:  deploy/site/99-rollback.sh --apply"
  exit 1
fi
stamp_write 08-prod-parity
echo "All checks passed. Vercel still holds the domains as a fallback;"
echo "detach them after a soak:  deploy/site/09-detach-vercel.sh --apply"
echo "done: $PROD_BASE"
