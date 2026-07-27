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
row="$($WRANGLER pages project list --json 2>/dev/null \
        | jq -r --arg n "$PAGES_PROJECT" '.[] | select(."Project Name"==$n)')"
if [ -n "$row" ]; then
  echo "exists already"
else
  dry "create Pages project $PAGES_PROJECT (production branch: $PAGES_PROD_BRANCH)" -- \
    $WRANGLER pages project create "$PAGES_PROJECT" \
      --production-branch "$PAGES_PROD_BRANCH" \
      --compatibility-date 2026-06-01 --compatibility-flags nodejs_compat
  [ "$DRY_RUN" = 1 ] && { echo; echo "done: (dry run) would create $PAGES_PROJECT"; exit 0; }
  row="$($WRANGLER pages project list --json 2>/dev/null \
          | jq -r --arg n "$PAGES_PROJECT" '.[] | select(."Project Name"==$n)')"
  [ -n "$row" ] || die "project still not listed after create"
fi

section "asserting settings"
# `wrangler pages project list` reports the Git provider but not the production
# branch, and the REST endpoint that would needs an API token. So prove the branch
# EMPIRICALLY instead, from the deployments: if a deployment on $PAGES_PROD_BRANCH
# is labelled Production, the project's production branch is that branch. That is
# a stronger check than reading the setting.
src="$(printf '%s' "$row" | jq -r '."Git Provider" // "?"')"
dom="$(printf '%s' "$row" | jq -r '."Project Domains" // "?"')"

if [ "$src" != "No" ]; then
  die "project appears Git-connected (Git Provider: $src). Cloudflare's own builds
     would race the uploads from deploy-site.yml. Disconnect it in the dashboard."
fi
echo "  ok  Direct Upload (not Git-connected)"

prod="$($WRANGLER pages deployment list --project-name "$PAGES_PROJECT" \
          --environment production --json 2>/dev/null || true)"
nprod="$(printf '%s' "$prod" | jq 'length' 2>/dev/null || echo 0)"
if [ "${nprod:-0}" -gt 0 ]; then
  br="$(printf '%s' "$prod" | jq -r '.[0].Branch // "?"')"
  env="$(printf '%s' "$prod" | jq -r '.[0].Environment // "?"')"
  # The most expensive mistake available here: if the project's production branch
  # is not what deploy-site.yml passes to --branch, every deploy lands as a
  # PREVIEW and the live site silently never updates (see deploy-demo.yml).
  if [ "$br" = "$PAGES_PROD_BRANCH" ] && [ "$env" = "Production" ]; then
    echo "  ok  branch '$br' deploys land as $env"
  else
    die "latest production-environment deployment is branch='$br' env='$env',
     but deploys use --branch '$PAGES_PROD_BRANCH'. If those disagree, every deploy
     becomes a preview and www.pcbjam.com never updates. Fix it in
     Pages -> $PAGES_PROJECT -> Settings -> Builds & deployments."
  fi
else
  warn "no production deployment yet — the branch check runs after 05-deploy.sh"
fi
sub="$(printf '%s' "$dom" | sed 's/,.*//')"

section "done"
echo "note: the custom domain is NOT set here — there is no 'wrangler pages domain'"
echo "      subcommand. 07-dns-cutover.sh attaches www.pcbjam.com via the API,"
echo "      which needs a real API token (wrangler's OAuth login is zone:read only)."
echo "done: https://${sub}"
