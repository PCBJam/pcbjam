#!/usr/bin/env bash
# Shared plumbing for the deploy/site cf-migrate scripts: paths, logging,
# dry-run, stamps and guards. Sourced, never executed.
#
# bash 3.2 compatible (/usr/bin/env bash on macOS is 3.2.57): no associative
# arrays, no `mapfile`, no ${x,,}. Accumulators use temp files.

# Repo + site paths. Every script cd's to SITE_DIR before building or deploying:
# `wrangler pages deploy` discovers Functions at $PWD/functions, so running from
# the wrong directory silently ships a static-only site with /api/waitlist 404ing.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SITE_DIR="$(dirname "$LIB_DIR")"
PCBJAM_DIR="$(cd "$DEPLOY_SITE_DIR/../.." && pwd)"
SITE_DIR="$PCBJAM_DIR/site"
STATE_DIR="$SITE_DIR/.cf-migrate"

# Defaults, overridable by env.
PAGES_PROJECT="${PAGES_PROJECT:-pcbjam-site}"
PAGES_PROD_BRANCH="${PAGES_PROD_BRANCH:-production}"
ZONE_NAME="${ZONE_NAME:-pcbjam.com}"
PROD_BASE="${PROD_BASE:-https://www.pcbjam.com}"
APEX_BASE="${APEX_BASE:-https://pcbjam.com}"
VERCEL_PROJECT="${VERCEL_PROJECT:-pcbjam}"
VERCEL_TEAM="${VERCEL_TEAM:-pcbj-am}"
VERCEL_DNS_TARGET="${VERCEL_DNS_TARGET:-dcfb2907091b7240.vercel-dns-016.com}"
# How the apex behaves. Two supported topologies:
#   serve    (default) apex is a SECOND Pages custom domain and serves 200. No
#            redirect rule, no placeholder record — the same two clicks as any
#            other host. Pages still emit canonical=www so search consolidates.
#   redirect apex 308s to www via a zone Redirect Rule + proxied placeholder
#            record. This is what Vercel did, and needs zone DNS/rules scopes.
APEX_MODE="${APEX_MODE:-serve}"
WRANGLER="${WRANGLER_CMD:-npx --yes wrangler@4}"

mkdir -p "$STATE_DIR/state" "$STATE_DIR/stamps" "$STATE_DIR/baseline" "$STATE_DIR/logs"

section() { echo; echo "== $* =="; }
warn()    { echo "warn: $*" >&2; }
die()     { echo "cf-migrate: $*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
  done
}

# Refuse to run under `set -x` where secrets would land in the log.
no_xtrace() {
  case "$-" in
    *x*) die "refusing to run under 'set -x' (secrets would be echoed)" ;;
  esac
}

# Identity of "the thing that was verified" — the inputs that affect the built
# output. Stamps are keyed on this so a stamp can never vouch for a later edit.
ctx_hash() {
  ( cd "$SITE_DIR" && \
    find src public functions astro.config.mjs package.json package-lock.json \
         wrangler.toml -type f 2>/dev/null \
    | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 2>/dev/null \
    | shasum -a 256 | cut -c1-16 )
}

stamp_write() {
  _name="$1"; shift
  _f="$STATE_DIR/stamps/${_name}.$(ctx_hash)"
  {
    echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ctx=$(ctx_hash)"
    echo "git=$(git -C "$PCBJAM_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
    for kv in "$@"; do echo "$kv"; done
  } > "$_f"
  echo "stamped: ${_name} (ctx=$(ctx_hash))"
}

# Dies unless a stamp for the CURRENT ctx_hash exists and is fresh.
# CFM_FORCE=1 downgrades to a loud warning; it also requires CFM_I_UNDERSTAND=1.
stamp_require() {
  _name="$1"; _max_h="${2:-${STAMP_MAX_AGE_H:-24}}"
  _f="$STATE_DIR/stamps/${_name}.$(ctx_hash)"
  if [ ! -f "$_f" ]; then
    if [ "${CFM_FORCE:-0}" = 1 ] && [ "${CFM_I_UNDERSTAND:-0}" = 1 ]; then
      warn "BYPASS: no '${_name}' stamp for the current tree, continuing anyway"
      return 0
    fi
    die "no '${_name}' stamp for the current tree (ctx=$(ctx_hash)).
     The site changed since it was last verified. Run the matching script first:
       ${_name} -> see deploy/site/README.md
     To override (not advised): CFM_FORCE=1 CFM_I_UNDERSTAND=1 $0 ..."
  fi
  _age=$(( ( $(date +%s) - $(stat -f %m "$_f" 2>/dev/null || echo 0) ) / 3600 ))
  if [ "$_age" -ge "$_max_h" ]; then
    if [ "${CFM_FORCE:-0}" = 1 ] && [ "${CFM_I_UNDERSTAND:-0}" = 1 ]; then
      warn "BYPASS: '${_name}' stamp is ${_age}h old (max ${_max_h}h), continuing"
      return 0
    fi
    die "'${_name}' stamp is ${_age}h old (max ${_max_h}h) — re-verify."
  fi
}

# --- dry run ---------------------------------------------------------------
# DRY_RUN=1 is the DEFAULT for every mutating script. `--apply` clears it.
DRY_RUN="${DRY_RUN:-1}"

parse_common_flags() {
  CFM_ARGS=""
  for a in "$@"; do
    case "$a" in
      --apply)    DRY_RUN=0 ;;
      --dry-run)  DRY_RUN=1 ;;
      --yes)      CFM_YES=1 ;;
      *)          CFM_ARGS="$CFM_ARGS $a" ;;
    esac
  done
}

# dry "<label>" -- cmd...   → prints WOULD in dry-run, else runs.
dry() {
  _label="$1"; shift
  [ "$1" = "--" ] && shift
  if [ "$DRY_RUN" = 1 ]; then
    echo "WOULD: $_label"
    echo "     \$ $*"
    return 0
  fi
  echo "RUN:   $_label"
  "$@"
}

confirm_cutover() {
  [ "${CFM_YES:-0}" = 1 ] && return 0
  echo
  echo "This mutates PRODUCTION DNS for $ZONE_NAME."
  printf 'Type CUTOVER to proceed: '
  read -r _reply
  [ "$_reply" = "CUTOVER" ] || die "aborted (got '$_reply')"
}

dry_banner() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "(dry run — nothing will be changed. re-run with --apply to act.)"
  fi
}
