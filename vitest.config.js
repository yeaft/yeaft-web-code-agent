import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    fileParallelism: false,
    // Anchor discovery to this repository's real test tree. Positional filters
    // like `vitest run test/foo.test.js` can otherwise also match cloned paths
    // such as `.worktrees/name/test/foo.test.js` before normal filtering.
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // Dot-dir worktrees may appear at different depths depending on who
    // created them. Use globstar forms so both full and focused runs exclude
    // `.claude/worktrees`, `.worktrees`, and `.yeaft/worktrees` clones.
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
      '**/.yeaft/worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'agent/**/*.js'],
      exclude: ['**/node_modules/**', 'agent/sdk/**', 'web/**']
    }
  }
});
