#!/usr/bin/env bash
# Detach pcbjam.com + www.pcbjam.com from the Vercel project, AFTER a soak.
# Keeps the Vercel project, its env vars, and the _vercel TXT records — so
# re-attaching is instant and needs no re-verification.
#
#   deploy/site/09-detach-vercel.sh                    # dry run
#   deploy/site/09-detach-vercel.sh --apply
#   deploy/site/09-detach-vercel.sh --rollback --apply # re-attach (incident use)
#
# Needs VERCEL_TOKEN (a team token with project write), or the vercel CLI logged in.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

require_cmd curl jq
SOAK_H="${SOAK_HOURS:-24}"; ROLLBACK=0
parse_common_flags "$@"
set -- $CFM_ARGS
while [ $# -gt 0 ]; do
  case "$1" in
    --soak-hours) SOAK_H="$2"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --i-understand) CFM_I_UNDERSTAND=1; shift ;;
    "") shift ;;
    *) die "unknown arg: $1" ;;
  esac
done
dry_banner

VAPI="https://api.vercel.com"
vercel_api() { # vercel_api METHOD PATH
  [ -n "${VERCEL_TOKEN:-}" ] || die "VERCEL_TOKEN is not set (a team token with project write)"
  if [ "$1" != GET ] && [ "$DRY_RUN" = 1 ]; then
    echo "WOULD: $1 $VAPI$2" >&2; echo '{"dry_run":true}'; return 0
  fi
  curl -sS -X "$1" "$VAPI$2" -H "Authorization: Bearer $VERCEL_TOKEN" -H 'Content-Type: application/json'
}

TEAM_ID="$(vercel_api GET "/v2/teams?slug=$VERCEL_TEAM" | jq -r '.teams[0].id // empty' 2>/dev/null || true)"
[ -n "$TEAM_ID" ] || warn "could not resolve team id for '$VERCEL_TEAM'; API calls may fail"
Q="teamId=$TEAM_ID"

if [ "$ROLLBACK" = 1 ]; then
  section "re-attaching the domains to Vercel"
  # Instant: the _vercel TXT verification records were never deleted.
  for d in "$ZONE_NAME" "www.$ZONE_NAME"; do
    dry "attach $d to Vercel project $VERCEL_PROJECT" -- true
    [ "$DRY_RUN" = 0 ] && vercel_api POST "/v10/projects/$VERCEL_PROJECT/domains?$Q" >/dev/null 2>&1 || true
  done
  echo "done: domains re-attached (DNS still needs to point at Vercel — see 99-rollback.sh)"
  exit 0
fi

section "soak gate"
STAMP="$STATE_DIR/stamps/08-prod-parity.$(ctx_hash)"
[ -f "$STAMP" ] || die "no 08-prod-parity stamp — run 08-verify-prod.sh first"
ts="$(awk -F= '/^ts=/{print $2}' "$STAMP")"
age_h=$(( ( $(date +%s) - $(stat -f %m "$STAMP") ) / 3600 ))
echo "  verified at $ts (${age_h}h ago); soak requirement ${SOAK_H}h"
if [ "$age_h" -lt "$SOAK_H" ]; then
  [ "${CFM_I_UNDERSTAND:-0}" = 1 ] \
    || die "only ${age_h}h since verification (need ${SOAK_H}h).
     Vercel is your fallback — detaching early removes it. Pass --i-understand to override."
  warn "soak window overridden"
fi

section "re-checking production before removing the fallback"
# Never detach while broken.
for u in "$PROD_BASE/" "$PROD_BASE/blog" "$PROD_BASE/pricing"; do
  c="$(curl -sS -L -o /dev/null -w '%{http_code}' "$u" 2>/dev/null || echo 000)"
  [ "$c" = "200" ] || die "$u returned $c — refusing to detach Vercel while production is unhealthy"
  echo "  ok $u"
done
c="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$PROD_BASE/api/waitlist" \
      -H 'Origin: https://demo.pcbjam.com' -H 'Access-Control-Request-Method: POST' 2>/dev/null || echo 000)"
[ "$c" = "204" ] || die "waitlist preflight returned $c — refusing to detach"
echo "  ok waitlist preflight"

section "detaching"
for d in "www.$ZONE_NAME" "$ZONE_NAME"; do
  dry "DELETE /v9/projects/$VERCEL_PROJECT/domains/$d" -- true
  [ "$DRY_RUN" = 0 ] && vercel_api DELETE "/v9/projects/$VERCEL_PROJECT/domains/$d?$Q" >/dev/null
done

if [ "$DRY_RUN" = 0 ]; then
  section "confirming"
  left="$(vercel_api GET "/v9/projects/$VERCEL_PROJECT/domains?$Q" | jq -r '.domains[]?.name' | tr '\n' ' ')"
  echo "  domains still on the project: ${left:-<none>}"
  case " $left " in
    *" $ZONE_NAME "*|*" www.$ZONE_NAME "*) die "a target domain is still attached" ;;
  esac
fi

section "done"
echo "Deliberately NOT done: the Vercel project, its env vars, and the two _vercel"
echo "TXT DNS records all remain. That is what keeps rollback cheap."
echo "done: vercel domains detached (project $VERCEL_PROJECT retained)"
