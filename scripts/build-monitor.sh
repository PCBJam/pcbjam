#!/bin/bash
# Live terminal dashboard for KiCad WASM builds.
#
# Builds redirect all output to logs/<script>/<timestamp>.log (see
# scripts/common/logging.sh). This monitor tails the newest log and renders a
# single, self-refreshing screen of named stages + progress, so you never have to
# open the log to see "where are we, X of N".
#
# It reads the @KW@ progress markers emitted by scripts/common/stages.sh, and the
# CMake "[ N%]" lines for within-compile progress. If a log has no @KW@ markers
# (old logs, or a build started before this tooling existed), it falls back to
# inferring stages from the existing "=== ... ===" / "[INFO] ..." log lines.
#
# Usage:
#   ./scripts/build-monitor.sh                  # follow newest logs/build/*.log
#   ./scripts/build-monitor.sh --dir build-calculator   # watch a different subdir
#   ./scripts/build-monitor.sh --once [logfile]  # one-shot snapshot (non-TTY ok)
#   ./scripts/build-monitor.sh <logfile>         # follow a specific log file
#
# --managed: don't self-exit on the done/failed marker; run until killed. Used when
#   a parent process (logging.sh's auto-launch) owns the monitor's lifecycle.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOGS_ROOT="${PROJECT_ROOT}/logs"

ONCE=0
MANAGED=0
DIR="build"
LOGFILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --once) ONCE=1; shift ;;
        --managed) MANAGED=1; shift ;;
        --dir)  DIR="$2"; shift 2 ;;
        --dir=*) DIR="${1#--dir=}"; shift ;;
        -h|--help)
            grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; 1d'
            exit 0 ;;
        *) LOGFILE="$1"; shift ;;
    esac
done

# Newest *.log under logs/<dir>, or empty string if none yet.
find_newest_log() {
    ls -t "${LOGS_ROOT}/${DIR}"/*.log 2>/dev/null | head -1
}

# Colors + cursor/erase escapes (only when stdout is a terminal). Captured once so
# the redraw doesn't fork tput per line. C_HOME/C_EL/C_ED drive the flicker-free
# in-place repaint (move home + erase each line + erase to end of screen) instead of
# blanking the screen with `clear`, which would flash.
if [[ -t 1 ]]; then
    C_RESET=$(tput sgr0); C_BOLD=$(tput bold); C_DIM=$(tput dim)
    C_GREEN=$(tput setaf 2); C_CYAN=$(tput setaf 6); C_RED=$(tput setaf 1)
    C_YELLOW=$(tput setaf 3)
    C_HOME=$(tput cup 0 0); C_EL=$(tput el); C_ED=$(tput ed)
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_CYAN=""; C_RED=""; C_YELLOW=""
    C_HOME=""; C_EL=""; C_ED=""
fi

SPINNER='|/-\'

# All parsing + state computation lives in awk: portable across macOS bash 3.2 /
# BSD awk, and avoids associative-array bashisms. It reads the log and emits simple
# pipe-delimited records that the bash render() function formats.
#
# Records:
#   H|<app>|<index>|<total>|<elapsedSec>|<state>   state = running|done|failed
#   R|<status>|<label>|<detail>                    status = done|active|pending|skipped|failed
#   B|<pct>                                         active-compile bar pct, or -1
#   N|<note>                                        optional note line
read -r -d '' AWK_PROG <<'AWK' || true
function fmt(sec,   m,s) {
    if (sec < 0) sec = 0
    m = int(sec / 60); s = sec % 60
    if (m > 0) return m "m" s "s"
    return s "s"
}
# Start ts of the next stage row that actually ran after index i (else terminal ts).
function next_seen_start(i,   j) {
    for (j = i + 1; j <= ROWN; j++)
        if (ord[j] in rowSeen) return rowStartTs[ord[j]]
    return termTs
}
BEGIN {
    # Canonical per-app stage rows, in order. Sub-stages (wxwidgets-configure /
    # -compile) fold into the wxwidgets row via parent[].
    ROWN = 0
    ord[++ROWN] = "container-sync";  lab["container-sync"]  = "Sync source to container"
    ord[++ROWN] = "deps";            lab["deps"]            = "Dependencies"
    ord[++ROWN] = "wxwidgets";       lab["wxwidgets"]       = "wxWidgets"
    ord[++ROWN] = "kicad-stubs";     lab["kicad-stubs"]     = "Stub libraries"
    ord[++ROWN] = "kicad-configure"; lab["kicad-configure"] = "KiCad configure (CMake)"
    ord[++ROWN] = "kicad-compile";   lab["kicad-compile"]   = "KiCad compile"
    ord[++ROWN] = "kicad-bitmaps";   lab["kicad-bitmaps"]   = "Bitmap resources"
    ord[++ROWN] = "wasm-opt";        lab["wasm-opt"]        = "wasm-opt (Binaryen)"
    ord[++ROWN] = "copy-output";     lab["copy-output"]     = "Copy output"
    ord[++ROWN] = "env-shim";        lab["env-shim"]        = "ENV merge shim"
    for (i = 1; i <= ROWN; i++) ridx[ord[i]] = i
    parent["wxwidgets-configure"] = "wxwidgets"
    parent["wxwidgets-compile"]   = "wxwidgets"

    markerCount = 0; firstTs = 0
    appName = ""; appIndex = 0; appTotal = 0
    curRawKey = ""; doneFlag = 0; failFlag = 0; failCode = 0
    lastpct = -1; cc = 0
    # heuristic-mode flags
    h_app = ""; h_phase = ""; h_pct = -1; h_cc = 0; h_done = 0
}
$1 == "@KW@" {
    markerCount++
    ts = $2 + 0
    if (firstTs == 0) firstTs = ts
    kind = $3
    if (kind == "app") {
        appName = $4; appIndex = $5 + 0; appTotal = $6 + 0
        # New app segment: reset per-segment stage tracking.
        delete rowSeen; delete rowStartTs
        curRawKey = ""; lastpct = -1; cc = 0
    } else if (kind == "stage") {
        key = $4
        pk = (key in parent) ? parent[key] : key
        if (!(pk in rowSeen)) { rowSeen[pk] = 1; rowStartTs[pk] = ts }
        curRawKey = key; curTs = ts
        if (key == "kicad-compile") { lastpct = -1; cc = 0 }
    } else if (kind == "done") {
        doneFlag = 1; termRaw = ts
    } else if (kind == "failed") {
        failFlag = 1; failCode = $4 + 0; termRaw = ts
    }
    next
}
# Within an active KiCad compile, track CMake percent and compiled-object count.
curRawKey == "kicad-compile" {
    if (match($0, /[0-9]+%\]/)) {
        p = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", p); lastpct = p + 0
    }
    if ($0 ~ /Building (C|CXX) object/) cc++
}
# ---- Heuristic fallback signal collection (only used if no @KW@ markers) ----
{
    if ($0 ~ /=== Building (pcbnew|eeschema|calculator)/) {
        s = $0; sub(/.*=== Building /, "", s); sub(/ .*/, "", s); h_app = s
    }
    if ($0 ~ /=== Building wxWidgets/)            h_phase = "wxwidgets"
    if ($0 ~ /Configuring KiCad with CMake/)      h_phase = "kicad-configure"
    if ($0 ~ /\(CMake target:/)                   h_phase = "kicad-compile"
    if ($0 ~ /Building bitmap resources/)         h_phase = "kicad-bitmaps"
    if (h_phase == "kicad-compile" && match($0, /[0-9]+%\]/)) {
        p = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", p); h_pct = p + 0
    }
    if (h_phase == "kicad-compile" && $0 ~ /Building (C|CXX) object/) h_cc++
    if ($0 ~ /Build complete\. Output files/) h_done = 1
}
END {
    if (markerCount > 0) { render_markers(); }
    else                 { render_heuristic(); }
}
function render_markers(   state, totalEl, pk, curIdx, i, k, st, det, subdet, endts) {
    state = doneFlag ? "done" : (failFlag ? "failed" : "running")
    termTs = (doneFlag || failFlag) ? termRaw : NOW
    totalEl = (firstTs > 0) ? termTs - firstTs : 0

    # Pre-app phase (container sync runs before the first app marker).
    if (appName == "") {
        printf "H|-|0|0|%d|%s\n", totalEl, state
        if (curRawKey == "container-sync") {
            printf "R|active|Sync source to container|%s\n", fmt(termTs - rowStartTs["container-sync"])
        } else {
            printf "N|waiting for build to start...\n"
        }
        printf "B|-1\n"
        return
    }

    printf "H|%s|%d|%d|%d|%s\n", appName, appIndex, appTotal, totalEl, state
    pk = (curRawKey in parent) ? parent[curRawKey] : curRawKey
    curIdx = (pk in ridx) ? ridx[pk] : 0

    for (i = 1; i <= ROWN; i++) {
        k = ord[i]
        det = ""
        if (doneFlag) {
            st = (k in rowSeen) ? "done" : "skipped"
        } else if (failFlag) {
            if (i == curIdx) st = "failed"
            else if (i < curIdx) st = (k in rowSeen) ? "done" : "skipped"
            else st = "pending"
        } else {
            if (i < curIdx) st = (k in rowSeen) ? "done" : "skipped"
            else if (i == curIdx) st = "active"
            else st = "pending"
        }
        if (st == "done") {
            endts = next_seen_start(i)
            det = fmt(endts - rowStartTs[k])
        } else if (st == "active") {
            if (k == "kicad-compile") {
                if (lastpct >= 0) det = sprintf("[%3d%%]  %d files", lastpct, cc)
                else det = sprintf("%d files", cc)
            } else {
                subdet = ""
                if (k == "wxwidgets") {
                    if (curRawKey == "wxwidgets-configure") subdet = "configure "
                    else if (curRawKey == "wxwidgets-compile") subdet = "compile "
                }
                det = subdet fmt(termTs - rowStartTs[k])
            }
        }
        printf "R|%s|%s|%s\n", st, lab[k], det
    }
    if (curIdx > 0 && ord[curIdx] == "kicad-compile" && !doneFlag && !failFlag && lastpct >= 0)
        printf "B|%d\n", lastpct
    else
        printf "B|-1\n"
}
function render_heuristic(   state, order, ph, i, k, st, names) {
    state = h_done ? "done" : "running"
    printf "H|%s|0|0|-1|%s\n", (h_app == "" ? "-" : h_app), state
    # Freshly-created/empty log at startup: nothing to infer yet.
    if (h_app == "" && h_phase == "" && !h_done) {
        printf "N|starting build...\n"
        printf "B|-1\n"
        return
    }
    printf "N|(no progress markers in this log - inferred from log text)\n"
    # Reduced ordered phase set we can detect heuristically.
    split("wxwidgets kicad-configure kicad-compile kicad-bitmaps", order, " ")
    names["wxwidgets"]="wxWidgets"; names["kicad-configure"]="KiCad configure (CMake)"
    names["kicad-compile"]="KiCad compile"; names["kicad-bitmaps"]="Bitmap resources"
    ph = 0
    for (i = 1; i <= 4; i++) if (order[i] == h_phase) ph = i
    for (i = 1; i <= 4; i++) {
        k = order[i]
        if (h_done) st = "done"
        else if (i < ph) st = "done"
        else if (i == ph) st = "active"
        else st = "pending"
        det = ""
        if (st == "active" && k == "kicad-compile")
            det = (h_pct >= 0) ? sprintf("[%3d%%]  %d files", h_pct, h_cc) : sprintf("%d files", h_cc)
        printf "R|%s|%s|%s\n", st, names[k], det
    }
    printf "B|%s\n", (h_phase == "kicad-compile" && h_pct >= 0) ? h_pct : "-1"
}
AWK

# Draw a width-w progress bar for percent p.
bar() {
    local p="$1" w=24 filled i out=""
    filled=$(( p * w / 100 ))
    for ((i = 0; i < w; i++)); do
        if (( i < filled )); then out+="#"; else out+="."; fi
    done
    printf '%s' "$out"
}

# Render one snapshot from awk output ($1) to the screen.
render() {
    local data="$1" tick="$2"
    local spin="${SPINNER:$((tick % 4)):1}"
    local app idx total elapsed state note="" barpct=-1
    local -a rows=()

    while IFS='|' read -r kind a b c d e; do
        case "$kind" in
            H) app="$a"; idx="$b"; total="$c"; elapsed="$d"; state="$e" ;;
            R) rows+=("$a|$b|$c") ;;
            B) barpct="$a" ;;
            N) note="$a" ;;
        esac
    done <<< "$data"

    local title="KiCad WASM build"
    [[ "$app" != "-" && -n "$app" ]] && title+="  ${C_BOLD}${app}${C_RESET}"
    [[ "${total:-0}" -gt 0 ]] && title+=" (${idx}/${total})"
    case "$state" in
        done)   title+="  ${C_GREEN}[done]${C_RESET}" ;;
        failed) title+="  ${C_RED}[FAILED]${C_RESET}" ;;
        *)      title+="  ${C_CYAN}[building ${spin}]${C_RESET}" ;;
    esac

    printf '%s== %s ==%s\n' "$C_BOLD" "$title" "$C_RESET"
    printf '%s\n' "------------------------------------------------------------"
    [[ -n "$note" ]] && printf '  %s%s%s\n' "$C_DIM" "$note" "$C_RESET"

    local r st label detail glyph color
    for r in ${rows[@]+"${rows[@]}"}; do
        IFS='|' read -r st label detail <<< "$r"
        case "$st" in
            done)    glyph="[x]"; color="$C_GREEN" ;;
            active)  glyph="[${spin}]"; color="$C_CYAN" ;;
            pending) glyph="[ ]"; color="$C_DIM" ;;
            skipped) glyph="[-]"; color="$C_DIM" ;;
            failed)  glyph="[!]"; color="$C_RED" ;;
            *)       glyph="[ ]"; color="$C_RESET" ;;
        esac
        printf '  %s%s %-24s%s %s\n' "$color" "$glyph" "$label" "$C_RESET" "$detail"
        if [[ "$st" == "active" && "$barpct" -ge 0 ]]; then
            printf '      %s  %s%%\n' "$(bar "$barpct")" "$barpct"
        fi
    done

    printf '%s\n' "------------------------------------------------------------"
    local elapsed_str="--"
    [[ "${elapsed:--1}" -ge 0 ]] 2>/dev/null && elapsed_str="$(fmt_sec "$elapsed")"
    printf '  elapsed %s  ·  log %s\n' "$elapsed_str" "$(basename "${CUR_LOG:-?}")"
}

# Seconds -> "Xm YYs" (bash side, for the footer).
fmt_sec() {
    local s="$1" m
    (( s < 0 )) && s=0
    m=$(( s / 60 )); s=$(( s % 60 ))
    if (( m > 0 )); then printf '%dm%02ds' "$m" "$s"; else printf '%ds' "$s"; fi
}

snapshot() {
    local now data
    now=$(date +%s)
    data=$(awk -v NOW="$now" "$AWK_PROG" "$CUR_LOG")
    render "$data" "${1:-0}"
    # Surface the build state to the caller via global.
    LAST_STATE=$(printf '%s\n' "$data" | awk -F'|' '$1=="H"{print $6}')
}

# Write a pre-built frame in place, without clearing the screen first (no flash).
# Home the cursor, erase each line to its end (handles a shorter new line), then
# erase to end of screen (handles a shorter new frame, e.g. the bar/note lines
# disappearing). On a non-TTY C_HOME/C_EL/C_ED are empty, so this is plain printing.
paint() {
    local frame="$1" line
    printf '%s' "$C_HOME"
    while IFS= read -r line; do
        printf '%s%s\n' "$line" "$C_EL"
    done <<< "$frame"
    printf '%s' "$C_ED"
}

# --- one-shot mode -----------------------------------------------------------
if [[ "$ONCE" -eq 1 ]]; then
    CUR_LOG="${LOGFILE:-$(find_newest_log)}"
    if [[ -z "$CUR_LOG" || ! -f "$CUR_LOG" ]]; then
        echo "No log found in ${LOGS_ROOT}/${DIR}/ (and none given)." >&2
        exit 1
    fi
    snapshot 0
    exit 0
fi

# --- live follow mode --------------------------------------------------------
tick=0
trap 'tput cnorm 2>/dev/null; printf "%s" "$C_RESET"; echo; exit 0' INT TERM
[[ -t 1 ]] && tput civis 2>/dev/null
# Clear once up front; every later frame overwrites in place via paint() so the
# screen is never blanked between refreshes (no flash).
[[ -t 1 ]] && tput clear 2>/dev/null

while true; do
    # Re-resolve newest log each tick (unless a specific file was given) so the
    # monitor latches onto a build started after it.
    if [[ -z "$LOGFILE" ]]; then CUR_LOG="$(find_newest_log)"; else CUR_LOG="$LOGFILE"; fi

    if [[ -z "$CUR_LOG" || ! -f "$CUR_LOG" ]]; then
        paint "$(printf '%sWaiting for a build log in %s/%s/ ...%s\n%s(spinner %s)%s' \
            "$C_DIM" "$LOGS_ROOT" "$DIR" "$C_RESET" \
            "$C_DIM" "${SPINNER:$((tick % 4)):1}" "$C_RESET")"
        sleep 1; tick=$((tick + 1)); continue
    fi

    # Fetch state once, derive build state in this scope (a $(...) capture of
    # render() can't propagate a global), then render to a string and paint it.
    now=$(date +%s)
    data=$(awk -v NOW="$now" "$AWK_PROG" "$CUR_LOG")
    state=$(printf '%s\n' "$data" | awk -F'|' '$1=="H"{print $6}')
    paint "$(render "$data" "$tick")"

    # In managed mode the parent owns our lifecycle and will kill us; keep painting
    # the final frame until then. Otherwise self-exit once the build is finished.
    if [[ "$MANAGED" -eq 0 && ( "${state:-running}" == "done" || "${state:-running}" == "failed" ) ]]; then
        tput cnorm 2>/dev/null
        break
    fi
    sleep 1
    tick=$((tick + 1))
done
