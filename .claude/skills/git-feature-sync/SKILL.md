---
name: git-feature-sync
description: Rebase the current branch onto its base in all repos (root + kicad + wxwidgets + pcbjam-shared). On a feature branch the base is each repo's main; on a PROTECTED branch (main, or the staging line - root/pcbjam-shared `staging`, kicad/wxwidgets `staging-wasm-port`) the base is that same branch on origin, i.e. local staging commits are rebased onto remote staging. Naturally re-runnable - after the user resolves a conflict manually and runs `git rebase --continue`, re-invoke the skill and it picks up where it stopped. Usage - "/git-feature-sync".
---

# git-feature-sync

Rebase the current branch onto its base in root, kicad, wxwidgets and pcbjam-shared. The base is `repo-status.sh`'s `base` field:

- **Feature branch** → the repo's main (`origin/main` / `origin/wasm-port`).
- **Protected branch** (`on_protected: true` — main or the staging line) → the same branch on origin: root `staging` onto `origin/staging`, kicad `staging-wasm-port` onto `origin/staging-wasm-port`, … This is how local staging commits catch up with what CI/others pushed to staging.

Per-repo mains / staging names are in `scripts/git-workflow/repos.sh`.

## How "resume after conflict" works

There is **no state file**. State is derived live each run:
- `git -C <p> merge-base --is-ancestor origin/<base> HEAD` → if 0, the branch already contains the latest base; skip this repo (`up_to_date_with_base`).
- `.git/rebase-merge` or `.git/rebase-apply` directory present → rebase is mid-flight in that repo; refuse to do anything until the user finishes or aborts it.

So after the user resolves a conflict manually + runs `git rebase --continue` in the stopped repo, just re-running `/git-feature-sync` picks up at the next un-rebased repo.

## Steps

1. **Fetch every origin FIRST.** Run `bash scripts/git-workflow/for-each-repo.sh fetch origin --no-recurse-submodules`. Mandatory on every sync and *before* the status snapshot: `repo-status.sh` derives `up_to_date_with_base` from the local `origin/<base>` ref **without fetching**, so without this step the work plan can wrongly mark a repo "up to date" and skip a needed rebase when its origin has moved.

2. **Get status snapshot.** Run `bash scripts/git-workflow/repo-status.sh` and parse the per-repo JSON.

3. **Pre-flight checks.**
   - If any repo has `rebase_in_progress: true`, STOP. Tell the user which repo, and that they need to resolve (`git -C <repo> rebase --continue` after `git add`-ing resolved files) or abort (`git -C <repo> rebase --abort`) before sync can proceed.
   - Let `B` = root's `branch`. If root is detached, STOP: "root is detached — nothing to sync". `B` may be a feature branch OR a protected one; say which mode applies ("syncing the staging line from origin" vs "rebasing `feature/x` onto main").
   - **Branch consistency.** Every repo is expected on `repo_counterpart_branch <repo> B` (root `staging` ↔ kicad `staging-wasm-port`; feature branches share a name):
     - empty (detached): prose-ask "<repo> is at detached HEAD `<sha>`. Want me to `git -C <path> checkout <expected>` first? (y/N)". On yes, run it (auto-allowed). On no, STOP.
     - a different branch, but root's recorded pointer equals its HEAD (`git ls-tree HEAD <path>` vs `git -C <path> rev-parse HEAD`) and it is clean → not part of this change: print "<repo>: on `<x>`, pointer unchanged — skipping" and leave it out.
     - a different branch otherwise: STOP and report which repo is on which branch. Don't auto-switch.
   - A repo with uncommitted changes cannot rebase. If a participating repo is `dirty`, STOP: "commit (`/git-feature-commit`) or stash first". Never stash on the user's behalf.

4. **Determine work plan.** For each participating repo, mark "needs rebase" if `up_to_date_with_base: false`. If none does, print "all repos already up to date with their bases" and stop cleanly.

5. **Execute per repo** in order [root, kicad, wxwidgets, pcbjam-shared]. Skip any repo that was skipped in step 3 or has `up_to_date_with_base: true`. For each repo that needs rebase:
   - Prose-announce: "About to rebase <repo> (`<branch>`, <ahead> local commit(s)) onto `origin/<base>` (<behind> new) — proceed?"
   - `git -C <path> rebase origin/<base>` (origins were already fetched in step 1; hits the `ask` permission). With `ahead == 0` this is a plain fast-forward.
   - If the rebase command exits non-zero (conflict), STOP and emit the handoff message (see below).
   - On success, continue to the next repo.

6. **After all repos succeed:** submodule pointers can be stale in two directions now:
   - a rebased SUBMODULE moved its SHA → root shows the entry modified; suggest `/git-feature-commit "sync: bump submodule pointers after rebase"`.
   - a fast-forwarded ROOT (protected mode) now records a submodule SHA the checkout hasn't reached → fixed by that submodule's own rebase in this same run (submodules come after root in the order). If one still differs afterwards, report it — `git submodule update` would detach it, so that is the user's call.
   Check `git status --short` for changed `kicad` / `wxwidgets` / `web/pcbjam-shared` entries and report. Do NOT auto-commit.

## Conflict handoff message — use this exact shape

When a rebase fails mid-flight in repo X, list the repos in the plan, what's been done, what's pending, and the manual commands to resolve. Derive everything live by re-running `repo-status.sh` if needed.

> **Completed:** root rebased onto origin/staging (3 commits replayed).
> **Stopped:** kicad — conflict during rebase. Conflicted files:
> ```
> kicad/eeschema/foo.cpp
> kicad/common/bar.cpp
> ```
> **Pending:** wxwidgets, pcbjam-shared (not started).
>
> **To resolve manually:**
> ```
> cd kicad   # from the project root
> # edit each conflicted file, resolve <<<<<<< markers
> git add eeschema/foo.cpp common/bar.cpp
> git rebase --continue
> ```
>
> Then re-run `/git-feature-sync` — kicad will be detected as already rebased and it will proceed with wxwidgets.
>
> To roll back kicad only: `git -C kicad rebase --abort`. Note: already-rebased repos (root in this case) **stay rebased** — they are not rolled back.

Get the conflicted-files list from `git -C <path> diff --name-only --diff-filter=U`.

## Safety

- Never `--force` anything.
- Never `git rebase --skip` on the user's behalf — only `--continue` is safe and that's the user's job after manual resolution.
- Never stash on the user's behalf.
- Always echo the command before running it.
- Detached HEAD in a submodule is a confirmation point, never an auto-fix.
