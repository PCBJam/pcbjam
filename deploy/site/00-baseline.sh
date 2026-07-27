#!/usr/bin/env bash
# Freeze the LIVE Vercel behaviour as the reference every later step is compared
# against. Read-only; needs no Cloudflare credentials. Run this while Vercel is
# still serving — you cannot re-create it afterwards.
#
#   deploy/site/00-baseline.sh [--force]
#
# Two probes are EXPECTED to fail here: post_coi (the blog post's COOP/COEP) is
# genuinely broken in production today — the page's canonical is the
# trailing-slash URL and that URL serves 200 with no isolation headers. Recording
# it is the point: 08-verify-prod.sh asserts those same probes PASS afterwards,
# so the migration proves it fixed the bug rather than porting it.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/parity.sh"

require_cmd curl dig awk sed jq

OUT="$STATE_DIR/baseline/vercel"
if [ -d "$OUT" ] && [ "${1:-}" != "--force" ]; then
  die "baseline already exists at $OUT — refusing to overwrite (use --force).
     Re-baselining after cutover would silently replace the reference."
fi
mkdir -p "$OUT"

section "confirming $PROD_BASE is still served by Vercel"
hdrs="$(_headers "$PROD_BASE/")"
if [ -z "$(_hdr "$hdrs" x-vercel-id)" ]; then
  die "no x-vercel-id header on $PROD_BASE — this host is not on Vercel any more.
     Baselining a Cloudflare response as 'the Vercel reference' would be useless."
fi
echo "ok: x-vercel-id present"

section "DNS + SOA snapshot"
{
  echo "# captured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "apex_cname=$(dig +short CNAME "$ZONE_NAME" || true)"
  echo "www_cname=$(dig +short CNAME "www.$ZONE_NAME" || true)"
  echo "ns=$(dig +short NS "$ZONE_NAME" | sort | tr '\n' ' ')"
  # The SOA minimum is the NEGATIVE cache TTL. It is the number that makes
  # delete-then-create dangerous: a resolver that asks while the record is gone
  # caches NODATA for this long, and you cannot flush it.
  echo "soa=$(dig +short SOA "$ZONE_NAME" || true)"
  echo "soa_minimum_ttl=$(dig +short SOA "$ZONE_NAME" | awk '{print $NF}')"
} | tee "$OUT/dns.txt"

section "page titles (used to detect a soft-404 later)"
printf 'home_title=%s\n' "$(_title "$PROD_BASE/")" | tee "$OUT/titles.txt"

section "header snapshots"
for p in / /pricing /blog /privacy /blog/porting-kicad-graphics-to-webgl-in-2026 /gerber-demo/boot.js; do
  f="$(printf '%s' "$p" | sed 's|/|_|g')"; [ "$f" = "_" ] && f="_home"
  t="$(_trace "$PROD_BASE$p")"; eff="$(printf '%s' "$t" | cut -f1)"
  {
    echo "# requested: $PROD_BASE$p"
    echo "# effective: $eff (hops $(printf '%s' "$t" | cut -f3))"
    # Drop volatile headers so a later diff shows real changes, not timestamps.
    _headers "$eff" | grep -vE '^(date|age|etag|last-modified|content-length|server|cf-ray|cf-cache-status|nel|report-to|alt-svc|set-cookie|x-vercel-id|x-vercel-cache|x-matched-path|expires|via):' | sort
  } > "$OUT/$f.headers"
  echo "  $p -> $OUT/$f.headers"
done

rc=0
assert_parity "$PROD_BASE" --scope prod || rc=$?
assert_apex_redirect "$APEX_BASE" || rc=$?

{
  echo "# baseline captured $(date -u +%Y-%m-%dT%H:%M:%SZ) against $PROD_BASE (Vercel)"
  echo "# parity exit code: $rc  (non-zero is EXPECTED — see the header of this script)"
} > "$OUT/parity-exit.txt"

section "done"
echo "Baseline written to $OUT"
echo
echo "Read the FAIL rows above and keep them: they are the 'before' half of the"
echo "COOP/COEP fix. 08-verify-prod.sh requires those same probes to pass."
echo "done: file://$OUT"
