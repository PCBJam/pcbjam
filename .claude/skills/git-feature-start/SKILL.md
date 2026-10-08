---
name: git-feature-start
description: Create a new feature branch across all 5 repos (root + kicad + wxwidgets + binaryen + pcbjam-shared + pcbjam-shared-ui submodules). Fetches each repo's main, fast-forward pulls, and creates the same feature branch in each. Usage - "/git-feature-start <branch-name>", e.g. "/git-feature-start feature/new-foo".
---

# git-feature-start

Create a new feature branch in all 6 repos (root, kicad, wxwidgets, binaryen, pcbjam-shared and pcbjam-shared-ui submodules), based on each repo's main branch.

Per-repo main mapping (hardcoded in `scripts/git-workflow/repos.sh`):
- root → `main`
- kicad → `wasm-port`
- wxwidgets → `wasm-port`
- binaryen → `wasm-port`
- pcbjam-shared (web/pcbjam-shared) → `main`
- pcbjam-shared-ui (web/pcbjam-shared-ui) → `main`

## Arguments

A single positional argument: the feature branch name (e.g. `feature/my-thing`).

If the user invoked the skill without a branch name, ask for one via `AskUserQuestion` before proceeding.

## Steps

1. **Pre-flight: assert all repos are clean.** Run `bash scripts/git-workflow/assert-clean.sh`. If it exits non-zero, STOP and tell the user which repos are dirty and that they need to commit, stash, or discard before starting a new feature.

2. **Pre-flight: check no repo is already on a non-main branch.** Run `bash scripts/git-workflow/repo-status.sh` and inspect each line's `branch` field. If any repo's `branch` is not its `main` (or is empty meaning detached HEAD), STOP and tell the user. Suggest: `/git-feature-sync` if they're already mid-feature, or manually checkout the main in that repo first. Do NOT silently switch off in-progress work.

3. **For each repo** in order [root, kicad, wxwidgets, binaryen, pcbjam-shared, pcbjam-shared-ui], run these commands. Echo what you're about to do in chat before each repo.
   - `git -C <path> fetch origin`
   - `git -C <path> checkout <main>`
   - `git -C <path> pull --ff-only origin <main>`
   - `git -C <path> checkout -b <branch-name>` — this hits the `ask` permission rule, so it will prompt. Also, you should prose-ask the user "About to create branch `<name>` in <repo> — proceed?" before invoking it (belt + suspenders per project rule).

4. **Report.** Print a summary table:
   ```
   root:      created <branch> from main@<sha>
   kicad:     created <branch> from wasm-port@<sha>
   wxwidgets: created <branch> from wasm-port@<sha>
   binaryen:  created <branch> from wasm-port@<sha>
   pcbjam-shared: created <branch> from main@<sha>
   pcbjam-shared-ui: created <branch> from main@<sha>
   ```

5. Suggest `/git-feature-commit` as the next step when the user has changes to record.

## Failure handling

If any step fails partway (e.g. checkout fails in wxwidgets after root and kicad succeeded), STOP and report exactly which repos already have the new branch and which don't. The user can manually finish or `/git-feature-finish` won't run until all 5 are aligned anyway.

## Safety

- Never use `-f` / `--force` flags.
- Never delete branches in this skill.
- Always echo the command before running it.
