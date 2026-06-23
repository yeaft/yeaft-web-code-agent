/**
 * Crew — Git Worktree 管理
 * 为开发组创建/清理 git worktrees
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/**
 * 为开发组创建 git worktree
 * 每个 groupIndex 对应一个 worktree，同组的 dev/rev/test 共享
 *
 * @param {string} projectDir - 主项目目录
 * @param {Array} roles - 展开后的角色列表
 * @returns {Map<number, string>} groupIndex → worktree 路径
 */
export async function initWorktrees(projectDir, roles) {
  const groupIndices = [...new Set(roles.filter(r => r.groupIndex > 0).map(r => r.groupIndex))];
  if (groupIndices.length === 0) return new Map();

  const worktreeBase = join(projectDir, '.worktrees');
  await fs.mkdir(worktreeBase, { recursive: true });

  // 获取 git 已知的 worktree 列表
  let knownWorktrees = new Set();
  try {
    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: projectDir, windowsHide: true });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        knownWorktrees.add(line.slice('worktree '.length).trim());
      }
    }
  } catch {
    // git worktree list 失败，视为空集
  }

  const worktreeMap = new Map();

  for (const idx of groupIndices) {
    const wtDir = join(worktreeBase, `dev-${idx}`);
    const branch = `crew/dev-${idx}`;

    // 检查目录是否存在
    let dirExists = false;
    try {
      await fs.access(wtDir);
      dirExists = true;
    } catch {}

    if (dirExists) {
      if (knownWorktrees.has(wtDir)) {
        // 目录存在且 git 记录中也有，直接复用
        console.log(`[Crew] Worktree already exists: ${wtDir}`);
        worktreeMap.set(idx, wtDir);
        continue;
      } else {
        // 孤立目录：目录存在但 git 不认识，先删除再重建
        console.warn(`[Crew] Orphaned worktree dir, removing: ${wtDir}`);
        await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    try {
      // 创建分支（如果不存在）
      try {
        await execFile('git', ['branch', branch], { cwd: projectDir, windowsHide: true });
      } catch {
        // 分支已存在，忽略
      }

      // 创建 worktree
      await execFile('git', ['worktree', 'add', wtDir, branch], { cwd: projectDir, windowsHide: true });
      console.log(`[Crew] Created worktree: ${wtDir} on branch ${branch}`);
      worktreeMap.set(idx, wtDir);
    } catch (e) {
      console.error(`[Crew] Failed to create worktree for group ${idx}:`, e.message);
    }
  }

  return worktreeMap;
}

/**
 * 清理 session 的 git worktrees
 * @param {string} projectDir - 主项目目录
 */
export async function cleanupWorktrees(projectDir) {
  const worktreeBase = join(projectDir, '.worktrees');

  try {
    await fs.access(worktreeBase);
  } catch {
    return; // .worktrees 目录不存在，无需清理
  }

  try {
    const entries = await fs.readdir(worktreeBase);
    for (const entry of entries) {
      if (!entry.startsWith('dev-')) continue;
      const wtDir = join(worktreeBase, entry);
      const branch = `crew/${entry}`;

      try {
        await execFile('git', ['worktree', 'remove', wtDir, '--force'], { cwd: projectDir, windowsHide: true });
        console.log(`[Crew] Removed worktree: ${wtDir}`);
      } catch (e) {
        console.warn(`[Crew] Failed to remove worktree ${wtDir}:`, e.message);
      }

      try {
        await execFile('git', ['branch', '-D', branch], { cwd: projectDir, windowsHide: true });
        console.log(`[Crew] Deleted branch: ${branch}`);
      } catch (e) {
        console.warn(`[Crew] Failed to delete branch ${branch}:`, e.message);
      }
    }

    // 尝试删除 .worktrees 目录（如果已空）
    try {
      await fs.rmdir(worktreeBase);
    } catch {
      // 目录不空或其他原因，忽略
    }
  } catch (e) {
    console.error(`[Crew] Failed to cleanup worktrees:`, e.message);
  }
}
