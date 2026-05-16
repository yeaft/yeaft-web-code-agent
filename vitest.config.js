import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    fileParallelism: false,
    // NOTE: path was previously '.worktrees/**' which never matched; the real
    // path is `.claude/worktrees/**`. The broken glob caused vitest to scan
    // ~10k test files across ~109 worktrees, making full runs take 50+ min
    // instead of ~70s. `**/e2e/**` is used (instead of bare `e2e/**`) so the
    // e2e exclusion also holds inside worktrees.
    exclude: ['**/node_modules/**', '**/e2e/**', '.claude/worktrees/**', '.worktrees/**', '.yeaft/worktrees/**'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'agent/**/*.js'],
      exclude: ['**/node_modules/**', 'agent/sdk/**', 'web/**']
    }
  }
});
