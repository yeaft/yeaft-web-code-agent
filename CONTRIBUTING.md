# Contributing to Yeaft Web Code Agent

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat
npm install
npm run dev
```

Open `http://localhost:3456` — dev mode skips authentication.

## Project Structure

- `server/` — Central WebSocket server (Express + ws)
- `agent/` — Worker machine agent (runs the native Yeaft Code Agent engine, Claude/Copilot CLI providers, Crew coordination, and workbench backends)
- `web/` — Vue 3 frontend (no build step in dev)
- `test/` — Vitest unit & integration tests
- `e2e/` — Playwright end-to-end tests
- `docs/` — VitePress documentation site

## Running Tests

```bash
# Unit & integration tests
npm test

# End-to-end tests (requires Playwright browsers installed)
npm run test:e2e
```

Vitest and Playwright cover server, agent, frontend, Yeaft engine, provider routing, and integration scenarios.

## Building Frontend

```bash
npm run build
```

Bundles `web/` into `web/dist/` via esbuild. Docker builds do this automatically.

## 🚨 Tagging & Release Rules (Governance)

> **RED RULE — read before you ever run `git tag`.**
> **Version tags (`v0.1.X`) and release tags (`release-v0.1.X`) MUST only be
> created on commits that are on `main`. Developers (including AI crew
> `dev-*` roles) MUST NOT tag from a feature / worktree branch.**

### Why this matters

On **2026-04-17** an AI dev-role agent tagged a release directly from its
own worktree branch instead of merging to `main` first. The tag shipped a
commit that was never in `main`, causing production and the `main` branch
to diverge silently until the next deploy investigation. The `pre-push`
hook in this directory exists specifically to prevent a recurrence.

### Correct flow

````
  worktree-feat-xxx  ──push branch──►  PR  ──merge──►  origin/main  ──tag──►  v0.1.X
        │                            ▲                  ▲                    │
        │                            │                  │                    ▼
        └────── tests + review ──────┘                  └────────── git push origin v0.1.X
                                                                    (only from `main`)
```

1. Develop on a worktree branch (`worktree-feat-...`).
2. Run `npm test` — every test must pass.
3. Push the feature branch, not `main`.
4. Open a PR against `main`.
5. Merge the PR only after review and green validation.
6. `git checkout main && git pull --ff-only` — switch to `main` locally.
7. `git tag v0.1.X` — tag the merged `main` commit.
8. `git push origin v0.1.X` — publish the dev tag.
9. Only when a production release is explicitly requested: repeat (7)–(8) with `release-v0.1.X`.

Do **not** push feature branches directly to `main` (`HEAD:main`, `<branch>:main`, or equivalent).

### Enforcement

- **Local (opt-in):** `.githooks/pre-push` refuses to push a `v*` or
  `release-*` tag from any branch other than `main`, and refuses tags
  pointing at commits not reachable from `main`. Enable with:
  `git config core.hooksPath .githooks`.
- **Legacy copy-install:** `hooks/pre-push` + `scripts/install-hooks.sh`
  (same check, for clones that prefer `.git/hooks/`).
- **Server-side:** GitHub tag-protection rules on `v*` / `release-*`
  provide the non-bypassable layer — the local hook is a convenience,
  not the authoritative enforcement.

### Checklist for AI dev roles (crew `dev-*`)

Before any `git commit`:

- [ ] Changes are in a worktree branch (`git branch --show-current`
      ≠ `main`)
- [ ] Commit message follows conventional commits (`feat:` / `fix:` / ...)
- [ ] **No `git tag` invocations in this session unless the user
      explicitly asked for a release.**
- [ ] If a tag *is* required: the commit to tag has already been pushed
      to `origin/main`.

## Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Ensure `npm test` passes
4. Ensure `npm run build` succeeds
5. Submit a PR with a clear description

## Reporting Issues

Use [GitHub Issues](https://github.com/yeaft/claude-web-chat/issues). Include:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Code Style

- ES Modules (`import`/`export`) throughout
- No build step for web in development — browser-native ES modules
- CSS variables for all colors (both dark and light themes must work)
- Inline SVGs for icons (`fill="currentColor"`)
- Bilingual — all user-facing strings go through `web/i18n/` (en + zh-CN)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
