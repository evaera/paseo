---
name: maintain-paseo-fork
description: Maintain evaera/paseo against getpaseo/paseo, including syncing fork main, auditing fork-only commits, and preparing isolated branches for upstream contributions. Use for fork maintenance, upstream syncs, or Paseo contribution branch preparation.
---

# Maintain the Paseo fork

Maintain this repository with these branch roles:

- `upstream` is `getpaseo/paseo`, the source of truth for upstream `main`.
- `origin` is `evaera/paseo`, the personal fork.
- `main` is the runnable fork: current upstream plus the selected fork feature stack.
- Contribution branches isolate one change for an upstream pull request.

## Start with an audit

Work in the current checkout. Preserve existing worktrees and branches.

1. Inspect the worktree. A read-only audit may continue when it is dirty, but do not switch branches, format, merge, cherry-pick, rebase, or otherwise mutate history until the worktree is clean. Preserve dirty work and stop for user direction; do not stash it implicitly.
2. Verify `git remote get-url origin` identifies `evaera/paseo` and `git remote get-url upstream` identifies `getpaseo/paseo`. Stop on a mismatch.
3. Fetch `origin` and `upstream` with pruning.
4. Inspect `git rev-list --left-right --count` for `upstream/main...main`, `origin/main...main`, and `upstream/main...origin/main`.
5. Inspect both `git log upstream/main..main` and `git cherry -v upstream/main main`. Do not assume a commit is fork-only from its subject alone.

Do not use `git pull`: `main` tracks `origin`, while maintenance also needs the independent `upstream` relationship to remain visible.

After the audit, run only the workflow the user requested: report an audit, sync fork `main`, or prepare a contribution branch. Do not turn an audit request into history mutation.

## Sync fork main

Treat `main` as shared, merge-based history. Do not rebase or reset it to upstream.

1. Require a clean worktree, then switch to `main` and verify `git branch --show-current` returns `main` immediately before mutation.
2. If local `main` is an ancestor of `origin/main`, fast-forward it. If they diverged, inspect both sides and merge `origin/main` with permission. Never cherry-pick, rebase, or reset fork `main`.
3. Merge `upstream/main` after the local and remote fork histories agree.
4. Resolve conflicts in favor of current upstream behavior unless a selected fork feature intentionally changes it.
5. Build affected workspace declarations before diagnosing cross-package type errors.
6. Run focused tests, then `npm run format`, `npm run typecheck`, and `npm run lint`.

Before any history mutation, commit, or push, show the divergence and intended operation and obtain explicit permission. Push fork `main` only to the verified `origin`; never push it to `upstream`.

## Prepare an upstream contribution

Never open an upstream pull request from fork `main`; it contains unrelated fork features.

1. Require a clean worktree. Confirm the change affects upstream code; a repair needed only because fork features were combined stays a fork integration fix.
2. Start the contribution branch from current `upstream/main`.
3. With explicit commit permission, cherry-pick or reimplement only the logical commits for that change.
4. If the change depends on another unmerged fork feature, create a stacked branch from that feature's clean contribution branch and state the dependency. Do not silently base it on fork `main`.
5. Verify scope with `git log upstream/main..HEAD` and `git diff --stat upstream/main...HEAD`.
6. Rebase an unpublished contribution branch onto updated `upstream/main` before opening its pull request. Obtain explicit permission before rebasing a published branch; update it only with an explicitly authorized `--force-with-lease` push.
7. Follow `docs/qa.md` for evidence and the repository rule for pull request title prefixes. Keep local commit subjects unprefixed.

When a change was committed directly on fork `main`, leave `main` history intact. Recreate the contribution branch from `upstream/main` and cherry-pick only the relevant commits.

## Retire merged fork patches

After upstream merges a contribution, fetch upstream and confirm the patch with `git cherry`. Merge updated `upstream/main` into fork `main`; do not rewrite published fork history merely to remove the old commit. Delete local or remote contribution branches only with explicit permission.
