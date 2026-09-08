---
name: maintain-paseo-fork
description: Maintain evaera/paseo against getpaseo/paseo, including preferring plugins over fork patches, syncing fork main, auditing fork-only commits, refreshing fork desktop runtimes on macOS and Windows, and preparing isolated branches for upstream contributions. Use for fork maintenance, plugin-versus-fork decisions, upstream syncs, local fork desktop builds, or Paseo contribution branch preparation.
---

# Maintain the Paseo fork

Maintain this repository with these branch roles:

- `upstream` is `getpaseo/paseo`, the source of truth for upstream `main`.
- `origin` is `evaera/paseo`, the personal fork.
- `main` is the runnable fork: current upstream plus the selected fork feature stack.
- Contribution branches isolate one change for an upstream pull request.

## Prefer plugins over fork patches

Before implementing or retaining a Paseo customization, load the `paseo-plugin` skill and evaluate the requested outcome against the current `docs/plugins.md`, public plugin contract, and relevant example. Do not accept the proposed implementation mechanism as a constraint.

Classify the change before editing core code:

1. **Plugin now:** The current plugin API can deliver the outcome. Implement it as a separately installable plugin and keep it out of fork `main`.
2. **Plugin API extension plus plugin:** A narrow, generally useful plugin capability would deliver the outcome. Contribute that extension upstream, then implement the personal behavior as a plugin. Keep any temporary fork patch isolated and retire it after upstream ships the API.
3. **Core change:** The behavior changes Paseo's platform contract, security boundary, startup or update machinery, protocol, or universal built-in behavior and cannot be expressed through a safe general plugin capability. Keep it as a fork patch and consider contributing it upstream.

Prefer the second classification when the missing API can be exposed without leaking internal stores, bypassing user policy, weakening trust boundaries, or coupling plugins to unstable implementation details. Do not create a one-user plugin hook whose only purpose is to move the same patch behind an API.

State the classification and evidence before implementation. During fork audits, classify every surviving fork feature again because the upstream plugin API may have gained the needed capability. Migrate plugin-capable behavior out of the fork only after the plugin reaches parity and the user approves retiring the core patch.

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
7. Re-run the plugin classification for surviving fork patches before reporting the sync complete.
8. Do not report an installed desktop app as updated. Refresh each requested machine through the workflow below.

Before any history mutation, commit, or push, show the divergence and intended operation and obtain explicit permission. Push fork `main` only to the verified `origin`; never push it to `upstream`.

## Refresh fork desktop runtimes

Git synchronization never changes a running dev process or an installed desktop binary. Choose one runtime workflow and report which machines remain pending.

### Checkout development runtime

Use this while iterating on the fork. On each machine, update its `main` from `origin/main`, run `npm ci` when `package-lock.json` changed or dependencies are missing, then restart the checkout runtime:

- macOS: `npm run dev:desktop`
- Windows: `npm run dev:win:desktop`

These commands run the current checkout and a checkout-scoped development home. They do not replace the installed Paseo app or its production `~/.paseo` state.

### Packaged fork install

Build the installed fork locally on each target machine:

- Apple Silicon macOS: `npm run build:fork:macos`
- Windows x64: `npm run build:fork:windows`

The scripts build only the architectures the fork owner uses and write artifacts to `packages/desktop/release`. They keep the upstream package version and embed `evaera/paseo` as the update source, so an upstream Paseo release cannot overwrite the installed fork. The fork does not publish desktop releases, so the app will not update automatically.

After each approved fork update:

1. Require fork `main` to be clean, pushed, and equal to `origin/main`.
2. On each machine, fetch `origin`, fast-forward local `main`, and run `npm ci` when `package-lock.json` changed or dependencies are missing.
3. Run the platform's `build:fork:*` script and install the resulting DMG or NSIS executable from `packages/desktop/release`.
4. Report every machine that still runs an older build.

The macOS build is unsigned and disables notarization. The Windows build is unsigned and may show a SmartScreen warning. The About section identifies both as `Eryn's Choice`. Do not install or replace the running app without explicit permission, especially when it owns the current agent.

## Prepare an upstream contribution

Never open an upstream pull request from fork `main`; it contains unrelated fork features.

1. Require a clean worktree. Confirm the change affects upstream code; a repair needed only because fork features were combined stays a fork integration fix.
2. Apply the plugin classification. For an API-extension-plus-plugin change, keep the upstream branch limited to the general API and its tests; keep personal behavior in the plugin repository.
3. Start the contribution branch from current `upstream/main`.
4. With explicit commit permission, cherry-pick or reimplement only the logical commits for that change.
5. If the change depends on another unmerged fork feature, create a stacked branch from that feature's clean contribution branch and state the dependency. Do not silently base it on fork `main`.
6. Verify scope with `git log upstream/main..HEAD` and `git diff --stat upstream/main...HEAD`.
7. Rebase an unpublished contribution branch onto updated `upstream/main` before opening its pull request. Obtain explicit permission before rebasing a published branch; update it only with an explicitly authorized `--force-with-lease` push.
8. Follow `docs/qa.md` for evidence and the repository rule for pull request title prefixes. Keep local commit subjects unprefixed.

When a change was committed directly on fork `main`, leave `main` history intact. Recreate the contribution branch from `upstream/main` and cherry-pick only the relevant commits.

## Retire merged fork patches

After upstream merges a contribution, fetch upstream and confirm the patch with `git cherry`. Merge updated `upstream/main` into fork `main`; do not rewrite published fork history merely to remove the old commit. Delete local or remote contribution branches only with explicit permission.
