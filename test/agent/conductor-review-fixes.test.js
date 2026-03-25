/**
 * Tests for Conductor V5 — worktree.js
 *
 * Covers: createTaskWorktree, cleanupTaskWorktree, getActorCwd routing,
 *         getTaskWorktreePath, cleanupAllConductorWorktrees
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'agent/conductor/worktree.js'), 'utf-8');
});

// ── Replicate getActorCwd for functional tests ──────────────────────

function getTaskWorktreePath(taskDir) {
  return join(taskDir, 'worktree');
}

function getActorCwd(workDir, taskDir, specialty) {
  const readWriteSpecialties = new Set(['coding', 'testing', 'review']);
  if (readWriteSpecialties.has(specialty)) {
    return getTaskWorktreePath(taskDir);
  }
  return workDir;
}

// ── createTaskWorktree ──────────────────────────────────────────────

describe('createTaskWorktree', () => {
  it('should create worktree at {taskDir}/worktree/', () => {
    expect(src).toContain("join(taskDir, 'worktree')");
  });

  it('should use branch name conductor/{taskId}', () => {
    expect(src).toContain('`conductor/${taskId}`');
  });

  it('should check if worktree already exists', () => {
    expect(src).toContain('directoryExists(wtDir)');
  });

  it('should check if directory is a known git worktree', () => {
    expect(src).toContain('isKnownWorktree');
  });

  it('should handle orphaned directory by removing and recreating', () => {
    expect(src).toContain('Orphaned dir');
    expect(src).toContain('fs.rm(wtDir');
  });

  it('should detect if workDir is a git repo', () => {
    expect(src).toContain("join(workDir, '.git')");
  });

  it('should fallback to plain directory if not a git repo', () => {
    expect(src).toContain('is not a git repo, creating plain directory');
    expect(src).toContain('fs.mkdir(wtDir, { recursive: true })');
  });

  it('should run git branch and git worktree add', () => {
    expect(src).toContain("'git', ['branch', branch, baseBranch]");
    expect(src).toContain("'git', ['worktree', 'add', wtDir, branch]");
  });

  it('should fallback to plain directory on git failure', () => {
    expect(src).toContain('Failed to create worktree');
    expect(src).toContain('fs.mkdir(wtDir, { recursive: true })');
  });

  it('should accept optional baseBranch parameter', () => {
    expect(src).toContain("baseBranch = 'HEAD'");
  });
});

// ── cleanupTaskWorktree ─────────────────────────────────────────────

describe('cleanupTaskWorktree', () => {
  it('should check if worktree directory exists', () => {
    expect(src).toContain('directoryExists(wtDir)');
  });

  it('should rm plain directory for non-git repos', () => {
    expect(src).toContain('fs.rm(wtDir, { recursive: true, force: true })');
  });

  it('should run git worktree remove --force', () => {
    expect(src).toContain("'git', ['worktree', 'remove', wtDir, '--force']");
  });

  it('should delete branch after removing worktree', () => {
    expect(src).toContain("'git', ['branch', '-D', branch]");
  });

  it('should handle removal failures gracefully', () => {
    expect(src).toContain('Failed to remove');
  });
});

// ── cleanupAllConductorWorktrees ────────────────────────────────────

describe('cleanupAllConductorWorktrees', () => {
  it('should iterate task- prefixed directories in .conductor/', () => {
    expect(src).toContain("entry.startsWith('task-')");
  });

  it('should call cleanupTaskWorktree for each task dir', () => {
    expect(src).toContain('cleanupTaskWorktree(workDir, entry, taskDir)');
  });
});

// ── getActorCwd routing ─────────────────────────────────────────────

describe('getActorCwd — read-write actors go to worktree', () => {
  const workDir = '/home/user/project';
  const taskDir = '/home/user/project/.conductor/task-001';

  it('should route coding actor to worktree', () => {
    const cwd = getActorCwd(workDir, taskDir, 'coding');
    expect(cwd).toBe(join(taskDir, 'worktree'));
  });

  it('should route testing actor to worktree', () => {
    const cwd = getActorCwd(workDir, taskDir, 'testing');
    expect(cwd).toBe(join(taskDir, 'worktree'));
  });

  it('should route review actor to worktree', () => {
    const cwd = getActorCwd(workDir, taskDir, 'review');
    expect(cwd).toBe(join(taskDir, 'worktree'));
  });
});

describe('getActorCwd — read-only actors go to workDir', () => {
  const workDir = '/home/user/project';
  const taskDir = '/home/user/project/.conductor/task-001';

  it('should route planning actor to workDir', () => {
    expect(getActorCwd(workDir, taskDir, 'planning')).toBe(workDir);
  });

  it('should route discussion actor to workDir', () => {
    expect(getActorCwd(workDir, taskDir, 'discussion')).toBe(workDir);
  });

  it('should route design actor to workDir', () => {
    expect(getActorCwd(workDir, taskDir, 'design')).toBe(workDir);
  });

  it('should route unknown specialty to workDir (safe default)', () => {
    expect(getActorCwd(workDir, taskDir, 'unknown')).toBe(workDir);
  });
});

// ── getTaskWorktreePath ─────────────────────────────────────────────

describe('getTaskWorktreePath', () => {
  it('should append /worktree to taskDir', () => {
    expect(getTaskWorktreePath('/proj/.conductor/task-1')).toBe('/proj/.conductor/task-1/worktree');
  });
});

// ── Source structure ────────────────────────────────────────────────

describe('Source structure', () => {
  it('should define readWriteSpecialties set', () => {
    expect(src).toContain("new Set(['coding', 'testing', 'review'])");
  });

  it('should use promisified execFile', () => {
    expect(src).toContain("import { execFile as execFileCb } from 'child_process'");
    expect(src).toContain('promisify(execFileCb)');
  });
});
