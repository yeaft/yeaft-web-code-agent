/**
 * Conductor — Worktree Management (V5)
 *
 * V5 strategy: each task gets ONE worktree at creation time.
 * Path: {workDir}/.conductor/task-N/worktree/
 *
 * This prevents file conflicts when multiple tasks work on the same project.
 * - Read-write actors (coding/testing/review) → cwd = worktree
 * - Read-only actors (planning/discussion/design) → cwd = {workDir}
 */
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/**
 * Create a worktree for a task.
 * Called at task creation time.
 *
 * @param {string} workDir - Project root directory (git repo root)
 * @param {string} taskId - Task ID (e.g. 'task-m1234-abcd')
 * @param {string} taskDir - Full task directory path ({workDir}/.conductor/{taskId})
 * @param {object} [options]
 * @param {string} [options.baseBranch='HEAD'] - Base ref for the worktree
 * @returns {Promise<string>} worktree path
 */
export async function createTaskWorktree(workDir, taskId, taskDir, options = {}) {
  const { baseBranch = 'HEAD' } = options;

  const wtDir = join(taskDir, 'worktree');
  const branch = `conductor/${taskId}`;

  // Check if worktree already exists
  const exists = await directoryExists(wtDir);
  if (exists) {
    const known = await isKnownWorktree(workDir, wtDir);
    if (known) {
      console.log(`[Conductor/Worktree] Already exists: ${wtDir}`);
      return wtDir;
    }
    // Orphaned directory, clean up and recreate
    console.warn(`[Conductor/Worktree] Orphaned dir, removing: ${wtDir}`);
    await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
  }

  // Check if this is a git repo
  const isGitRepo = await directoryExists(join(workDir, '.git'));
  if (!isGitRepo) {
    // Not a git repo — just create a regular directory (no worktree isolation possible)
    console.warn(`[Conductor/Worktree] ${workDir} is not a git repo, creating plain directory`);
    await fs.mkdir(wtDir, { recursive: true });
    return wtDir;
  }

  try {
    // Create branch (ignore if already exists)
    try {
      await execFile('git', ['branch', branch, baseBranch], { cwd: workDir });
    } catch {
      // Branch already exists, ignore
    }

    // Create worktree
    await execFile('git', ['worktree', 'add', wtDir, branch], { cwd: workDir });
    console.log(`[Conductor/Worktree] Created: ${wtDir} on branch ${branch}`);
    return wtDir;
  } catch (e) {
    console.error(`[Conductor/Worktree] Failed to create worktree for ${taskId}:`, e.message);
    // Fallback: create plain directory so task can still function
    await fs.mkdir(wtDir, { recursive: true }).catch(() => {});
    return wtDir;
  }
}

/**
 * Clean up a task's worktree
 *
 * @param {string} workDir - Project root directory
 * @param {string} taskId - Task ID
 * @param {string} taskDir - Full task directory path
 */
export async function cleanupTaskWorktree(workDir, taskId, taskDir) {
  const wtDir = join(taskDir, 'worktree');
  const branch = `conductor/${taskId}`;

  if (!(await directoryExists(wtDir))) return;

  const isGitRepo = await directoryExists(join(workDir, '.git'));
  if (!isGitRepo) {
    // Plain directory, just remove
    await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  try {
    await execFile('git', ['worktree', 'remove', wtDir, '--force'], { cwd: workDir });
    console.log(`[Conductor/Worktree] Removed: ${wtDir}`);
  } catch (e) {
    console.warn(`[Conductor/Worktree] Failed to remove ${wtDir}:`, e.message);
  }

  try {
    await execFile('git', ['branch', '-D', branch], { cwd: workDir });
    console.log(`[Conductor/Worktree] Deleted branch: ${branch}`);
  } catch (e) {
    console.warn(`[Conductor/Worktree] Failed to delete branch ${branch}:`, e.message);
  }
}

/**
 * Clean up all conductor worktrees under a project
 *
 * @param {string} workDir - Project root directory
 */
export async function cleanupAllConductorWorktrees(workDir) {
  const conductorDir = join(workDir, '.conductor');

  if (!(await directoryExists(conductorDir))) return;

  try {
    const entries = await fs.readdir(conductorDir);
    for (const entry of entries) {
      if (!entry.startsWith('task-')) continue;
      const taskDir = join(conductorDir, entry);
      const stat = await fs.stat(taskDir).catch(() => null);
      if (stat?.isDirectory()) {
        await cleanupTaskWorktree(workDir, entry, taskDir);
      }
    }
  } catch (e) {
    console.error(`[Conductor/Worktree] Failed to cleanup all:`, e.message);
  }
}

/**
 * Get the worktree path for a task (for cwd routing)
 */
export function getTaskWorktreePath(taskDir) {
  return join(taskDir, 'worktree');
}

/**
 * Determine actor cwd based on specialty:
 * - Read-write actors → worktree
 * - Read-only actors → workDir (main project directory)
 */
export function getActorCwd(workDir, taskDir, specialty) {
  const readWriteSpecialties = new Set(['coding', 'testing', 'review']);
  if (readWriteSpecialties.has(specialty)) {
    return getTaskWorktreePath(taskDir);
  }
  return workDir;
}

// =====================================================================
// Helpers
// =====================================================================

async function directoryExists(dir) {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

async function isKnownWorktree(projectDir, wtDir) {
  const normalizedWtDir = resolve(wtDir);
  try {
    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: projectDir });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const knownPath = resolve(line.slice('worktree '.length).trim());
        if (knownPath === normalizedWtDir) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}
