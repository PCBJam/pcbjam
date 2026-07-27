#!/usr/bin/env bash
# One command, incident-grade: put www.pcbjam.com and the apex back on Vercel.
#
#   deploy/site/99-rollback.sh                # dry run — read it first
#   deploy/site/99-rollback.sh --apply --yes
#
# Order matters: re-attach at Vercel FIRST so the target exists before DNS points
# at it, then restore DNS, then disable the redirect rule.
#
# Leaves the Pages project, its deployments and its secrets alone — re-cutting
# over later is just `07-dns-cutover.sh --phase swap --apply`.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/cf-api.sh"

require_cmd curl dig jq
SKIP_VERCEL=0
parse_common_flags "$@"
set -- $CFM_ARGS
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-vercel) SKIP_VERCEL=1; shift ;;
    "") shift ;;
    *) die "unknown arg: $1" ;;
  esac
done
dry_banner

HERE="$(dirname "$0")"
FLAGS=""; [ "$DRY_RUN" = 0 ] && FLAGS="--apply"

section "1/3 re-attach the domains at Vercel"
if [ "$SKIP_VERCEL" = 1 ]; then
  echo "  skipped (--skip-vercel)"
elif [ -z "${VERCEL_TOKEN:-}" ]; then
  warn "VERCEL_TOKEN unset — skipping the re-attach step."
  warn "Do it by hand NOW (Vercel -> project $VERCEL_PROJECT -> Domains -> add"
  warn "$ZONE_NAME and www.$ZONE_NAME) before the DNS change below propagates."
else
  # shellcheck disable=SC2086
  "$HERE/09-detach-vercel.sh" --rollback $FLAGS || warn "re-attach reported an error; check the Vercel dashboard"
fi

section "2/3 restore DNS + disable the redirect rule"
# shellcheck disable=SC2086
"$HERE/07-dns-cutover.sh" --rollback $FLAGS --yes

if [ "$DRY_RUN" = 1 ]; then
  echo; echo "done: (dry run) nothing changed. Re-run with --apply --yes to roll back."
  exit 0
fi

section "3/3 waiting for Vercel to serve again (www ttl is 60)"
ok=1
for i in $(seq 1 60); do
  h="$(curl -sS -o /dev/null -D - "$PROD_BASE/" 2>/dev/null | tr -d '\r' || true)"
  st="$(printf '%s' "$h" | awk '/^HTTP/{c=$2} END{print c}')"
  vid="$(printf '%s' "$h" | awk 'tolower($1)=="x-vercel-id:"{print $2}' | tail -1)"
  echo "  [${i}] status=$st x-vercel-id=${vid:-none} cname=$(dig +short CNAME "www.$ZONE_NAME" | head -1)"
  if [ "$st" = "200" ] && [ -n "$vid" ]; then ok=0; break; fi
  sleep 5
done

section "done"
if [ "$ok" = 0 ]; then
  echo "www.$ZONE_NAME is served by Vercel again."
else
  echo "www.$ZONE_NAME is NOT confirmably back on Vercel yet."
  echo "Check: the domains are attached in Vercel, and dig www.$ZONE_NAME."
fi
echo "The Pages project is untouched; re-cutover is 07-dns-cutover.sh --phase swap --apply"
echo "done: rollback complete (re-baseline with 00-baseline.sh --force if you want a fresh reference)"
