import { defineConfig } from 'vitest/config';
import { CORE_TEST_FILES } from './scripts/test-suite-manifest.mjs';

export default defineConfig({
  plugins: [{
    name: 'strip-node-shebang',
    enforce: 'pre',
    transform(code) {
      if (!code.startsWith('#!')) return null;
      return { code: code.replace(/^#![^\r\n]*/, ''), map: null };
    },
  }],
  test: {
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    fileParallelism: false,
    // The full gate runs every registered Vitest file. New test files belong in the manifest.
    include: [...CORE_TEST_FILES],
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
