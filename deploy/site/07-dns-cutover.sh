#!/usr/bin/env bash
# Move www.pcbjam.com from Vercel to the Pages project, and point the apex at a
# 308 redirect to www. THE ONLY SCRIPT HERE THAT AFFECTS LIVE TRAFFIC.
#
#   deploy/site/07-dns-cutover.sh --phase probe              # dry run (default)
#   deploy/site/07-dns-cutover.sh --phase probe --apply
#   ...
#   deploy/site/07-dns-cutover.sh --phase swap --apply
#   deploy/site/07-dns-cutover.sh --rollback --apply
#
# Phases, in the order they should be run. Only `swap` and `apex` are live:
#
#   prelower  T-24h   drop the www TTL to 60 so the cut AND any rollback
#                     propagate in ~1 min instead of ~5.
#   probe     T-days  create a throwaway hostname, attach it as a Pages custom
#                     domain, delete both. Settles — at zero risk to www —
#                     whether Pages will attach over an existing CNAME, and
#                     measures how long validation takes.
#   rules     T-1d    create the apex->www redirect rule. INERT until the apex is
#                     proxied, so it is safe to create early and verify later.
#   hsts      T-1d    enable zone HSTS at Vercel's existing max-age. Additive.
#   swap      T+0     www -> Pages. See "the window" below.
#   apex      T+2m    apex -> proxied placeholder, which activates the rule.
#
# THE WINDOW. The swap is an in-place PATCH, not a delete-then-create, and that
# distinction is the single most important safety property here. A PATCH changes
# content and proxied status atomically, so there is NO DNS gap. Delete-then-
# create leaves the name with no record for a second or two, and any resolver
# that asks in that instant caches NODATA for the zone's SOA minimum (typically
# 1800s) — an un-flushable ~30-minute partial outage. 00-baseline.sh records the
# actual SOA minimum so you can see the exposure. The residual risk with PATCH is
# HTTP-only and self-healing: for a second or two the edge has no route for the
# host and serves the Pages not-found page. Universal SSL already covers
# *.pcbjam.com, so TLS is never in question.
#
# Vercel stays attached throughout, so resolvers still holding the old answer keep
# serving the identical site. This is a fade, not a switch.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/cf-api.sh"
. "$(dirname "$0")/lib/parity.sh"

require_cmd curl dig jq awk

PHASE=""; ROLLBACK=0; SWAP_MODE=auto
parse_common_flags "$@"
set -- $CFM_ARGS
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --swap-mode) SWAP_MODE="$2"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    "") shift ;;
    *) die "unknown arg: $1" ;;
  esac
done
dry_banner

ZID="$(cf_zone_id)"
PROBE_HOST="cf-attach-probe.$ZONE_NAME"
SNAP="$STATE_DIR/state/dns-before.json"
[ -s "$SNAP" ] || die "no DNS snapshot at $SNAP — run 01-preflight.sh first (it is the rollback source of truth)"

# ---------------------------------------------------------------- rollback ----
if [ "$ROLLBACK" = 1 ]; then
  section "rollback: restore the Vercel CNAMEs and disable the redirect rule"
  for n in "www.$ZONE_NAME" "$ZONE_NAME"; do
    for t in CNAME A; do
      id="$(cf_dns_find "$n" "$t")"
      [ -n "$id" ] || continue
      cf_dns_guard "$id" "$n"
      dry "restore $n -> $VERCEL_DNS_TARGET (CNAME, unproxied, ttl 60)" -- true
      [ "$DRY_RUN" = 0 ] && cf_api PUT "/zones/$ZID/dns_records/$id" \
        "$(jq -n --arg n "$n" --arg c "$VERCEL_DNS_TARGET" \
           '{type:"CNAME",name:$n,content:$c,proxied:false,ttl:60}')" >/dev/null
      break
    done
  done
  if [ -s "$STATE_DIR/state/redirect-rule.json" ]; then
    rsid="$(jq -r .ruleset_id "$STATE_DIR/state/redirect-rule.json")"
    rid="$(jq -r .rule_id "$STATE_DIR/state/redirect-rule.json")"
    dry "disable redirect rule $rid" -- true
    [ "$DRY_RUN" = 0 ] && cf_api PATCH "/zones/$ZID/rulesets/$rsid/rules/$rid" \
      '{"enabled":false}' >/dev/null || true
  fi
  echo
  echo "The Pages project, its deployments and secrets are left intact — re-cutting"
  echo "over later is just: 07-dns-cutover.sh --phase swap --apply"
  echo "done: rolled back (www ttl=60)"
  exit 0
fi

[ -n "$PHASE" ] || die "pass --phase prelower|probe|rules|hsts|swap|apex (or --rollback)"

# ---------------------------------------------------------------- prelower ----
phase_prelower() {
  section "prelower: www TTL -> 60"
  id="$(cf_dns_find "www.$ZONE_NAME" CNAME)"
  [ -n "$id" ] || die "no www CNAME found"
  cf_dns_guard "$id" "www.$ZONE_NAME"
  cur="$(cf_api GET "/zones/$ZID/dns_records/$id")"
  content="$(printf '%s' "$cur" | jq -r .result.content)"
  ttl="$(printf '%s' "$cur" | jq -r .result.ttl)"
  proxied="$(printf '%s' "$cur" | jq -r .result.proxied)"
  echo "  current: $content ttl=$ttl proxied=$proxied"
  [ "$proxied" = "false" ] || die "record is proxied; TTL is not settable while proxied (and it should still be Vercel's at this point)"
  dry "PATCH www TTL 60" -- true
  [ "$DRY_RUN" = 0 ] && cf_api PATCH "/zones/$ZID/dns_records/$id" '{"ttl":60}' >/dev/null
  echo "done: www ttl 60 (was $ttl)"
}

# ------------------------------------------------------------------- probe ----
phase_probe() {
  section "probe: can Pages attach a custom domain over an existing CNAME?"
  echo "Uses the throwaway host $PROBE_HOST. www is never touched."
  if [ "$DRY_RUN" = 1 ]; then
    echo "WOULD: POST /zones/$ZID/dns_records  (CNAME $PROBE_HOST -> $PAGES_PROJECT.pages.dev, proxied)"
    echo "WOULD: POST /accounts/<acct>/pages/projects/$PAGES_PROJECT/domains  {\"name\":\"$PROBE_HOST\"}"
    echo "WOULD: poll until status=active, curl it, then DELETE both"
    exit 0
  fi
  rid="$(cf_api POST "/zones/$ZID/dns_records" \
    "$(jq -n --arg n "$PROBE_HOST" --arg c "$PAGES_PROJECT.pages.dev" \
      '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1,comment:"cf-migrate probe - safe to delete"}')" \
    | jq -r .result.id)"
  echo "  created probe record $rid"
  attach_rc=0
  cf_api POST "/accounts/$(cf_account)/pages/projects/$PAGES_PROJECT/domains" \
    "$(jq -n --arg n "$PROBE_HOST" '{name:$n}')" >/dev/null 2>&1 || attach_rc=$?
  t0=$(date +%s); status=unknown
  if [ "$attach_rc" = 0 ]; then
    for _ in $(seq 1 60); do
      status="$(cf_pages_domains | jq -r --arg n "$PROBE_HOST" '.result[]|select(.name==$n)|.status' | head -1)"
      [ "$status" = active ] && break
      sleep 5
    done
  fi
  secs=$(( $(date +%s) - t0 ))
  code="$(curl -sS -o /dev/null -w '%{http_code}' "https://$PROBE_HOST/" 2>/dev/null || echo 000)"
  echo "  attach_rc=$attach_rc status=$status seconds_to_active=$secs http=$code"

  if [ "$attach_rc" = 0 ] && [ "$status" = active ]; then
    printf 'ok seconds_to_active=%s\n' "$secs" > "$STATE_DIR/state/attach-over-existing-record.ok"
    rm -f "$STATE_DIR/state/attach-over-existing-record.unsupported"
    echo "  => in-place PATCH swap is supported (swap-mode auto will use it)"
  else
    printf 'unsupported attach_rc=%s status=%s\n' "$attach_rc" "$status" \
      > "$STATE_DIR/state/attach-over-existing-record.unsupported"
    rm -f "$STATE_DIR/state/attach-over-existing-record.ok"
    warn "attach over an existing record did NOT work; swap-mode auto will fall back to delete-create"
    warn "read the NODATA warning in this script's header before running the swap"
  fi

  cf_api DELETE "/accounts/$(cf_account)/pages/projects/$PAGES_PROJECT/domains/$PROBE_HOST" >/dev/null 2>&1 || true
  cf_dns_guard "$rid" "$PROBE_HOST"
  cf_api DELETE "/zones/$ZID/dns_records/$rid" >/dev/null
  echo "done: probe cleaned up"
}

# ------------------------------------------------------------------- rules ----
phase_rules() {
  section "rules: apex -> www, 308, path + query preserved"
  ep="$($CURL_BIN -sS "$CF_API/zones/$ZID/rulesets/phases/http_request_dynamic_redirect/entrypoint" \
        -H "Authorization: Bearer $(cf_token)")"
  have="$(printf '%s' "$ep" | jq -r '.success')"
  rule="$(jq -n --arg h "$ZONE_NAME" --arg w "https://www.$ZONE_NAME" '{
    ref: "cfm_apex_to_www",
    description: "apex \($h) -> www (308, preserve query) [cf-migrate]",
    expression: "(http.host eq \"\($h)\")",
    action: "redirect",
    action_parameters: { from_value: {
      target_url: { expression: "concat(\"\($w)\", http.request.uri.path)" },
      status_code: 308,
      preserve_query_string: true } },
    enabled: true }')"

  # Exact host match only. A `contains` match would also catch app./demo./editor.
  printf '%s' "$rule" | jq -e '.expression | contains("eq")' >/dev/null \
    || die "refusing a redirect expression that is not an exact host match"

  if [ "$have" = "true" ]; then
    rsid="$(printf '%s' "$ep" | jq -r '.result.id')"
    n="$(printf '%s' "$ep" | jq '.result.rules | length // 0')"
    echo "  existing ruleset $rsid with $n rule(s) — APPENDING"
    # POST /rules appends. A PUT on the entrypoint would replace the whole rule
    # list and silently delete unrelated redirects.
    [ "$n" -lt 10 ] || die "$n dynamic redirects already exist (free plan allows 10)"
    if [ "$DRY_RUN" = 1 ]; then
      echo "WOULD: POST /zones/$ZID/rulesets/$rsid/rules"; printf '%s\n' "$rule" | jq .
      return 0
    fi
    out="$(cf_api POST "/zones/$ZID/rulesets/$rsid/rules" "$rule")"
  else
    echo "  no dynamic-redirect ruleset yet — creating the phase entrypoint"
    body="$(jq -n --argjson r "$rule" '{name:"Redirect rules ruleset",kind:"zone",phase:"http_request_dynamic_redirect",rules:[$r]}')"
    if [ "$DRY_RUN" = 1 ]; then
      echo "WOULD: POST /zones/$ZID/rulesets"; printf '%s\n' "$body" | jq .
      return 0
    fi
    out="$(cf_api POST "/zones/$ZID/rulesets" "$body")"
    rsid="$(printf '%s' "$out" | jq -r '.result.id')"
  fi

  rid="$(printf '%s' "$out" | jq -r '.result.rules[]? | select(.ref=="cfm_apex_to_www") | .id' | head -1)"
  jq -n --arg rs "$rsid" --arg r "$rid" '{ruleset_id:$rs,rule_id:$r}' \
    > "$STATE_DIR/state/redirect-rule.json"
  echo "  recorded ruleset=$rsid rule=$rid"
  echo
  echo "NOT verified yet, deliberately: the rule cannot fire until the apex record"
  echo "is proxied. --phase apex asserts it."
  echo "done: redirect rule created (inert)"
}

# -------------------------------------------------------------------- hsts ----
phase_hsts() {
  section "hsts: max-age 63072000 (matching what Vercel sends today)"
  cur="$(cf_api GET "/zones/$ZID/settings/security_header")"
  printf '%s' "$cur" | jq -c '.result.value' 2>/dev/null || true
  body='{"value":{"strict_transport_security":{"enabled":true,"max_age":63072000,"include_subdomains":false,"preload":false,"nosniff":true}}}'
  # include_subdomains / preload are effectively irreversible (browsers cache the
  # directive for the max-age, and preload lists are slow to leave). Refused.
  echo "  include_subdomains=false, preload=false — both deliberately off."
  echo "  Note this is ZONE-WIDE: cdn/app/demo/editor responses gain the header too."
  echo "  All are already HTTPS-only, so it is a no-op for them."
  dry "PATCH zone HSTS" -- true
  [ "$DRY_RUN" = 0 ] && cf_api PATCH "/zones/$ZID/settings/security_header" "$body" >/dev/null
  echo "done: HSTS enabled"
}

# -------------------------------------------------------------------- swap ----
phase_swap() {
  section "swap: www.$ZONE_NAME -> Pages"
  stamp_require 06-prod-deploy-parity

  # Refuse to cut DNS onto a deployment other than the one that was verified.
  want="$(jq -r '.deployment_id // "unknown"' "$STATE_DIR/stamps/06-prod-deploy-parity.$(ctx_hash)" 2>/dev/null \
          || grep -h '^deployment_id=' "$STATE_DIR/stamps/06-prod-deploy-parity.$(ctx_hash)" 2>/dev/null | cut -d= -f2)"
  have="$(cf_api GET "/accounts/$(cf_account)/pages/projects/$PAGES_PROJECT/deployments?per_page=1" \
          | jq -r '.result[0].id // "none"')"
  if [ -n "$want" ] && [ "$want" != unknown ] && [ "$want" != "$have" ]; then
    die "verified deployment ($want) is not the current production deployment ($have).
     Re-run 06-verify-deploy.sh --scope prod-deploy before cutting DNS."
  fi
  echo "  verified deployment == current production deployment ($have)"

  id="$(cf_dns_find "www.$ZONE_NAME" CNAME)"
  [ -n "$id" ] || die "no www CNAME found"
  cf_dns_guard "$id" "www.$ZONE_NAME"
  cur="$(cf_api GET "/zones/$ZID/dns_records/$id" | jq -r .result.content)"
  snap="$(jq -r --arg n "www.$ZONE_NAME" '.result[]|select(.name==$n and .type=="CNAME")|.content' "$SNAP" | head -1)"
  [ "$cur" = "$snap" ] || die "www currently points at '$cur' but the snapshot says '$snap' — someone else changed it. Stop and re-check."

  mode="$SWAP_MODE"
  if [ "$mode" = auto ]; then
    if [ -f "$STATE_DIR/state/attach-over-existing-record.ok" ]; then mode=update
    else mode=delete-create
      warn "no successful --phase probe result on record; falling back to delete-create"
      warn "that risks NODATA negative-caching for the SOA minimum. Run --phase probe first."
    fi
  fi
  echo "  swap mode: $mode"
  confirm_cutover

  if [ "$mode" = update ]; then
    dry "PATCH www -> $PAGES_PROJECT.pages.dev (proxied, atomic — no DNS gap)" -- true
    [ "$DRY_RUN" = 0 ] && cf_api PATCH "/zones/$ZID/dns_records/$id" \
      "$(jq -n --arg n "www.$ZONE_NAME" --arg c "$PAGES_PROJECT.pages.dev" \
         '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1,comment:"Pages custom domain [cf-migrate]"}')" >/dev/null
  else
    dry "DELETE www record, then immediately attach (leaves a brief NODATA window)" -- true
    [ "$DRY_RUN" = 0 ] && cf_api DELETE "/zones/$ZID/dns_records/$id" >/dev/null
  fi

  dry "POST pages custom domain www.$ZONE_NAME" -- true
  if [ "$DRY_RUN" = 0 ]; then
    cf_api POST "/accounts/$(cf_account)/pages/projects/$PAGES_PROJECT/domains" \
      "$(jq -n --arg n "www.$ZONE_NAME" '{name:$n}')" >/dev/null 2>&1 \
      || warn "attach returned an error — it may already be attached; checking status"
    for _ in $(seq 1 60); do
      s="$(cf_pages_domains | jq -r --arg n "www.$ZONE_NAME" '.result[]|select(.name==$n)|.status' | head -1)"
      echo "  domain status: ${s:-<absent>}"
      [ "$s" = active ] && break
      sleep 5
    done
    # Host-header probe: proves the edge routes the hostname to Pages regardless
    # of what any resolver currently caches.
    hp="$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: www.$ZONE_NAME" \
           "https://$PAGES_PROJECT.pages.dev/" 2>/dev/null || echo 000)"
    echo "  host-header probe via pages.dev: $hp"
  fi

  echo
  echo "done: www swapped. Next: --phase apex, then 08-verify-prod.sh"
}

# -------------------------------------------------------------------- apex ----
phase_apex() {
  section "apex: $ZONE_NAME -> proxied placeholder (activates the redirect rule)"
  # Order matters: a proxied apex pointing at TEST-NET with no rule serves 522s.
  [ -s "$STATE_DIR/state/redirect-rule.json" ] \
    || die "no redirect rule recorded — run --phase rules first, or the apex will 522"
  rsid="$(jq -r .ruleset_id "$STATE_DIR/state/redirect-rule.json")"
  rid="$(jq -r .rule_id "$STATE_DIR/state/redirect-rule.json")"
  en="$(cf_api GET "/zones/$ZID/rulesets/$rsid" | jq -r --arg r "$rid" '.result.rules[]|select(.id==$r)|.enabled')"
  [ "$en" = "true" ] || die "redirect rule $rid is not enabled — refusing to proxy the apex"
  echo "  redirect rule $rid is enabled"

  id="$(cf_dns_find "$ZONE_NAME" CNAME)"
  [ -n "$id" ] || id="$(cf_dns_find "$ZONE_NAME" A)"
  [ -n "$id" ] || die "no apex record found"
  cf_dns_guard "$id" "$ZONE_NAME"
  before="$(cf_api GET "/zones/$ZID/dns_records/$id" | jq -c '{type:.result.type,content:.result.content,proxied:.result.proxied}')"
  echo "  before: $before"

  # A single PUT changes CNAME -> A atomically; no delete/create gap.
  dry "PUT apex -> A 192.0.2.0 proxied (placeholder; requests never reach it)" -- true
  if [ "$DRY_RUN" = 1 ]; then echo; echo "done: (dry run)"; return 0; fi
  cf_api PUT "/zones/$ZID/dns_records/$id" \
    "$(jq -n --arg n "$ZONE_NAME" \
       '{type:"A",name:$n,content:"192.0.2.0",proxied:true,ttl:1,comment:"placeholder for apex->www redirect rule [cf-migrate]"}')" >/dev/null

  section "verifying the 308 (auto-rollback armed)"
  ok=1
  for _ in $(seq 1 12); do
    if assert_apex_redirect "$APEX_BASE" >/dev/null 2>&1; then ok=0; break; fi
    sleep 5
  done
  if [ "$ok" != 0 ]; then
    warn "apex redirect did not come up — rolling the apex record back"
    cf_api PUT "/zones/$ZID/dns_records/$id" \
      "$(jq -n --arg n "$ZONE_NAME" --arg c "$VERCEL_DNS_TARGET" \
         '{type:"CNAME",name:$n,content:$c,proxied:false,ttl:60}')" >/dev/null
    die "apex rolled back to Vercel. Investigate the redirect rule, then retry."
  fi
  assert_apex_redirect "$APEX_BASE"
  echo "done: apex 308s to www"
}

case "$PHASE" in
  prelower) phase_prelower ;;
  probe)    phase_probe ;;
  rules)    phase_rules ;;
  hsts)     phase_hsts ;;
  swap)     phase_swap ;;
  apex)     phase_apex ;;
  *) die "unknown phase '$PHASE' (prelower|probe|rules|hsts|swap|apex)" ;;
esac
