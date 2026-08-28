#!/bin/bash
# Oracle for X-1 (security-audit-v3 #15): every dependency tarball fetch is
# pinned to a SHA256, and download_file actually enforces the pin.
#
#  1. static  — every download_file call in scripts/deps/*.sh passes a third
#               argument that resolves to a 64-hex value from versions.sh.
#  2. dynamic — download_file against a file:// URL (fully offline): a wrong
#               pin fails and removes the file, the right pin succeeds, and an
#               empty pin is refused unless PCBJAM_ALLOW_UNPINNED=1.
#
# Runs in seconds with no docker; wired into wasm-build.yml before the deps
# step and usable locally: scripts/deps/check-pins.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

fail=0
ok()   { echo "  ok   $*"; }
bad()  { echo "  FAIL $*"; fail=1; }

echo "[check-pins] static: download_file call sites"
while IFS= read -r line; do
    file="${line%%:*}"; rest="${line#*:}"; lineno="${rest%%:*}"; call="${rest#*:}"
    # third argument must be a "${NAME_SHA256}" reference
    if [[ "$call" =~ download_file[[:space:]]+\"[^\"]*\"[[:space:]]+\"[^\"]*\"[[:space:]]+\"\$\{([A-Z0-9_]+_SHA256)\}\" ]]; then
        var="${BASH_REMATCH[1]}"
        val="${!var:-}"
        if printf '%s' "$val" | grep -Eq '^[0-9a-f]{64}$'; then
            ok "$(basename "$file"):$lineno -> $var"
        else
            bad "$(basename "$file"):$lineno -> $var is not a 64-hex pin in versions.sh ('$val')"
        fi
    else
        bad "$(basename "$file"):$lineno has no \"\${NAME_SHA256}\" third argument: $call"
    fi
done < <(grep -n '^[[:space:]]*download_file ' "${SCRIPT_DIR}"/build-*.sh)

echo "[check-pins] dynamic: download_file enforces the pin (file:// URL)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'pcbjam pin oracle\n' > "$tmp/src.txt"
tar -czf "$tmp/src.tar.gz" -C "$tmp" src.txt
good="$(file_sha256 "$tmp/src.tar.gz")"
wrong="$(printf '%064d' 1)"
url="file://$tmp/src.tar.gz"

if download_file "$url" "$tmp/d1.tar.gz" "$wrong" >/dev/null 2>&1; then
    bad "wrong pin was accepted"
elif [ -e "$tmp/d1.tar.gz" ]; then
    bad "wrong pin: mismatched file left on disk"
else
    ok "wrong pin rejected and file removed"
fi

if download_file "$url" "$tmp/d2.tar.gz" "$good" >/dev/null 2>&1 && [ -f "$tmp/d2.tar.gz" ]; then
    ok "right pin accepted"
else
    bad "right pin rejected"
fi

if PCBJAM_ALLOW_UNPINNED=0 download_file "$url" "$tmp/d3.tar.gz" >/dev/null 2>&1; then
    bad "empty pin accepted without PCBJAM_ALLOW_UNPINNED=1"
else
    ok "empty pin refused"
fi

if PCBJAM_ALLOW_UNPINNED=1 download_file "$url" "$tmp/d4.tar.gz" >/dev/null 2>&1; then
    ok "empty pin allowed with PCBJAM_ALLOW_UNPINNED=1 (bootstrap)"
else
    bad "bootstrap escape hatch broken"
fi

if download_file "$url" "$tmp/d5.tar.gz" "not-a-hash" >/dev/null 2>&1; then
    bad "malformed pin accepted"
else
    ok "malformed pin refused"
fi

if [ $fail -ne 0 ]; then echo "[check-pins] FAILED"; exit 1; fi
echo "[check-pins] all good"
