/**
 * Smoke test — Vitest discovery scope sanity.
 *
 * This must test Vitest's own discovery, not a hand-rolled tinyglobby
 * approximation. Focused positional runs such as:
 *   vitest list --filesOnly test/agent/yeaft/store.test.js
 * can match same-named files under cloned worktrees unless config/script
 * excludes keep `.claude/worktrees/**`, `.worktrees/**`, and
 * `.yeaft/worktrees/**` out of Vitest's file set.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Walk up from ROOT looking for `node_modules/.bin/vitest`. Worktrees
 * frequently don't install deps locally and rely on the parent checkout's
 * `node_modules` — hardcoding `./node_modules/.bin/vitest` ENOENTs in that
 * setup. Falling back to the parent lets the smoke test run from both a
 * main checkout and a git worktree.
 */
function resolveVitestBin() {
  let dir = ROOT;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'vitest');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(ROOT, 'node_modules', '.bin', 'vitest');
}
const VITEST_BIN = resolveVitestBin();
const REQUESTED_FILES = [
  'test/agent/yeaft/dream-trigger-routing.test.js',
  'test/agent/yeaft/dream/runner.test.js',
  'test/agent/yeaft/dream/prompts.test.js',
  'test/agent/yeaft/store.test.js',
  'test/vitest-discovery-smoke.test.js',
  'test/web/yeaft-page-setup-tdz.test.js',
];
const FOCUSED_ARGS = [
  '--config',
  './vitest.config.js',
  'list',
  '--filesOnly',
  ...REQUESTED_FILES,
];

async function vitestListFocusedFiles() {
  const { stdout } = await execFileAsync(VITEST_BIN, FOCUSED_ARGS, {
    cwd: ROOT,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(file => file.replace(/\\/g, '/'));
}

describe('vitest discovery smoke', () => {
  it('focused positional runs do not discover cloned worktree tests', async () => {
    const files = await vitestListFocusedFiles();
    const leaked = files.filter((f) => (
      f.includes('.claude/worktrees/')
      || f.includes('.worktrees/')
      || f.includes('.yeaft/worktrees/')
    ));
    expect(leaked, `vitest positional discovery leaked worktree test files:\n${leaked.slice(0, 20).join('\n')}`).toHaveLength(0);
  });

  it('focused positional runs stay on the requested six files', async () => {
    const files = await vitestListFocusedFiles();
    expect(files.sort()).toEqual(REQUESTED_FILES.sort());
  });
});
