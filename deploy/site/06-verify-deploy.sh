#!/usr/bin/env bash
# Sweep a Pages deployment on its *.pages.dev URL — the real Cloudflare runtime,
# before any DNS is touched. One script for both the preview and the production
# deployment; only the stamp it writes differs.
#
#   deploy/site/06-verify-deploy.sh --latest
#   deploy/site/06-verify-deploy.sh --url https://abc123.pcbjam-site.pages.dev --scope prod-deploy
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/parity.sh"
. "$(dirname "$0")/lib/cf-api.sh"

require_cmd curl jq awk sed

URL=""; SCOPE=preview
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --latest) URL=""; shift ;;
    --scope) SCOPE="$2"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

if [ -z "$URL" ] && [ -s "$STATE_DIR/state/last-deploy.json" ]; then
  URL="$(jq -r .url "$STATE_DIR/state/last-deploy.json")"
fi
[ -n "$URL" ] || die "no deployment URL — pass --url, or run 05-deploy.sh first"

section "target"
echo "  $URL (scope=$SCOPE)"

rc=0
assert_parity "$URL" --scope preview || rc=$?

section "Pages-specific checks"
# If the Function were not bundled (e.g. deployed from the wrong directory) the
# whole endpoint would simply be a static 404. The parity sweep would catch it,
# but say so explicitly — it is the most likely deploy-time mistake.
st="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$URL/api/waitlist" \
       -H 'Origin: https://demo.pcbjam.com' 2>/dev/null || true)"
if [ "$st" = "404" ]; then
  echo "FAIL   /api/waitlist is 404 — the Function was not bundled."
  echo "       wrangler discovers functions/ relative to \$PWD; deploy from site/."
  rc=1
else
  echo "PASS   /api/waitlist is routed (status $st)"
fi

# _routes.json restricts the Function to /api/*. Confirm that did not also break
# static 404 handling for everything else.
nf="$(curl -sS -L -o /dev/null -w '%{http_code}' "$URL/__cfm-parity-404__/" 2>/dev/null || true)"
[ "$nf" = "404" ] && echo "PASS   static 404 handling intact under _routes.json" \
  || { echo "FAIL   unknown path returned $nf, expected 404"; rc=1; }

if [ "$SCOPE" = prod-deploy ]; then
  section "confirming this is the PRODUCTION deployment"
  # Via wrangler, not the REST API: `wrangler login` is enough for this, whereas
  # the REST call would need an API token that the Pages steps otherwise don't.
  latest="$($WRANGLER pages deployment list --project-name "$PAGES_PROJECT" \
             --environment production --json 2>/dev/null || true)"
  envname="$(printf '%s' "$latest" | jq -r '.[0].Environment // "?"' 2>/dev/null || echo '?')"
  did="$(printf '%s' "$latest" | jq -r '.[0].Id // "?"' 2>/dev/null || echo '?')"
  brn="$(printf '%s' "$latest" | jq -r '.[0].Branch // "?"' 2>/dev/null || echo '?')"
  if [ "$envname" != "Production" ]; then
    echo "FAIL   latest deployment environment is '$envname', not 'Production'"
    echo "       (a branch name other than $PAGES_PROD_BRANCH makes it a preview)"
    rc=1
  else
    echo "PASS   latest deployment is Production (branch=$brn id=$did)"
  fi
fi

section "diff vs the Vercel baseline (informational)"
BASE="$STATE_DIR/baseline/vercel"
if [ -d "$BASE" ]; then
  OUT="$STATE_DIR/baseline/pages-$(date +%s)"; mkdir -p "$OUT"
  for p in / /pricing /blog /privacy /blog/porting-kicad-graphics-to-webgl-in-2026 /gerber-demo/boot.js; do
    f="$(printf '%s' "$p" | sed 's|/|_|g')"; [ "$f" = "_" ] && f="_home"
    eff="$(_trace "$URL$p" | cut -f1)"
    _headers "$eff" | grep -vE '^(date|age|etag|last-modified|content-length|server|cf-ray|cf-cache-status|nel|report-to|alt-svc|set-cookie|x-vercel-id|x-vercel-cache|x-matched-path|expires|via):' | sort > "$OUT/$f.headers"
    if [ -f "$BASE/$f.headers" ]; then
      d="$(diff -u "$BASE/$f.headers" "$OUT/$f.headers" || true)"
      [ -n "$d" ] && { echo "--- $p"; printf '%s\n' "$d" | sed -n '3,$p'; }
    fi
  done
  echo "(header differences above are for human review, not assertions)"
else
  warn "no baseline at $BASE — run 00-baseline.sh while Vercel is still live"
fi

[ "$rc" -eq 0 ] || die "deployment verification FAILED — do not cut DNS."

case "$SCOPE" in
  prod-deploy) stamp_write 06-prod-deploy-parity "url=$URL" "deployment_id=${did:-unknown}" ;;
  *)           stamp_write 06-preview-parity "url=$URL" ;;
esac
section "done"
echo "done: verified $URL"
