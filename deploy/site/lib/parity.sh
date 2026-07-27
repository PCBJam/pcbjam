#!/usr/bin/env bash
# The one HTTP parity sweep. Sourced by the verify scripts and run against four
# bases, so "did anything change?" is always the same question:
#
#   https://www.pcbjam.com                  live Vercel (baseline)
#   http://127.0.0.1:8788                   wrangler pages dev
#   https://<hash>.pcbjam-site.pages.dev    the Pages deployment, pre-DNS
#   https://www.pcbjam.com                  after cutover
#
# Usage:  assert_parity <base-url> [--scope local|preview|prod] [--live-post]
# Exit:   0 if every hard assertion passed (warnings do not fail), else 1.

CURL="curl -sS --max-time 20"

# --- the two primitives ----------------------------------------------------
# Deliberately split. _trace follows redirects to learn WHERE we land; _headers
# then re-fetches that exact URL WITHOUT -L so there is exactly one response to
# parse. Asserting on a multi-block `-IL` dump is precisely how the COOP/COEP
# regression stayed hidden on Vercel: the headers were on the redirect hop, not
# on the document.
_trace() { # _trace URL -> "eff_url<TAB>status<TAB>hops"
  $CURL -L -o /dev/null -w '%{url_effective}\t%{http_code}\t%{num_redirects}' "$1" 2>/dev/null
}

_headers() { # _headers URL [extra curl args...] -> "name: value" lines, name lowercased
  $CURL -D - -o /dev/null "$@" 2>/dev/null | tr -d '\r' | awk '
    /^HTTP\/[0-9.]+ [0-9][0-9][0-9]/ { buf=""; next }   # reset on each block; keep the last
    NF==0 { next }
    { i=index($0,":"); if(i){ k=tolower(substr($0,1,i-1)); v=substr($0,i+1);
        sub(/^[ \t]+/,"",v); buf = buf k ": " v "\n" } }
    END { printf "%s", buf }'
}

_hdr() { # _hdr "<headers>" name -> value ("" if absent)
  printf '%s\n' "$1" | awk -v k="$2: " 'index($0,k)==1 { print substr($0, length(k)+1); exit }'
}

_title() { $CURL -L "$1" 2>/dev/null | tr -d '\n' | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p'; }

# --- result accumulation (bash 3.2: temp file, not an array) ---------------
_P_RESULTS=""
_p_init() { _P_RESULTS="$(mktemp -t cfmparity)"; }
_p_add()  { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$_P_RESULTS"; }
pass() { _p_add PASS "$1" "${2:-}" "${3:-}"; }
fail() { _p_add FAIL "$1" "${2:-}" "${3:-}"; }
soft() { _p_add WARN "$1" "${2:-}" "${3:-}"; }

# assert_status <probe> <url> <expected>
_expect_page() { # _expect_page <probe> <base> <path>
  _pr="$1"; _b="$2"; _path="$3"
  _t="$(_trace "$_b$_path")"
  _eff="$(printf '%s' "$_t" | cut -f1)"; _st="$(printf '%s' "$_t" | cut -f2)"
  _hops="$(printf '%s' "$_t" | cut -f3)"
  _effpath="$(printf '%s' "$_eff" | sed -e 's|^[a-z]*://[^/]*||' -e 's|?.*$||')"
  _h="$(_headers "$_eff")"
  _ct="$(_hdr "$_h" content-type)"
  # Hard: final 200, landed on the requested path (+/- a trailing slash), HTML.
  # Trailing-slash HOPS are recorded, never failed on: Vercel serves both forms
  # at 200; Pages 308s the bare form to the slash form. Both are fine. What is
  # NOT fine is landing somewhere else — that is how a soft-404 shows up.
  if [ "$_st" != "200" ]; then fail "$_pr" "$_hops" "expected 200, got $_st"; return; fi
  case "$_effpath" in
    "$_path"|"$_path/") : ;;
    *) fail "$_pr" "$_hops" "landed on '$_effpath', expected '$_path'"; return ;;
  esac
  case "$_ct" in
    text/html*) : ;;
    *) fail "$_pr" "$_hops" "content-type '$_ct'"; return ;;
  esac
  pass "$_pr" "$_hops" "200 $_effpath"
}

_expect_coi() { # _expect_coi <probe> <base> <path>   (cross-origin isolated)
  _pr="$1"; _b="$2"; _path="$3"
  _t="$(_trace "$_b$_path")"; _eff="$(printf '%s' "$_t" | cut -f1)"
  _hops="$(printf '%s' "$_t" | cut -f3)"
  _h="$(_headers "$_eff")"
  _coop="$(_hdr "$_h" cross-origin-opener-policy)"
  _coep="$(_hdr "$_h" cross-origin-embedder-policy)"
  if [ "$_coop" = "same-origin" ] && [ "$_coep" = "require-corp" ]; then
    pass "$_pr" "$_hops" "COOP+COEP on $_eff"
  else
    fail "$_pr" "$_hops" "coop='${_coop:-absent}' coep='${_coep:-absent}' on $_eff"
  fi
}

_expect_not_coi() { # the landing page MUST NOT be isolated
  _pr="$1"; _b="$2"; _path="$3"
  _t="$(_trace "$_b$_path")"; _eff="$(printf '%s' "$_t" | cut -f1)"
  _h="$(_headers "$_eff")"
  _coep="$(_hdr "$_h" cross-origin-embedder-policy)"
  if [ -z "$_coep" ]; then
    pass "$_pr" "-" "not isolated (correct — YouTube hero embed)"
  else
    fail "$_pr" "-" "COEP '$_coep' present; a require-corp landing page cannot load the YouTube embed"
  fi
}

assert_parity() {
  _base="${1:?usage: assert_parity <base-url> [--scope local|preview|prod] [--live-post]}"
  shift
  _scope=preview; _live_post=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --scope) _scope="$2"; shift 2 ;;
      --live-post) _live_post=1; shift ;;
      *) shift ;;
    esac
  done
  _base="$(printf '%s' "$_base" | sed 's|/*$||')"
  _p_init
  section "parity sweep: $_base (scope=$_scope)"

  # 1) pages
  for p in / /pricing /blog /privacy /terms /cookies /licenses; do
    _n="$(printf '%s' "$p" | sed 's|^/||')"; [ -z "$_n" ] && _n=home
    _expect_page "$_n" "$_base" "$p"
  done

  # 2) cross-origin isolation, asserted on the FINAL response.
  # BOTH URL forms of the blog post are probed on purpose. Vercel serves the bare
  # form at 200 with the headers and the TRAILING-SLASH form at 200 WITHOUT them —
  # and the trailing-slash form is the page's own canonical, i.e. what search
  # sends people to. So post_coi passes on Vercel while post_coi_slash fails; that
  # asymmetry IS the bug, and probing only one form would hide it.
  _expect_coi     post_coi       "$_base" /blog/porting-kicad-graphics-to-webgl-in-2026
  _expect_coi     post_coi_slash "$_base" /blog/porting-kicad-graphics-to-webgl-in-2026/
  _expect_coi     gerber_boot    "$_base" /gerber-demo/boot.js
  _expect_not_coi landing_iso    "$_base" /

  # 3) immutable asset caching
  _asset="$($CURL -L "$_base/" 2>/dev/null | tr '"' '\n' | grep -m1 '^/_astro/[^ ]*\.css$' || true)"
  if [ -n "$_asset" ]; then
    _cc="$(_hdr "$(_headers "$_base$_asset")" cache-control)"
    case "$_cc" in
      *immutable*) pass astro_cache - "$_cc" ;;
      *) soft astro_cache - "cache-control='${_cc:-absent}'" ;;
    esac
  else
    soft astro_cache - "no hashed css found on /"
  fi

  # 4) the waitlist endpoint
  # Preflight from the allowlisted demo origin. hops MUST be 0: a CORS preflight
  # cannot follow a redirect, so this is the check that guards demo.pcbjam.com's
  # entire waitlist integration.
  _pre="$($CURL -o /dev/null -D - -X OPTIONS "$_base/api/waitlist" \
            -H 'Origin: https://demo.pcbjam.com' \
            -H 'Access-Control-Request-Method: POST' \
            -H 'Access-Control-Request-Headers: content-type' 2>/dev/null | tr -d '\r')"
  _pre_st="$(printf '%s' "$_pre" | awk '/^HTTP/{c=$2} END{print c}')"
  _pre_h="$(_headers "$_base/api/waitlist" -X OPTIONS -H 'Origin: https://demo.pcbjam.com')"
  _acao="$(_hdr "$_pre_h" access-control-allow-origin)"
  _hops0="$($CURL -o /dev/null -w '%{num_redirects}' -X OPTIONS "$_base/api/waitlist" \
              -H 'Origin: https://demo.pcbjam.com' 2>/dev/null)"
  if [ "$_pre_st" = "204" ] && [ "$_acao" = "https://demo.pcbjam.com" ] && [ "$_hops0" = "0" ]; then
    pass api_preflight "$_hops0" "204 acao=$_acao"
  else
    fail api_preflight "$_hops0" "status=$_pre_st acao='${_acao:-absent}' hops=$_hops0 (all of 204/echoed-origin/0-hops required)"
  fi

  _deny_h="$(_headers "$_base/api/waitlist" -X OPTIONS -H 'Origin: https://not-allowed.example')"
  if [ -z "$(_hdr "$_deny_h" access-control-allow-origin)" ]; then
    pass api_cors_deny - "no CORS for a non-allowlisted origin"
  else
    fail api_cors_deny - "CORS granted to https://not-allowed.example"
  fi

  _gst="$($CURL -o /dev/null -w '%{http_code}' "$_base/api/waitlist" 2>/dev/null)"
  [ "$_gst" = "405" ] && pass api_get - "405" || fail api_get - "expected 405, got $_gst"

  _bad="$($CURL -o /dev/null -w '%{http_code}' -X POST "$_base/api/waitlist" \
            -H 'content-type: application/json' --data '{"email":"nope"}' 2>/dev/null)"
  [ "$_bad" = "400" ] && pass api_invalid_email - "400" || fail api_invalid_email - "expected 400, got $_bad"

  # The honeypot branch returns BEFORE validation, BEFORE the rate limiter and
  # BEFORE any Resend call, so this exercises the whole request path (routing,
  # Functions bundling, body parsing, CORS) with zero side effects — safe to run
  # against production.
  _hp="$($CURL -X POST "$_base/api/waitlist" -H 'content-type: application/json' \
           -H 'Origin: https://demo.pcbjam.com' \
           --data '{"email":"parity@pcbjam.com","company_url":"bot","source":"cfm-parity"}' \
           -w '\n%{http_code}' 2>/dev/null)"
  _hp_st="$(printf '%s' "$_hp" | tail -1)"
  case "$_hp" in
    *'"ok":true'*) [ "$_hp_st" = "200" ] && pass api_honeypot - "200 ok:true" \
                     || fail api_honeypot - "ok:true but status $_hp_st" ;;
    *) fail api_honeypot - "status=$_hp_st body did not contain ok:true" ;;
  esac

  # No-JS native form submit -> 303 back to the page. The same-origin Origin
  # header is required, not cosmetic: a real browser form submit sends it, and
  # both Vercel's edge and (post-migration) the Function itself refuse a
  # form-encoded POST that carries a foreign Origin. Omitting it here gets a 403
  # and looks like a broken endpoint.
  _form="$($CURL -o /dev/null -D - -X POST "$_base/api/waitlist" \
             -H "Origin: $_base" \
             --data-urlencode 'email=parity@pcbjam.com' \
             --data-urlencode 'company_url=bot' 2>/dev/null | tr -d '\r')"
  _form_st="$(printf '%s' "$_form" | awk '/^HTTP/{c=$2} END{print c}')"
  _loc="$(printf '%s' "$_form" | awk 'tolower($1)=="location:"{print $2}' | tail -1)"
  if [ "$_form_st" = "303" ] && [ "$_loc" = "/?waitlist=ok#waitlist" ]; then
    pass api_form_303 - "303 -> $_loc"
  else
    fail api_form_303 - "status=$_form_st location='${_loc:-absent}'"
  fi

  # Cross-site form POST must be refused. Vercel's edge did this for free; the
  # Function reproduces it, so this probe must pass on BOTH platforms.
  _csrf="$($CURL -o /dev/null -w '%{http_code}' -X POST "$_base/api/waitlist" \
             -H 'Origin: https://evil.example' \
             --data-urlencode 'email=parity@pcbjam.com' 2>/dev/null || true)"
  [ "$_csrf" = "403" ] && pass api_form_csrf - "403 cross-site form POST refused" \
    || fail api_form_csrf - "expected 403, got $_csrf (cross-site form POST is a CSRF vector)"

  if [ "$_live_post" = 1 ]; then
    _live="$($CURL -X POST "$_base/api/waitlist" -H 'content-type: application/json' \
               --data '{"email":"cfm-live@example.com","source":"cfm-parity"}' \
               -w '\n%{http_code}' 2>/dev/null)"
    _live_st="$(printf '%s' "$_live" | tail -1)"
    # 200 = accepted (no key configured); 502 = the Resend SDK loaded and the API
    # rejected our (bogus) key. Both prove the module resolved under workerd.
    case "$_live_st" in
      200|502) pass api_live_post - "status=$_live_st (SDK loaded)" ;;
      *) fail api_live_post - "expected 200 or 502, got $_live_st — likely a module-resolution error (nodejs_compat?)" ;;
    esac
  fi

  # 5) a real 404, not the homepage at 200
  _nf_url="$_base/__cfm-parity-404__/"
  _nf_st="$($CURL -L -o /dev/null -w '%{http_code}' "$_nf_url" 2>/dev/null)"
  _nf_title="$(_title "$_nf_url")"
  _home_title="$(_title "$_base/")"
  if [ "$_nf_st" != "404" ]; then
    fail notfound - "expected 404, got $_nf_st (a 200 here is a soft-404 serving the homepage)"
  elif [ -n "$_home_title" ] && [ "$_nf_title" = "$_home_title" ]; then
    fail notfound - "404 status but the homepage document was served"
  else
    pass notfound - "404 '$_nf_title'"
  fi

  # 6) prod-only
  if [ "$_scope" = prod ]; then
    _hsts="$(_hdr "$(_headers "$_base/")" strict-transport-security)"
    case "$_hsts" in
      *max-age=63072000*) pass hsts - "$_hsts" ;;
      "") fail hsts - "absent (Vercel sent max-age=63072000)" ;;
      *) soft hsts - "$_hsts (differs from the Vercel baseline)" ;;
    esac
  fi

  # --- report -------------------------------------------------------------
  printf '\n%-6s %-18s %-5s %s\n' STATUS PROBE HOPS DETAIL
  awk -F'\t' '{ printf "%-6s %-18s %-5s %s\n", $1, $2, ($3==""?"-":$3), $4 }' "$_P_RESULTS"
  _np=$(grep -c '^PASS' "$_P_RESULTS" || true)
  _nf=$(grep -c '^FAIL' "$_P_RESULTS" || true)
  _nw=$(grep -c '^WARN' "$_P_RESULTS" || true)
  echo
  echo "$(( _np + _nf + _nw )) probes: ${_np} pass, ${_nf} fail, ${_nw} warn"
  rm -f "$_P_RESULTS"
  if [ "$_nf" -gt 0 ]; then echo "parity: FAIL (${_nf})"; return 1; fi
  echo "parity: PASS"; return 0
}

# Apex -> www redirect, path + query preserved. Prod only.
assert_apex_redirect() {
  _apex="${1:-$APEX_BASE}"
  section "apex redirect: $_apex"
  _rc=0
  for pair in "/:https://www.pcbjam.com/" "/pricing?a=1&b=2:https://www.pcbjam.com/pricing?a=1&b=2"; do
    _path="${pair%%:*}"; _want="${pair#*:}"
    _h="$($CURL -o /dev/null -D - "$_apex$_path" 2>/dev/null | tr -d '\r')"
    _st="$(printf '%s' "$_h" | awk '/^HTTP/{c=$2} END{print c}')"
    _loc="$(printf '%s' "$_h" | awk 'tolower($1)=="location:"{print $2}' | tail -1)"
    if [ "$_st" = "308" ] && [ "$_loc" = "$_want" ]; then
      echo "PASS   $_apex$_path -> 308 $_loc"
    else
      echo "FAIL   $_apex$_path -> status=$_st location='${_loc:-absent}' (wanted 308 $_want)"; _rc=1
    fi
  done
  return $_rc
}
