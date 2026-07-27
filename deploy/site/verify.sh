#!/usr/bin/env bash
# Health check for www.pcbjam.com — the Astro marketing site on Cloudflare Pages.
#
#   deploy/site/verify.sh                                   # production
#   PROD_BASE=https://abc123.pcbjam-site.pages.dev \
#     deploy/site/verify.sh --skip-dns --skip-domains        # one deployment
#   EXPECT_HSTS=1 deploy/site/verify.sh                      # strict on HSTS
#
# Read-only: it makes GET/OPTIONS/POST requests and changes nothing. The POSTs are
# side-effect-free — the full-path probe uses the endpoint's honeypot branch,
# which returns before validation, before the rate limiter and before any Resend
# call, so it sends no mail and creates no contact.
#
# Exit 0 if every hard assertion passes. Warnings do not fail.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/parity.sh"

require_cmd curl jq awk sed

SKIP_DNS=0; SKIP_DOMAINS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-dns) SKIP_DNS=1; shift ;;
    --skip-domains) SKIP_DOMAINS=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

rc=0

if [ "$SKIP_DNS" = 0 ]; then
  require_cmd dig
  section "DNS"
  # Both hosts are PROXIED Pages custom domains, so they answer with Cloudflare
  # anycast A records and expose no CNAME — an empty CNAME here is the expected
  # state, not a problem. Failing to resolve at all is what's worth catching.
  for h in "$ZONE_NAME" "www.$ZONE_NAME"; do
    a="$(dig +short A "$h" | tr '\n' ' ')"
    printf '  %-20s A=%s\n' "$h" "${a:-<none>}"
    [ -n "$a" ] || { echo "  FAIL   $h does not resolve"; rc=1; }
  done
fi

section "served by Cloudflare"
h="$(_headers "$PROD_BASE/")"
if [ -n "$(_hdr "$h" cf-ray)" ]; then
  echo "  PASS   cf-ray present"
else
  echo "  FAIL   no cf-ray — not being served through Cloudflare"; rc=1
fi

assert_parity "$PROD_BASE" --scope prod || rc=$?
assert_apex "$APEX_BASE" || rc=$?

section "cross-origin isolation on BOTH URL forms of the Gerber post"
# Explicit and duplicated on purpose. The bare form 308s to the trailing-slash
# form, and the trailing-slash form is the page's own canonical — what search
# sends people to. Scoping these headers to one form only is exactly the defect
# this site shipped with before the migration, and it is silent: the page renders
# fine, the embedded viewer just loses SharedArrayBuffer and degrades.
for path in /blog/porting-kicad-graphics-to-webgl-in-2026 /blog/porting-kicad-graphics-to-webgl-in-2026/; do
  eff="$(_trace "$PROD_BASE$path" | cut -f1)"
  hh="$(_headers "$eff")"
  coop="$(_hdr "$hh" cross-origin-opener-policy)"; coep="$(_hdr "$hh" cross-origin-embedder-policy)"
  if [ "$coop" = same-origin ] && [ "$coep" = require-corp ]; then
    echo "  PASS   $path -> isolated"
  else
    echo "  FAIL   $path -> coop='${coop:-absent}' coep='${coep:-absent}' ($eff)"; rc=1
  fi
done

section "demo integration (load-bearing)"
# demo.pcbjam.com has no backend of its own and cross-posts the waitlist form
# here. A CORS preflight cannot follow a redirect, so this must be 204 with zero
# hops — put a redirect in front of the endpoint and the demo breaks silently.
hops="$(curl -sS -o /dev/null -w '%{num_redirects}' -X OPTIONS "$PROD_BASE/api/waitlist" \
         -H 'Origin: https://demo.pcbjam.com' 2>/dev/null || echo 9)"
st="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$PROD_BASE/api/waitlist" \
       -H 'Origin: https://demo.pcbjam.com' -H 'Access-Control-Request-Method: POST' 2>/dev/null || true)"
if [ "$st" = "204" ] && [ "$hops" = "0" ]; then
  echo "  PASS   preflight 204 with 0 redirects"
else
  echo "  FAIL   status=$st hops=$hops (both 204 and 0 hops are required)"; rc=1
fi

if [ "$SKIP_DOMAINS" = 0 ]; then
  section "custom domains on $PAGES_PROJECT"
  doms="$($WRANGLER pages project list --json 2>/dev/null \
           | jq -r --arg n "$PAGES_PROJECT" '.[] | select(."Project Name"==$n) | ."Project Domains"' || true)"
  if [ -z "$doms" ]; then
    warn "could not list projects (is \`wrangler login\` valid?) — skipping"
  else
    echo "  $doms"
    want="www.$ZONE_NAME"
    [ "${APEX_MODE:-serve}" = serve ] && want="$want $ZONE_NAME"
    for d in $want; do
      case ",$(printf '%s' "$doms" | tr -d ' ')," in
        *",$d,"*) echo "  PASS   $d attached" ;;
        *) echo "  FAIL   $d NOT attached"; rc=1 ;;
      esac
    done
  fi
fi

section "summary"
if [ "$rc" -ne 0 ]; then
  echo "FAILED. To recover, promote a previous deployment:"
  echo "  Workers & Pages -> $PAGES_PROJECT -> Deployments -> Rollback to this deployment"
  echo "or redeploy a known-good tree (git stays the source of truth):"
  echo "  git checkout <good-commit> -- site/"
  echo "  (cd site && npm ci && npm run build && npx --yes wrangler@4 pages deploy \\"
  echo "     --project-name $PAGES_PROJECT --branch production)"
  exit 1
fi
echo "All checks passed."
echo "done: $PROD_BASE"
