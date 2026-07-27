#!/usr/bin/env bash
# Prove every credential and token scope the later steps need, and snapshot DNS
# for rollback. Read-only — makes no changes anywhere.
#
#   export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...
#   deploy/site/01-preflight.sh
#
# Re-run this freely; it is the script to come back to after fixing a scope or
# logging wrangler in.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/cf-api.sh"

require_cmd curl dig jq awk node npm npx shasum

ok=0; bad=0
chk() { # chk "<label>" <0|1> ["remediation"]
  if [ "$2" = 0 ]; then printf '  ok    %s\n' "$1"; ok=$((ok+1))
  else printf '  FAIL  %s\n' "$1"; [ -n "${3:-}" ] && printf '        -> %s\n' "$3"; bad=$((bad+1)); fi
}

section "toolchain"
nv="$(node -v | sed 's/^v//')"
node_ok=1
# Astro 6 needs >= 22.12.0
maj="${nv%%.*}"; rest="${nv#*.}"; min="${rest%%.*}"
if [ "$maj" -gt 22 ] 2>/dev/null || { [ "$maj" = 22 ] && [ "$min" -ge 12 ]; } 2>/dev/null; then node_ok=0; fi
chk "node $nv >= 22.12 (Astro 6)" $node_ok "install Node 22.12+ (nvm use 22)"
chk "wrangler reachable ($($WRANGLER --version 2>/dev/null | head -1))" \
    "$($WRANGLER --version >/dev/null 2>&1; echo $?)"

section "cloudflare auth"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  chk "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported" 0
  tv="$(cf_api GET /user/tokens/verify 2>/dev/null || true)"
  st="$(printf '%s' "$tv" | jq -r '.result.status // "unknown"' 2>/dev/null || echo unknown)"
  chk "token status = active (got '$st')" "$([ "$st" = active ] && echo 0 || echo 1)"
else
  chk "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported" 1 \
    "the API steps (03,07,09) need both. Create a token with the scopes listed in lib/cf-api.sh"
  wo="$($WRANGLER whoami 2>&1 || true)"
  case "$wo" in
    *"Not logged in"*|*"could not be refreshed"*)
      chk "wrangler logged in" 1 "run: $WRANGLER login   (the local token is expired)" ;;
    *) chk "wrangler logged in" 0 ;;
  esac
fi

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  section "zone"
  zid="$(cf_zone_id 2>/dev/null || true)"
  chk "zone $ZONE_NAME resolved (${zid:-none})" "$([ -n "$zid" ] && echo 0 || echo 1)"

  if [ -n "$zid" ]; then
    section "token scopes (each probe maps to one permission)"
    cf_api GET "/zones/$zid/dns_records?per_page=5" >/dev/null 2>&1
    chk "Zone -> DNS -> Read/Edit" $?
    # 404 here is fine and expected — it means the redirect phase has no ruleset
    # yet. 403 is the failure we are probing for.
    rs="$($CURL_BIN -sS "$CF_API/zones/$zid/rulesets/phases/http_request_dynamic_redirect/entrypoint" \
           -H "Authorization: Bearer $(cf_token)" || true)"
    code="$(printf '%s' "$rs" | jq -r '.errors[0].code // "ok"' 2>/dev/null)"
    chk "Zone -> Dynamic Redirect -> Edit (probe code=$code)" \
        "$([ "$code" = "ok" ] || [ "$code" = "10000" ] || printf '%s' "$rs" | jq -e '.success==false and (.errors[0].code==1002 or .errors[0].code==10000)' >/dev/null 2>&1; echo $?)" \
        "add 'Dynamic Redirect: Edit' (sometimes shown as Config/Transform Rules) to the token"
    cf_api GET "/zones/$zid/settings/security_header" >/dev/null 2>&1
    chk "Zone -> Zone Settings -> Edit (HSTS)" $?
    cf_api GET "/accounts/$(cf_account)/pages/projects" >/dev/null 2>&1
    chk "Account -> Cloudflare Pages -> Edit" $?

    section "free-plan redirect headroom"
    nrules="$(printf '%s' "$rs" | jq '.result.rules | length' 2>/dev/null || echo 0)"
    [ "$nrules" = "null" ] && nrules=0
    chk "existing dynamic redirects: $nrules (< 10 on the free plan)" \
        "$([ "$nrules" -lt 10 ] && echo 0 || echo 1)"

    section "DNS snapshot -> state/dns-before.json (rollback source of truth)"
    cf_dns_list > "$STATE_DIR/state/dns-before.json"
    for spec in "$ZONE_NAME:CNAME" "www.$ZONE_NAME:CNAME"; do
      n="${spec%%:*}"; t="${spec##*:}"
      c="$(jq -r --arg n "$n" --arg t "$t" '.result[]|select(.name==$n and .type==$t)|.content' \
            "$STATE_DIR/state/dns-before.json" | head -1)"
      chk "$n $t -> ${c:-MISSING} (expect $VERCEL_DNS_TARGET)" \
          "$([ "$c" = "$VERCEL_DNS_TARGET" ] && echo 0 || echo 1)" \
          "the record moved since this migration was planned — re-read the plan before continuing"
    done
    mx="$(jq -r '.result[]|select(.type=="MX")|.content' "$STATE_DIR/state/dns-before.json" | head -1)"
    chk "Google MX still present ($mx) — must survive untouched" \
        "$([ -n "$mx" ] && echo 0 || echo 1)"
  fi
fi

section "nameservers"
ns="$(dig +short NS "$ZONE_NAME" | tr '\n' ' ')"
case "$ns" in *becky*|*ernest*) chk "on Cloudflare NS ($ns)" 0 ;;
  *) chk "on Cloudflare NS ($ns)" 1 "the zone must be on Cloudflare nameservers" ;;
esac

section "vercel (needed only by 09-detach / 99-rollback)"
if command -v vercel >/dev/null 2>&1 || [ -n "${VERCEL_TOKEN:-}" ]; then
  names="$(npx --yes vercel@latest env ls production --project "$VERCEL_PROJECT" --scope "$VERCEL_TEAM" 2>/dev/null \
           | awk '/^ [A-Z]/{print $1}' | sort | tr '\n' ' ' || true)"
  echo "  env var NAMES on Vercel (values never read): ${names:-<unavailable>}"
  [ -n "$names" ] && printf '%s\n' "$names" > "$STATE_DIR/state/vercel-env-names.txt"
  for want in RESEND_API_KEY RESEND_SEGMENT_ID WAITLIST_FROM_EMAIL; do
    case " $names " in *" $want "*) chk "$want present on Vercel" 0 ;;
      *) chk "$want present on Vercel" 1 "expected it there; 04-set-secrets.sh needs its value" ;;
    esac
  done
else
  warn "vercel CLI not on PATH and VERCEL_TOKEN unset — skipping (only 09/99 need it)"
fi

section "summary"
echo "  $ok ok, $bad failed"
[ "$bad" -eq 0 ] || die "preflight failed — fix the FAIL rows above before continuing."
stamp_write 01-preflight "zone=${zid:-unknown}"
echo "done: preflight ok (zone=${zid:-unknown})"
