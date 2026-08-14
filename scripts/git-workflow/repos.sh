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

repo_path() {
    local var="PATH_$1"
    echo "${!var}"
}

repo_main() {
    local var="MAIN_$1"
    echo "${!var}"
}

run_git() {
    # Echo before run so the user always sees what we're doing.
    local repo="$1"; shift
    local p
    p=$(repo_path "$repo")
    echo "+ git -C $p $*" >&2
    git -C "$p" "$@"
}
