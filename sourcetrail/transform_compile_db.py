#!/usr/bin/env python3
"""Transform the in-container emscripten compile_commands.json into one
Sourcetrail 2021.4.19 (bundled clang ~11) can index on the host.

- expands @CMakeFiles/....rsp response files inline
- strips emscripten-only and PCH flags (old clang can't load clang-20 .pch)
- replaces the PCH with `-include cmake_pch.hxx` so those headers still parse
- injects libc++ 11 headers (-nostdinc++) + emscripten sysroot includes
- rewrites /workspace -> host pcbjam, /emsdk -> host tools/emsdk mirror

Usage: transform_compile_db.py [--no-wasm-target] <in.json> <out.json>
"""
import json
import os
import re
import shlex
import sys

PCBJAM = "/Users/V/IdeaProjects/pcbjam-private/pcbjam"
ST_DIR = f"{PCBJAM}/sourcetrail"
EMSDK_HOST = f"{PCBJAM}/tools/emsdk"

PATH_MAP = [("/workspace/", PCBJAM + "/"), ("/emsdk/", EMSDK_HOST + "/")]

DROP_EXACT = {
    "-fwasm-exceptions",
    "-Winvalid-pch",
    "--emit-symbol-map",
}
DROP_PREFIX_RE = re.compile(r"^-s[A-Z][A-Z_0-9]*(=.*)?$|^-gseparate-dwarf")


def host_path(p: str) -> str:
    for src, dst in PATH_MAP:
        if p.startswith(src):
            return dst + p[len(src):]
    return p


def rewrite_tok(tok: str) -> str:
    for src, dst in PATH_MAP:
        tok = tok.replace(src, dst)
    return tok


def expand_rsp(tokens, directory):
    out = []
    for tok in tokens:
        if tok.startswith("@"):
            rsp = tok[1:]
            if not os.path.isabs(rsp):
                rsp = os.path.join(directory, rsp)
            rsp_host = host_path(rsp)
            with open(rsp_host) as f:
                out.extend(shlex.split(f.read()))
        else:
            out.append(tok)
    return out


def transform(tokens, directory, wasm_target=True):
    tokens = expand_rsp(tokens, directory)

    argv0 = tokens[0]
    lang_cxx = argv0.endswith("++")
    out = []

    i = 1
    pch_headers = []
    while i < len(tokens):
        tok = tokens[i]
        if tok == "-Xclang" and i + 1 < len(tokens):
            nxt = tokens[i + 1]
            if nxt == "-fno-pch-timestamp":
                i += 2
                continue
            if nxt == "-include-pch":
                # -Xclang -include-pch -Xclang <path.pch>
                if i + 3 < len(tokens) and tokens[i + 2] == "-Xclang":
                    pch = tokens[i + 3]
                    hdr = pch[:-4] if pch.endswith(".pch") else pch
                    if os.path.exists(host_path(hdr)):
                        pch_headers.append(hdr)
                    i += 4
                    continue
                i += 2
                continue
            out.extend([tok, nxt])
            i += 2
            continue
        if tok in DROP_EXACT or DROP_PREFIX_RE.match(tok):
            i += 1
            continue
        if not wasm_target and tok in ("-matomics", "-mbulk-memory", "-pthread"):
            i += 1
            continue
        out.append(tok)
        i += 1

    for hdr in pch_headers:
        out.extend(["-include", hdr])

    # Rewrite container paths in the ORIGINAL tokens only, then prepend the
    # host-path injections — rewriting after injection would re-fire on the
    # /emsdk/ substring inside the host tools/emsdk mirror path.
    out = [rewrite_tok(t) for t in out]

    inject = ["-isystem", f"{EMSDK_HOST}/upstream/emscripten/cache/sysroot/include",
              "-fexceptions"]
    if lang_cxx:
        inject = ["-nostdinc++", "-isystem", f"{ST_DIR}/libcxx-11/include"] + inject
    if wasm_target:
        inject = ["--target=wasm32-unknown-emscripten"] + inject

    return ["clang++" if lang_cxx else "clang"] + inject + out


def main():
    args = sys.argv[1:]
    wasm_target = True
    if args and args[0] == "--no-wasm-target":
        wasm_target = False
        args = args[1:]
    src, dst = args

    with open(src) as f:
        db = json.load(f)

    out_db = []
    missing = 0
    for e in db:
        tokens = shlex.split(e["command"])
        directory = e["directory"]
        new_tokens = transform(tokens, directory, wasm_target)
        file_host = host_path(e["file"])
        if not os.path.exists(file_host):
            missing += 1
            continue
        out_db.append({
            "directory": host_path(directory),
            "command": " ".join(shlex.quote(t) for t in new_tokens),
            "file": file_host,
        })

    with open(dst, "w") as f:
        json.dump(out_db, f, indent=1)
    print(f"wrote {len(out_db)} entries to {dst} ({missing} skipped: file missing on host)")


if __name__ == "__main__":
    main()
