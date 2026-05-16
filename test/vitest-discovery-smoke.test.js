/**
 * Smoke test — vitest discovery scope sanity.
 *
 * Guards against vitest.config.js `exclude` patterns drifting off their real
 * paths (as happened when `.worktrees/**` was written instead of the true
 * `.claude/worktrees/**`, which caused ~109 worktrees × ~100 test files =
 * ~10k files to be scanned and a 50+ minute full run).
 *
 * We enumerate the files that vitest would discover using the same glob
 * engine (tinyglobby) + the same include/exclude patterns the runner reads
 * from vitest.config.js. If the count balloons past the sensible ceiling
 * for this repo we fail — cheaper than a 50-minute CI run.
 *
 * Current baseline (2026-04): ~160 test files under test/.
 * Ceiling: 500. If your legitimate additions push past 500, raise the cap
 * here — don't bypass the assertion.
 */
import { describe, it, expect } from 'vitest';
import { glob } from 'tinyglobby';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Keep these in sync with vitest.config.js.
const INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const EXCLUDE = ['**/node_modules/**', '**/e2e/**', '.claude/worktrees/**', '.worktrees/**', '.yeaft/worktrees/**'];

describe('vitest discovery smoke', () => {
  it('scans fewer than 500 test files (exclude globs are correct)', async () => {
    const files = await glob(INCLUDE, {
      cwd: ROOT,
      ignore: EXCLUDE,
      dot: false,
      absolute: false,
    });
    // If this trips, first check whether `.claude/worktrees/**` is still
    // being excluded. A misspelled exclude pattern is the likeliest cause —
    // 100+ live worktrees each carry their own test/ tree.
    expect(files.length, `Unexpectedly many test files discovered (${files.length}). Check vitest.config.js exclude patterns — a stale worktree glob here wrecks CI.`).toBeLessThan(500);
  });

  it('does not include any file under known worktree directories', async () => {
    const files = await glob(INCLUDE, {
      cwd: ROOT,
      ignore: EXCLUDE,
      dot: false,
      absolute: false,
    });
    const leaked = files.filter((f) => (
      f.includes('.claude/worktrees/')
      || f.includes('.worktrees/')
      || f.includes('.yeaft/worktrees/')
    ));
    expect(leaked, `vitest discovery leaked worktree test files:\n${leaked.slice(0, 5).join('\n')}`).toHaveLength(0);
  });
});
