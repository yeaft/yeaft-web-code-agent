# .githooks — Opt-in Governance Hooks

This directory holds repository-tracked git hooks that enforce project-wide
governance rules. Unlike `.git/hooks/`, the contents of `.githooks/` are
versioned and reviewed alongside code.

## Why opt-in?

Git does not auto-activate `.githooks/`. Developers must explicitly enable
it on their local clone. This is intentional:

- Hooks run arbitrary shell code on every git operation — forcing them on
  contributors is hostile.
- CI / release automation should enforce the same rules server-side
  (branch protection + tag protection rules on GitHub) so local opt-in
  remains a convenience, not the last line of defense.

## Enabling

From the repo root:

```bash
git config core.hooksPath .githooks
```

To disable, unset it:

```bash
git config --unset core.hooksPath
```

## Current hooks

### `pre-push` — dev tag guard (task-304)

Blocks `git push origin <tag>` for any `v*` or `release-*` tag when the
current branch is not `main`, and also verifies the tagged commit is
reachable from `main`. This prevents the 2026-04-17 regression where a
dev-role agent tagged a release on a worktree branch, pinning production
to an un-merged commit.

Legacy equivalent: `hooks/pre-push` + `scripts/install-hooks.sh` (copies
the hook into `.git/hooks/`). Both implementations intentionally enforce
the same policy; either activation method is fine.

## Testing a hook

Syntax-check:

```bash
bash -n .githooks/pre-push
```

Unit test (runs in CI):

```bash
npx vitest run test/governance/pre-push-hook.test.js
```
