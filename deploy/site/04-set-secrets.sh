#!/usr/bin/env bash
# Put the three waitlist secrets into the Pages project, for BOTH the production
# and preview environments, without ever printing a value.
#
#   deploy/site/04-set-secrets.sh --prompt --apply
#   deploy/site/04-set-secrets.sh --from-env-file site/.migration-secrets.env --apply
#
# Getting the values: pull them yourself, e.g.
#   cd site && npx vercel env pull .migration-secrets.env \
#              --environment=production --project pcbjam --scope pcbj-am
# .migration-secrets.env is gitignored. Delete it when you're done.
#
# Pages applies environment-variable changes to NEW deployments only, so this must
# run BEFORE 05-deploy.sh (or you must redeploy afterwards).
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

no_xtrace                       # never run with tracing: values would be echoed
require_cmd npx shasum awk

NAMES="RESEND_API_KEY RESEND_SEGMENT_ID WAITLIST_FROM_EMAIL"
MODE=prompt; ENV_FILE=""
parse_common_flags "$@"
set -- $CFM_ARGS
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt) MODE=prompt; shift ;;
    --from-env-file) MODE=file; ENV_FILE="$2"; shift 2 ;;
    "") shift ;;
    *) die "unknown arg: $1" ;;
  esac
done
dry_banner

# WAITLIST_ALLOWED_ORIGINS is deliberately NOT settable here. It must stay unset
# so the Function keeps its in-code default (https://demo.pcbjam.com), matching
# what Vercel had. Setting it as a Pages secret would work but would hide the
# allowlist from code review.
guard_name() {
  case "$1" in
    WAITLIST_ALLOWED_ORIGINS)
      die "refusing to set WAITLIST_ALLOWED_ORIGINS: it is intentionally unset so
     the allowlist lives in functions/api/waitlist.ts where it is reviewable." ;;
  esac
  grep -q "$1" "$SITE_DIR/functions/api/waitlist.ts" \
    || die "refusing to set $1: functions/api/waitlist.ts never reads it"
}

read_value() { # read_value NAME -> echoes the value (never logged)
  _n="$1"
  if [ "$MODE" = file ]; then
    [ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE"
    ( cd "$(dirname "$ENV_FILE")" && git check-ignore -q "$(basename "$ENV_FILE")" ) \
      || die "$ENV_FILE is NOT gitignored — refusing to read secrets from a trackable file"
    awk -F= -v k="$_n" '$1==k { sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit }' "$ENV_FILE"
  else
    printf 'value for %s (input hidden, empty to skip): ' "$_n" >&2
    read -r -s _v; echo >&2
    printf '%s' "$_v"
  fi
}

section "setting secrets on $PAGES_PROJECT"
set_count=0
for n in $NAMES; do
  guard_name "$n"
  v="$(read_value "$n")"
  if [ -z "$v" ]; then warn "$n: empty, skipped"; continue; fi
  # Length + short hash only. Enough to compare against Vercel without ever
  # revealing the value.
  fp="$(printf '%s' "$v" | shasum -a 256 | cut -c1-8)"
  echo "  $n: len=$(printf '%s' "$v" | wc -c | tr -d ' ') sha256=$fp"
  for envname in production preview; do
    if [ "$DRY_RUN" = 1 ]; then
      echo "WOULD: pages secret put $n --project-name $PAGES_PROJECT --env $envname (value via stdin)"
    else
      # stdin, never argv — an argv value would be visible in `ps`.
      printf '%s' "$v" | $WRANGLER pages secret put "$n" \
        --project-name "$PAGES_PROJECT" --env "$envname" >/dev/null \
        || die "failed to set $n ($envname)"
      echo "  set: $n ($envname)"
    fi
  done
  set_count=$((set_count+1))
  unset v
done

if [ "$DRY_RUN" = 0 ]; then
  section "verifying (names only)"
  for envname in production preview; do
    have="$($WRANGLER pages secret list --project-name "$PAGES_PROJECT" --env "$envname" 2>/dev/null || true)"
    for n in $NAMES; do
      case "$have" in *"$n"*) echo "  ok   $n ($envname)" ;;
        *) die "$n missing from $envname after setting it" ;;
      esac
    done
  done
  stamp_write 04-secrets "count=$set_count"
fi

section "done"
echo "Pages applies env changes to NEW deployments only — run 05-deploy.sh next."
echo "If you used --from-env-file, delete it now:  rm -f $ENV_FILE"
echo "done: $set_count secrets set (production + preview)"
