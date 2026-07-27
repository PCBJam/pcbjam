#!/usr/bin/env bash
# Shared plumbing for the site verification scripts: paths, config, logging.
# Sourced, never executed.
#
# bash 3.2 compatible (/usr/bin/env bash on macOS is 3.2.57): no associative
# arrays, no `mapfile`, no ${x,,}. Accumulators use temp files.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SITE_DIR="$(dirname "$LIB_DIR")"
PCBJAM_DIR="$(cd "$DEPLOY_SITE_DIR/../.." && pwd)"
SITE_DIR="$PCBJAM_DIR/site"

# Defaults, all overridable by env — which is how you point the sweep at a
# preview deployment instead of production:
#   PROD_BASE=https://abc123.pcbjam-site.pages.dev deploy/site/verify.sh
PAGES_PROJECT="${PAGES_PROJECT:-pcbjam-site}"
ZONE_NAME="${ZONE_NAME:-pcbjam.com}"
PROD_BASE="${PROD_BASE:-https://www.pcbjam.com}"
APEX_BASE="${APEX_BASE:-https://pcbjam.com}"
WRANGLER="${WRANGLER_CMD:-npx --yes wrangler@4}"

# How the apex behaves.
#   serve    (current) the apex is a SECOND Pages custom domain and answers 200.
#            No redirect rule, no placeholder record. The pages emit
#            canonical=www, which is what consolidates the two hosts for search.
#   redirect the apex 308s to www. Kept because the assertion is cheap to keep
#            and the decision could be revisited; nothing sets it up any more.
APEX_MODE="${APEX_MODE:-serve}"

section() { echo; echo "== $* =="; }
warn()    { echo "warn: $*" >&2; }
die()     { echo "verify: $*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
  done
}
