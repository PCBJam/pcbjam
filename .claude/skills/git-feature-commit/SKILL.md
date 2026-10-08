---
name: git-feature-commit
description: Commit staged + unstaged work across all 5 repos. Submodules first (kicad, wxwidgets, binaryen, pcbjam-shared, pcbjam-shared-ui), then root with submodule pointer bumps. Asks the user to approve each commit separately and shows the pointer diff for the root commit. Usage - "/git-feature-commit [message]".
---

# git-feature-commit

Commit work-in-progress across root + kicad + wxwidgets + binaryen + pcbjam-shared + pcbjam-shared-ui in the correct order: **submodules first, then root** (so the root commit captures the new submodule pointers).

## Arguments

Optional positional message string. If omitted, ask the user for a message via `AskUserQuestion` before any commit step. Same message is reused across all repos (user can edit per-repo at the confirm step).

## Steps

1. **Status snapshot.** Run `bash scripts/git-workflow/repo-status.sh` to see which repos have changes.

2. **Show per-repo diff overview to the user first** (before any commit). For each repo, run:
   - `git -C <path> status --short`
   - `git -C <path> diff --stat HEAD`
   so the user sees the full picture before being asked to commit anything.

3. **Submodule commits — kicad, then wxwidgets, then binaryen, then pcbjam-shared, then pcbjam-shared-ui.** For each submodule:
   - If `git -C <path> status --porcelain` is empty AND no staged changes, print "kicad: no changes, skipping" and continue.
   - Otherwise, prose-ask: "Commit kicad with message `<msg>`? Type `y`, `n`, or `edit` to change the message."
   - On `y`: `git -C <path> add -A && git -C <path> commit -m "<msg>"` (auto-allowed).
   - On `edit`: use `AskUserQuestion` to get a new message, then commit with that.
   - On `n`: skip and continue.

4. **Root commit (last).** After submodules:
   - Stage submodule pointer bumps explicitly: `git -C <root> add kicad wxwidgets binaryen web/pcbjam-shared web/pcbjam-shared-ui` (only stages the gitlink pointer change if a submodule has a new HEAD).
   - Stage other root changes: `git -C <root> add -A -- ':!kicad' ':!wxwidgets' ':!binaryen' ':!web/pcbjam-shared' ':!web/pcbjam-shared-ui' ':!features'` (exclude submodule trees and features/ patch dir).
   - Check what's staged: `git -C <root> diff --cached --stat`. If nothing is staged, print "root: no changes, skipping" and stop.
   - Show the user:
     - `git -C <root> diff --cached --stat` (overview)
     - `git -C <root> diff --cached -- kicad wxwidgets binaryen web/pcbjam-shared web/pcbjam-shared-ui` (the raw pointer-bump diff — the user wants to eyeball this every time)
   - Prose-ask: "Commit root with message `<msg>`? `y`/`n`/`edit`."
   - On `y`: `git -C <root> commit -m "<msg>"`.

5. **Report.** Print a summary of which repos committed and the new HEAD shas.

## Edge cases

- All repos clean → print "nothing to commit anywhere" and stop.
- Only submodule changes, no other root changes → root commit still happens, but it'll only contain the pointer bumps. That's correct.
- Only root changes (no sub changes) → just root commits, submodules skipped.
- Submodule has commits but pointer was already bumped in a prior root commit → pointer add will be a no-op and that's fine.

## Safety

- Never use `git commit -a` (it ignores staging intent).
- Never `git add` paths outside the repo or with shell expansion that could grab unintended files.
- Always exclude `features/` from the root stage step (it contains patches that recursively include themselves if committed).
- Always echo commands before running.
