/**
 * Conductor — Worktree 管理
 *
 * Conductor 的 worktree 策略与 Crew V1 不同：
 * - Crew V1: 每个 dev group 一个 worktree
 * - Conductor: 每个并行执行线程(thread) 一个 worktree
 *
 * worktree 位于 .conductor/tasks/task-N/worktrees/thread-N/
 * 复用 crew/worktree.js 的 git 操作模式
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/**
 * 为 task 的执行线程创建 worktree
 *
 * @param {string} projectDir - 主项目目录（git 仓库根目录）
 * @param {string} taskDir - task 目录路径 (.conductor/tasks/task-N)
 * @param {string} threadId - 线程 ID (e.g. 't1', 't2')
 * @param {object} [options]
 * @param {string} [options.baseBranch='HEAD'] - 基于哪个 ref 创建
 * @returns {Promise<string>} worktree 路径
 */
export async function createThreadWorktree(projectDir, taskDir, threadId, options = {}) {
  const { baseBranch = 'HEAD' } = options;

  const worktreeBase = join(taskDir, 'worktrees');
  await fs.mkdir(worktreeBase, { recursive: true });

  const wtDir = join(worktreeBase, threadId);
  const branch = `conductor/${extractTaskId(taskDir)}-${threadId}`;

  // 检查是否已存在
  const exists = await directoryExists(wtDir);
  if (exists) {
    // 检查 git 是否认识它
    const known = await isKnownWorktree(projectDir, wtDir);
    if (known) {
      console.log(`[Conductor/Worktree] Already exists: ${wtDir}`);
      return wtDir;
    }
    // 孤立目录，清理后重建
    console.warn(`[Conductor/Worktree] Orphaned dir, removing: ${wtDir}`);
    await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
  }

  try {
    // 创建分支
    try {
      await execFile('git', ['branch', branch, baseBranch], { cwd: projectDir });
    } catch {
      // 分支已存在，忽略
    }

    // 创建 worktree
    await execFile('git', ['worktree', 'add', wtDir, branch], { cwd: projectDir });
    console.log(`[Conductor/Worktree] Created: ${wtDir} on branch ${branch}`);
    return wtDir;
  } catch (e) {
    console.error(`[Conductor/Worktree] Failed to create ${threadId}:`, e.message);
    throw e;
  }
}

/**
 * 清理 task 的全部 worktrees
 *
 * @param {string} projectDir - 主项目目录
 * @param {string} taskDir - task 目录路径
 */
export async function cleanupTaskWorktrees(projectDir, taskDir) {
  const worktreeBase = join(taskDir, 'worktrees');

  if (!(await directoryExists(worktreeBase))) {
    return;
  }

  try {
    const entries = await fs.readdir(worktreeBase);
    for (const entry of entries) {
      const wtDir = join(worktreeBase, entry);
      const branch = `conductor/${extractTaskId(taskDir)}-${entry}`;

      try {
        await execFile('git', ['worktree', 'remove', wtDir, '--force'], { cwd: projectDir });
        console.log(`[Conductor/Worktree] Removed: ${wtDir}`);
      } catch (e) {
        console.warn(`[Conductor/Worktree] Failed to remove ${wtDir}:`, e.message);
      }

      try {
        await execFile('git', ['branch', '-D', branch], { cwd: projectDir });
        console.log(`[Conductor/Worktree] Deleted branch: ${branch}`);
      } catch (e) {
        console.warn(`[Conductor/Worktree] Failed to delete branch ${branch}:`, e.message);
      }
    }

    // 尝试删除 worktrees 目录
    try {
      await fs.rmdir(worktreeBase);
    } catch { /* 目录不空，忽略 */ }
  } catch (e) {
    console.error(`[Conductor/Worktree] Failed to cleanup ${taskDir}:`, e.message);
  }
}

/**
 * 清理整个 conductor 下的全部 worktrees
 *
 * @param {string} projectDir - 主项目目录
 * @param {string} conductorDir - .conductor 目录路径
 */
export async function cleanupAllConductorWorktrees(projectDir, conductorDir) {
  const tasksDir = join(conductorDir, 'tasks');

  if (!(await directoryExists(tasksDir))) return;

  try {
    const taskEntries = await fs.readdir(tasksDir);
    for (const taskEntry of taskEntries) {
      const taskDir = join(tasksDir, taskEntry);
      const stat = await fs.stat(taskDir).catch(() => null);
      if (stat?.isDirectory()) {
        await cleanupTaskWorktrees(projectDir, taskDir);
      }
    }
  } catch (e) {
    console.error(`[Conductor/Worktree] Failed to cleanup all:`, e.message);
  }
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * 检查目录是否存在
 */
async function directoryExists(dir) {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查目录是否是 git 认识的 worktree
 */
async function isKnownWorktree(projectDir, wtDir) {
  try {
    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: projectDir });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ') && line.slice('worktree '.length).trim() === wtDir) {
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 从 taskDir 路径中提取 taskId（取最后一个路径段）
 */
function extractTaskId(taskDir) {
  return taskDir.split(/[\\/]/).filter(Boolean).pop() || 'unknown';
}
