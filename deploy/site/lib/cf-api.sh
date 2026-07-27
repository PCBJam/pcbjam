#!/usr/bin/env bash
# Cloudflare API v4 wrapper + the DNS allowlist guard. Sourced, never executed.
#
# Required token scopes (one token, CLOUDFLARE_API_TOKEN):
#   Zone   -> Zone            -> Read    (pcbjam.com)
#   Zone   -> DNS             -> Edit    (record CRUD)
#   Zone   -> Zone Settings   -> Edit    (HSTS / security_header)
#   Zone   -> Dynamic Redirect-> Edit    (http_request_dynamic_redirect ruleset)
#   Account-> Cloudflare Pages-> Edit    (project, secrets, deploy, custom domains)

CF_API="https://api.cloudflare.com/client/v4"

cf_token() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set"
  printf '%s' "$CLOUDFLARE_API_TOKEN"
}
cf_account() {
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"
  printf '%s' "$CLOUDFLARE_ACCOUNT_ID"
}

# cf_api METHOD PATH [JSON_BODY]
# GETs always execute (read-only). Non-GET honours DRY_RUN and prints the exact
# call it would make, body included, so a reviewer sees it before it happens.
cf_api() {
  _m="$1"; _p="$2"; _b="${3:-}"
  if [ "$_m" != "GET" ] && [ "${DRY_RUN:-1}" = 1 ]; then
    echo "WOULD: $_m $_p" >&2
    [ -n "$_b" ] && printf '%s\n' "$_b" | jq . >&2
    echo '{"success":true,"result":{},"dry_run":true}'
    return 0
  fi
  _log="$STATE_DIR/logs/api-$(date +%s)-$$.json"
  if [ -n "$_b" ]; then
    _out="$($CURL_BIN -sS -X "$_m" "$CF_API$_p" \
      -H "Authorization: Bearer $(cf_token)" \
      -H 'Content-Type: application/json' --data "$_b")"
  else
    _out="$($CURL_BIN -sS -X "$_m" "$CF_API$_p" \
      -H "Authorization: Bearer $(cf_token)" \
      -H 'Content-Type: application/json')"
  fi
  printf '%s' "$_out" > "$_log"
  printf '%s' "$_out" | jq -e '.success == true' >/dev/null 2>&1 \
    || die "API $_m $_p failed — see $_log
     $(printf '%s' "$_out" | jq -r '.errors[]? | "  [\(.code)] \(.message)"' 2>/dev/null)"
  printf '%s' "$_out"
}
CURL_BIN="${CURL_BIN:-curl}"

cf_zone_id() {
  if [ -s "$STATE_DIR/state/zone-id" ]; then cat "$STATE_DIR/state/zone-id"; return; fi
  _r="$(cf_api GET "/zones?name=$ZONE_NAME")"
  _n="$(printf '%s' "$_r" | jq '.result | length')"
  [ "$_n" = "1" ] || die "expected exactly 1 zone named $ZONE_NAME, found $_n"
  printf '%s' "$_r" | jq -r '.result[0].id' | tee "$STATE_DIR/state/zone-id"
}

cf_dns_list() { cf_api GET "/zones/$(cf_zone_id)/dns_records?per_page=500"; }

# cf_dns_find <name> <type> -> record id ("" if none)
cf_dns_find() {
  cf_dns_list | jq -r --arg n "$1" --arg t "$2" \
    '.result[] | select(.name==$n and .type==$t) | .id' | head -1
}

# THE guard. Every DNS mutation passes through this first. The zone also holds
# app/demo/editor/cdn/assets records, the Google MX and the two _vercel TXT
# verification records — none of which this migration may touch.
cf_dns_guard() { # cf_dns_guard <record_id> <expected_name>
  _r="$(cf_api GET "/zones/$(cf_zone_id)/dns_records/$1")"
  _n="$(printf '%s' "$_r" | jq -r .result.name)"
  _t="$(printf '%s' "$_r" | jq -r .result.type)"
  case "$_n" in
    "$ZONE_NAME"|"www.$ZONE_NAME"|"cf-attach-probe.$ZONE_NAME") : ;;
    *) die "refusing to touch DNS record '$_n' (allowlist: apex, www, cf-attach-probe)" ;;
  esac
  [ "$_n" = "$2" ] || die "record $1 is '$_n', expected '$2' (stale id? re-run 01-preflight.sh)"
  case "$_t" in
    A|CNAME) : ;;
    *) die "refusing to touch a $_t record ($_n) — only A/CNAME are in scope" ;;
  esac
}

cf_pages_project() { cf_api GET "/accounts/$(cf_account)/pages/projects/$PAGES_PROJECT"; }
cf_pages_domains() { cf_api GET "/accounts/$(cf_account)/pages/projects/$PAGES_PROJECT/domains"; }
