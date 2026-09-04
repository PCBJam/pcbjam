---
name: git-feature-finish
description: Land the current branch across all repos and push. On a FEATURE branch - merge into each repo's main (fast-forward only), push, offer to delete the branch. On a PROTECTED branch (main, or the staging line - root/pcbjam-shared `staging`, kicad/wxwidgets `staging-wasm-port`) - no merge, no delete, just push each repo's branch. Submodules first (kicad, wxwidgets, pcbjam-shared), then root - so the root push includes the pushed submodule SHAs. Stops for confirmation at each merge and push. Usage - "/git-feature-finish".
---

# git-feature-finish

Land the current branch in every repo and push. Two modes, decided by root's
branch (`on_protected` in `repo-status.sh`):

- **Feature mode** (root on `feature/…`): merge into each repo's main with
  `--ff-only`, push main, offer to delete the local feature branch.
- **Protected mode** (root on `main` or `staging`): the branch IS the target.
  Nothing is merged and nothing is deleted — each repo's branch is pushed to
  its own origin. The staging line lives on locally after the push.

Per-repo mains / staging names are in `scripts/git-workflow/repos.sh`
(root=`main`/`staging`, kicad/wxwidgets=`wasm-port`/`staging-wasm-port`,
pcbjam-shared=`main`/`staging`; `repo_counterpart_branch` maps root's branch to
each repo's expected one).

## Pre-flight (all of these must pass before anything is merged or pushed)

1. **Fetch every origin FIRST.** Run `bash scripts/git-workflow/for-each-repo.sh fetch origin --no-recurse-submodules`. Mandatory and *before* the status snapshot: `repo-status.sh` reads the local `origin/<base>` ref **without fetching**, so a moved origin would otherwise look "up to date" and only bite mid-push.
2. Run `bash scripts/git-workflow/repo-status.sh`. Parse the JSON.
3. All repos must have `dirty: false`. If any is dirty, STOP and tell the user to commit (`/git-feature-commit`) or stash first.
4. **Branch consistency.** Let `B` = root's `branch`; every repo is expected on `repo_counterpart_branch <repo> B` (root `staging` ↔ kicad `staging-wasm-port`; a feature branch shares its name everywhere). A repo on a different branch is fine ONLY if it is not part of this change: root's recorded pointer equals its HEAD (`git ls-tree HEAD <path>` vs `git -C <path> rev-parse HEAD`) and it is clean — print "<repo>: on `<x>`, pointer unchanged — not part of this change, skipping" and leave it out of every later step. Otherwise STOP and report.
5. All participating repos must have `up_to_date_with_base: true` (feature rebased onto latest main, or local staging rebased onto origin/staging). If any isn't, STOP and instruct: "run `/git-feature-sync` first".
6. None may have `rebase_in_progress: true`. If so, STOP.

## Protected mode — steps, order: kicad, wxwidgets, pcbjam-shared, root

For each participating repo:

1. If `ahead == 0`: print "<repo>: `<branch>` has nothing to push" and continue.
2. **Prose-ask:** "Push <repo>'s `<branch>` to origin (<ahead> commit(s))? — proceed?"
   - `git -C <path> push` (hits `ask` permission). A rejected push means origin moved since the fetch: STOP → "run `/git-feature-sync` and try again". Never `--force`.
3. Never `checkout`, never `merge`, never `branch -d` in this mode.

## Feature mode — steps, same order

Submodules first so that when root checks out main and merges its feature branch, the pointer-bump commits land on root's main referencing the just-merged submodule mains.

For each participating repo:

1. Skip if already merged: run `git -C <path> branch --merged <main>` and check if the feature branch appears. If so, print "<repo>: feature already merged into <main>, skipping merge+push" and proceed to step 5 (branch delete prompt).

2. **Prose-ask:** "About to merge `<feature>` into `<main>` in <repo> (ff-only) — proceed?"

3. Run, echoing each:
   - `git -C <path> checkout <main>` (auto-allowed)
   - `git -C <path> pull --ff-only` (auto-allowed) — if this fails because main moved with non-ff changes, STOP and tell the user: "<repo>: main moved with non-ff changes since last sync. Run `/git-feature-sync` and try again." Do NOT try `--no-ff`.
   - `git -C <path> merge --ff-only <feature>` (hits `ask` permission). If this fails because main moved in a way that breaks ff, STOP with the same message as above.

4. **Prose-ask:** "Push <repo>'s <main> to origin? — proceed?"
   - `git -C <path> push` (hits `ask` permission).

5. **Prose-ask:** "Delete local feature branch `<feature>` in <repo>?"
   - `git -C <path> branch -d <feature>` (hits `ask` permission). `-d`, not `-D` — git refuses if the branch isn't fully merged. NEVER offered for a protected branch.

## After all repos done

Report a summary table, e.g. (protected mode):
```
kicad:         staging-wasm-port nothing to push
wxwidgets:     staging-wasm-port nothing to push
pcbjam-shared: staging           pushed 1 commit (origin/staging now at <sha>)
root:          staging           pushed 2 commits (origin/staging now at <sha>)
```
or (feature mode) the merged / pushed / deleted columns per repo.

If `features/<feature>/` exists from `scripts/create-feature-patches.sh`, mention it but do NOT auto-delete. The user may want to keep the patches as history.

## Edge cases

- **Feature already merged in some repos but not all:** the per-repo `--merged` check handles this naturally — finish skips re-merging and just offers branch delete.
- **No local feature branch left to delete in some repo:** `branch -d` will fail; report and continue. Don't make this fatal.
- **`-u` first-push:** this workflow never pushes feature branches, only mains and staging lines, which always have tracking already.
- **Protected push rejected (non-ff):** someone pushed to that origin between the fetch and the push. STOP, never force; `/git-feature-sync` rebases local commits onto the new origin and finish can be re-run.

## Safety

- `--ff-only` everywhere, no fallback to `--no-ff`.
- `branch -d` not `-D` — never force-delete; never on `main` / `staging` / `wasm-port` / `staging-wasm-port`.
- Never `--force` push. The settings.json `deny` rule blocks this regardless.
- Always echo commands before running.
- Always pose the prose confirmation BEFORE invoking the tool-layer prompt.
