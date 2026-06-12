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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REQUESTED_FILES = [
  'test/agent/yeaft/engine.test.js',
  'test/server/ws-agent.test.js',
  'test/web/template-compile.test.js',
  'test/vitest-discovery-smoke.test.js',
];
const FOCUSED_ARGS = [
  '--config',
  './vitest.config.js',
  'list',
  '--filesOnly',
  ...REQUESTED_FILES,
];

async function vitestListFocusedFiles() {
  const vitestPackagePath = require.resolve('vitest/package.json');
  const vitestBin = path.join(path.dirname(vitestPackagePath), 'vitest.mjs');
  const { stdout } = await execFileAsync(process.execPath, [vitestBin, ...FOCUSED_ARGS], {
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

  it('focused positional runs stay on the requested files', async () => {
    const files = await vitestListFocusedFiles();
    expect(files.sort()).toEqual(REQUESTED_FILES.sort());
  });
});
