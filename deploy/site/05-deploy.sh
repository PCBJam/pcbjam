#!/usr/bin/env bash
# Build and upload to Cloudflare Pages. Touches no DNS — after this the site is
# live only on *.pages.dev, which is what makes the whole migration safe to
# rehearse.
#
#   deploy/site/05-deploy.sh --preview              # dry run
#   deploy/site/05-deploy.sh --preview --apply
#   deploy/site/05-deploy.sh --production --apply
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

require_cmd npx jq

TARGET=""; SKIP_BUILD=0
parse_common_flags "$@"
set -- $CFM_ARGS
while [ $# -gt 0 ]; do
  case "$1" in
    --preview)    TARGET=preview; shift ;;
    --production) TARGET=production; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    "") shift ;;
    *) die "unknown arg: $1" ;;
  esac
done
[ -n "$TARGET" ] || die "pass --preview or --production"
dry_banner

# The gate. The stamp is keyed on a hash of src/, public/, functions/ and the
# configs, so it cannot vouch for a tree that has been edited since.
stamp_require 02-local-parity

BRANCH="$PAGES_PROD_BRANCH"
[ "$TARGET" = preview ] && BRANCH="cf-migrate-preview"

cd "$SITE_DIR"
if [ "$SKIP_BUILD" = 0 ]; then
  section "build"
  npm run build
fi
[ -e dist/404.html ] || die "dist/404.html missing — deploying would create a soft-404 (homepage at 200 on every unknown URL)"
[ -e dist/_headers ] || die "dist/_headers missing — the Gerber viewer would lose cross-origin isolation"
[ -f functions/api/waitlist.ts ] || die "functions/api/waitlist.ts missing"

section "deploy ($TARGET, branch=$BRANCH)"
# Run from $SITE_DIR so wrangler reads site/wrangler.toml (pages_build_output_dir
# + nodejs_compat) AND discovers site/functions/. Deploying from the repo root
# would upload the static files and silently omit the Function.
LOG="$STATE_DIR/logs/deploy-$(date +%s).log"
if [ "$DRY_RUN" = 1 ]; then
  echo "WOULD: (cd $SITE_DIR && $WRANGLER pages deploy --project-name $PAGES_PROJECT --branch $BRANCH --commit-dirty=true)"
  echo; echo "done: (dry run) nothing deployed"
  exit 0
fi

$WRANGLER pages deploy \
  --project-name "$PAGES_PROJECT" \
  --branch "$BRANCH" \
  --commit-dirty=true 2>&1 | tee "$LOG"

URL="$(grep -Eo 'https://[a-z0-9-]+\.'"$PAGES_PROJECT"'\.pages\.dev' "$LOG" | tail -1 || true)"
[ -n "$URL" ] || URL="$(grep -Eo 'https://[^ ]*\.pages\.dev' "$LOG" | tail -1 || true)"
[ -n "$URL" ] || die "could not determine the deployment URL — see $LOG"

printf '{"url":"%s","branch":"%s","target":"%s","ctx":"%s"}\n' \
  "$URL" "$BRANCH" "$TARGET" "$(ctx_hash)" > "$STATE_DIR/state/last-deploy.json"

section "done"
echo "Verify it before any DNS moves:"
echo "  deploy/site/06-verify-deploy.sh --url $URL$([ "$TARGET" = production ] && echo ' --scope prod-deploy')"
echo "done: $URL"
