#!/usr/bin/env bash
# Idempotently ensure the Cloudflare Pages project exists with the right
# production branch and compatibility settings.
#
#   deploy/site/03-ensure-project.sh            # dry run
#   deploy/site/03-ensure-project.sh --apply
#
# Naming this "ensure" rather than "create" is the contract: running it twice is
# normal and must not look like an error.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/cf-api.sh"

require_cmd curl jq npx
parse_common_flags "$@"
dry_banner

section "project $PAGES_PROJECT"
if existing="$(cf_pages_project 2>/dev/null)"; then
  echo "exists already"
else
  existing=""
  dry "create Pages project $PAGES_PROJECT (production branch: $PAGES_PROD_BRANCH)" -- \
    $WRANGLER pages project create "$PAGES_PROJECT" \
      --production-branch "$PAGES_PROD_BRANCH" \
      --compatibility-date 2026-06-01 --compatibility-flags nodejs_compat
  [ "$DRY_RUN" = 1 ] && { echo; echo "done: (dry run) would create $PAGES_PROJECT"; exit 0; }
  existing="$(cf_pages_project)"
fi

section "asserting settings"
pb="$(printf '%s' "$existing" | jq -r '.result.production_branch // "?"')"
src="$(printf '%s' "$existing" | jq -r '.result.source // "null"')"
sub="$(printf '%s' "$existing" | jq -r '.result.subdomain // "?"')"

# The single most expensive mistake available here: if the project's production
# branch is anything other than what deploy-site.yml passes to --branch, every
# deploy lands as a PREVIEW and the live site silently never updates. The same
# warning is written into deploy-demo.yml.
if [ "$pb" != "$PAGES_PROD_BRANCH" ]; then
  die "production_branch is '$pb' but deploys use '$PAGES_PROD_BRANCH'.
     Every deploy would land as a preview and www.pcbjam.com would never update.
     Fix it in Pages -> $PAGES_PROJECT -> Settings -> Builds & deployments, then re-run.
     (This script will NOT change it: doing so retroactively re-labels deployments.)"
fi
echo "  ok  production_branch = $pb"

if [ "$src" != "null" ]; then
  die "project is Git-connected (source: $src). Cloudflare's own builds would race
     the uploads from deploy-site.yml. Disconnect it in the dashboard first."
fi
echo "  ok  Direct Upload (not Git-connected)"

section "done"
echo "note: the custom domain is NOT set here — there is no 'wrangler pages domain'"
echo "      subcommand. 07-dns-cutover.sh attaches www.pcbjam.com via the API."
echo "done: https://${sub}.pages.dev"
