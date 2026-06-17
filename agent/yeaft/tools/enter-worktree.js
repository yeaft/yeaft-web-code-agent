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
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

export default defineTool({
  name: 'EnterWorktree',
  description: {
  en: `Create an isolated git worktree for development.

Creates a new git worktree with a dedicated branch, allowing parallel
development without file conflicts. Useful for:
- Sub-agents working on independent subtasks
- Testing changes in isolation before merging
- Parallel feature development

The worktree is created in .yeaft/worktrees/ with a new branch based on HEAD.
Returns the worktree path and branch name.`,
  zh: `创建一个独立的 git worktree 用于开发。

创建带独立分支的新 git worktree，允许并行开发无文件冲突。适用于：
- 子 Agent 处理独立子任务
- 合并前隔离测试改动
- 并行功能开发

Worktree 创建在 .yeaft/worktrees/ 中，基于 HEAD 创建新分支。返回 worktree 路径和分支名。`
},
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
      // Create worktree with new branch
      const cmd = `git worktree add -b "${branchName}" "${worktreeDir}" ${baseRef}`;
      execSync(cmd, { cwd, stdio: 'pipe' });

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
