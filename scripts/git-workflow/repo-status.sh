#!/bin/bash
# Emit one JSON line per repo describing its state.
# Fields: repo, path, branch, dirty, ahead, behind, head_sha, main, staging, base,
#         on_protected, rebase_in_progress, up_to_date_with_main, up_to_date_with_base
# "base" is the branch the checkout is measured against (the current branch when it is
# protected — main/staging — else main); ahead/behind count against origin/<base>.
# "up_to_date_with_*" means origin/<that branch> is an ancestor of HEAD (rebase not needed).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./repos.sh
source "$SCRIPT_DIR/repos.sh"

json_escape() {
    # Minimal JSON string escape: backslash and double-quote only. Branch/sha never contain control chars in practice.
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

for repo in "${REPOS[@]}"; do
    p=$(repo_path "$repo")
    main=$(repo_main "$repo")

    staging=$(repo_staging "$repo")
    branch=$(git -C "$p" branch --show-current || echo "")
    head_sha=$(git -C "$p" rev-parse --short HEAD)
    base=$(repo_base "$repo" "$branch")
    if repo_is_protected "$repo" "$branch"; then on_protected="true"; else on_protected="false"; fi

    if [ -z "$(git -C "$p" status --porcelain)" ]; then
        dirty="false"
    else
        dirty="true"
    fi

    ahead=0
    behind=0
    if [ -n "$branch" ] && git -C "$p" rev-parse --verify --quiet "origin/$base" >/dev/null; then
        read -r behind ahead < <(git -C "$p" rev-list --left-right --count "origin/$base...HEAD" 2>/dev/null || echo "0 0")
    fi

    if [ -d "$p/.git/rebase-merge" ] || [ -d "$p/.git/rebase-apply" ]; then
        rebase="true"
    else
        rebase="false"
    fi

    up_to_date="false"
    if git -C "$p" rev-parse --verify --quiet "origin/$main" >/dev/null; then
        if git -C "$p" merge-base --is-ancestor "origin/$main" HEAD 2>/dev/null; then
            up_to_date="true"
        fi
    fi

    up_to_date_base="false"
    if git -C "$p" rev-parse --verify --quiet "origin/$base" >/dev/null; then
        if git -C "$p" merge-base --is-ancestor "origin/$base" HEAD 2>/dev/null; then
            up_to_date_base="true"
        fi
    fi

    printf '{"repo":"%s","path":"%s","branch":"%s","dirty":%s,"ahead":%s,"behind":%s,"head_sha":"%s","main":"%s","staging":"%s","base":"%s","on_protected":%s,"rebase_in_progress":%s,"up_to_date_with_main":%s,"up_to_date_with_base":%s}\n' \
        "$(json_escape "$repo")" \
        "$(json_escape "$p")" \
        "$(json_escape "$branch")" \
        "$dirty" \
        "$ahead" \
        "$behind" \
        "$(json_escape "$head_sha")" \
        "$(json_escape "$main")" \
        "$(json_escape "$staging")" \
        "$(json_escape "$base")" \
        "$on_protected" \
        "$rebase" \
        "$up_to_date" \
        "$up_to_date_base"
done
