/**
 * Smoke test — Vitest discovery scope sanity.
 *
 * This must test Vitest's own discovery, not a hand-rolled tinyglobby
 * approximation. Focused positional runs such as:
 *   vitest list --filesOnly test/agent/yeaft/store-v2.test.js
 * can match same-named files under cloned worktrees unless config/script
 * excludes keep `.claude/worktrees/**`, `.worktrees/**`, and
 * `.yeaft/worktrees/**` out of Vitest's file set.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REQUESTED_FILES = [
  'test/agent/yeaft/dream-trigger-routing.test.js',
  'test/agent/yeaft/dream-v2/runner.test.js',
  'test/agent/yeaft/dream-v2/prompts.test.js',
  'test/agent/yeaft/store-v2.test.js',
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
  const { stdout } = await execFileAsync('./node_modules/.bin/vitest', FOCUSED_ARGS, {
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
