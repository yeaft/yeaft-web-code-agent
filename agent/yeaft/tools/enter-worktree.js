/**
 * enter-worktree.js — Create an isolated git worktree for development
 *
 * Creates a new git worktree with an isolated branch, useful for
 * sub-agents that need to work on files without conflicting with
 * the main working tree or other workers.
 *
 * Reference: yeaft-yeaft-design.md §8, yeaft-yeaft-core-systems.md §3.2
 */

import { defineTool } from './types.js';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

export default defineTool({
  name: 'EnterWorktree',
  description: `Create an isolated git worktree for development.

Creates a new git worktree with a dedicated branch, allowing parallel
development without file conflicts. Useful for:
- Sub-agents working on independent subtasks
- Testing changes in isolation before merging
- Parallel feature development

The worktree is created in .yeaft/worktrees/ with a new branch based on HEAD.
Returns the worktree path and branch name.`,
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the worktree (used in path and branch name). If omitted, a random name is generated.',
      },
      base_ref: {
        type: 'string',
        description: 'Git ref to base the worktree on (default: HEAD)',
      },
    },
  },
  isDestructive: () => false,
  async execute(input, ctx) {
    const cwd = ctx?.cwd || process.cwd();

    // Verify we're in a git repo
    try {
      execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' });
    } catch {
      return JSON.stringify({ error: 'Not in a git repository' });
    }

    // Generate worktree name and path
    const name = input.name
      ? input.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64)
      : `wt-${randomUUID().slice(0, 8)}`;

    const worktreeDir = join(cwd, '.yeaft', 'worktrees', name);
    const branchName = `yeaft-wt/${name}`;
    const baseRef = input.base_ref || 'HEAD';

    // Check if worktree already exists
    if (existsSync(worktreeDir)) {
      return JSON.stringify({
        error: `Worktree "${name}" already exists at ${worktreeDir}`,
        path: worktreeDir,
        branch: branchName,
      });
    }

    // Ensure parent directory exists
    const parentDir = join(cwd, '.yeaft', 'worktrees');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    try {
      // Create worktree with new branch. Use execFileSync args instead of
      // shell quoting so Windows drive letters and spaces in paths survive.
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeDir, baseRef], { cwd, stdio: 'pipe' });

      return JSON.stringify({
        success: true,
        path: resolve(worktreeDir),
        branch: branchName,
        baseRef,
        name,
        message: `Created worktree "${name}" at ${worktreeDir} on branch ${branchName}`,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to create worktree: ${err.message}`,
      });
    }
  },
});
