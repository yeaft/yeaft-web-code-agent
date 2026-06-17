/**
 * exit-worktree.js — Remove or keep a git worktree
 *
 * Exits and optionally removes a worktree created by EnterWorktree.
 * Can keep the worktree (preserve branch) or remove it cleanly.
 *
 * Reference: yeaft-yeaft-design.md §8
 */

import { defineTool } from './types.js';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

export default defineTool({
  name: 'ExitWorktree',
  description: {
    en: `Exit a git worktree session.

Options:
- "keep": Leave the worktree and branch on disk (can return later)
- "remove": Delete the worktree directory and its branch

If removing and there are uncommitted changes, the operation will fail
unless discard_changes is set to true.`,
    zh: `退出 git worktree 会话。

选项：
- "keep"：保留 worktree 和分支在磁盘上（之后可返回）
- "remove"：删除 worktree 目录及其分支

如果删除时有未提交的更改，操作会失败，除非设置 discard_changes 为 true。`
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the worktree to exit (required)',
      },
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: '"keep" leaves the worktree on disk; "remove" deletes it',
      },
      discard_changes: {
        type: 'boolean',
        description: 'Force remove even with uncommitted changes (default: false)',
      },
    },
    required: ['path', 'action'],
  },
  isDestructive: (input) => input?.action === 'remove',
  async execute(input, ctx) {
    const worktreePath = resolve(input.path);
    const mainCwd = ctx?.cwd || process.cwd();

    if (!existsSync(worktreePath)) {
      return JSON.stringify({
        error: `Worktree path does not exist: ${worktreePath}`,
      });
    }

    if (input.action === 'keep') {
      return JSON.stringify({
        success: true,
        action: 'keep',
        path: worktreePath,
        message: `Worktree at ${worktreePath} kept on disk. Branch preserved.`,
      });
    }

    // action === 'remove'
    try {
      // Check for uncommitted changes
      if (!input.discard_changes) {
        try {
          const status = execFileSync('git', ['status', '--porcelain'], {
            cwd: worktreePath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          if (status) {
            return JSON.stringify({
              error: 'Worktree has uncommitted changes. Set discard_changes=true to force remove.',
              uncommittedFiles: status.split('\n').slice(0, 10),
            });
          }
        } catch {
          // If we can't check status, proceed with caution
        }
      }

      // Get branch name before removal
      let branchName = null;
      try {
        branchName = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: worktreePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        // ignore
      }

      // Remove worktree. Use argv form so Windows paths with spaces or drive
      // letters are passed to git unchanged.
      execFileSync('git', ['worktree', 'remove', ...(input.discard_changes ? ['--force'] : []), worktreePath], {
        cwd: mainCwd,
        stdio: 'pipe',
      });

      // Remove the branch if it was a yeaft worktree branch
      if (branchName && branchName.startsWith('yeaft-wt/')) {
        try {
          execFileSync('git', ['branch', '-D', branchName], {
            cwd: mainCwd,
            stdio: 'pipe',
          });
        } catch {
          // Branch might already be deleted or not exist
        }
      }

      return JSON.stringify({
        success: true,
        action: 'remove',
        path: worktreePath,
        branch: branchName,
        message: `Worktree removed: ${worktreePath}${branchName ? `, branch ${branchName} deleted` : ''}`,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to remove worktree: ${err.message}`,
      });
    }
  },
});
