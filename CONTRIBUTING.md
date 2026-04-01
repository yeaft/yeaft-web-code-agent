# Contributing to Yeaft WebChat

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
- `agent/` — Worker machine agent (manages Claude CLI, Crew coordination)
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

2,700+ tests covering server, agent, frontend, and integration scenarios across 68 test files.

## Building Frontend

```bash
npm run build
```

Bundles `web/` into `web/dist/` via esbuild. Docker builds do this automatically.

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
