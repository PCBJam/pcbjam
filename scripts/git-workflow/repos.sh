#!/bin/bash
# Sourced library. Single source of truth for the 4-repo layout:
#
#   root  = pcbjam                                main
#   ├── kicad           (kicad/)                  wasm-port
#   ├── wxwidgets       (wxwidgets/)              wasm-port
#   └── pcbjam-shared   (web/pcbjam-shared/)      main   [MIT contract]
#
# Bash variable names can't contain '-', so pcbjam-shared's KEY is
# `pcbjam_shared`; its path/display name keep the dash.
# Usage: source "$(dirname "$0")/repos.sh"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

REPOS=(root kicad wxwidgets pcbjam_shared)

PATH_root="$ROOT_DIR"
PATH_kicad="$ROOT_DIR/kicad"
PATH_wxwidgets="$ROOT_DIR/wxwidgets"
PATH_pcbjam_shared="$ROOT_DIR/web/pcbjam-shared"

MAIN_root="main"
MAIN_kicad="wasm-port"
MAIN_wxwidgets="wasm-port"
MAIN_pcbjam_shared="main"

# The long-lived STAGING line, one branch per repo (the wasm forks suffix
# theirs). Protected like main: never merged anywhere, never deleted; "sync"
# on one rebases local commits onto its own origin, "finish" just pushes it.
STAGING_root="staging"
STAGING_kicad="staging-wasm-port"
STAGING_wxwidgets="staging-wasm-port"
STAGING_pcbjam_shared="staging"

repo_path() {
    local var="PATH_$1"
    echo "${!var}"
}

repo_main() {
    local var="MAIN_$1"
    echo "${!var}"
}

repo_staging() {
    local var="STAGING_$1"
    echo "${!var}"
}

# True iff <branch> is <repo>'s main or staging branch.
repo_is_protected() {
    local repo="$1" branch="$2"
    [ -n "$branch" ] && { [ "$branch" = "$(repo_main "$repo")" ] || [ "$branch" = "$(repo_staging "$repo")" ]; }
}

# The branch a checkout is measured against: the current branch itself when it
# is protected, else main.
repo_base() {
    local repo="$1" branch="$2"
    if repo_is_protected "$repo" "$branch"; then echo "$branch"; else repo_main "$repo"; fi
}

# Given root's current branch, the branch each repo is expected to be on
# (root `staging` ↔ kicad `staging-wasm-port`; feature branches share a name).
repo_counterpart_branch() {
    local repo="$1" root_branch="$2"
    if [ "$root_branch" = "$(repo_main root)" ]; then repo_main "$repo"
    elif [ "$root_branch" = "$(repo_staging root)" ]; then repo_staging "$repo"
    else echo "$root_branch"; fi
}

run_git() {
    # Echo before run so the user always sees what we're doing.
    local repo="$1"; shift
    local p
    p=$(repo_path "$repo")
    echo "+ git -C $p $*" >&2
    git -C "$p" "$@"
}
