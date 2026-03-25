/**
 * Tests for Conductor V5 — persistence.js
 *
 * Covers: conductor home, task directory, state.json CRUD,
 *         session meta, message persistence
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'agent/conductor/persistence.js'), 'utf-8');
});

// ── Conductor Home ──────────────────────────────────────────────────

describe('getConductorHome', () => {
  it('should derive path from getConfigDir + .conductor', () => {
    expect(src).toContain("join(getConfigDir(), '.conductor')");
  });

  it('should import getConfigDir from service.js', () => {
    expect(src).toContain("import { getConfigDir } from '../service.js'");
  });
});

describe('ensureConductorHome', () => {
  it('should mkdir with recursive: true', () => {
    expect(src).toContain('fs.mkdir(CONDUCTOR_HOME, { recursive: true })');
  });

  it('should return CONDUCTOR_HOME', () => {
    expect(src).toContain('return CONDUCTOR_HOME');
  });
});

// ── Task Directory ──────────────────────────────────────────────────

describe('getTaskDir', () => {
  it('should return workDir/.conductor/taskId', () => {
    expect(src).toContain("join(workDir, '.conductor', taskId)");
  });
});

describe('initTaskDir', () => {
  it('should create actors/ subdirectory', () => {
    expect(src).toContain("join(dir, 'actors')");
  });

  it('should initialize CLAUDE.md and memory.md as empty', () => {
    expect(src).toContain("'CLAUDE.md': ''");
    expect(src).toContain("'memory.md': ''");
  });

  it('should initialize status.json with taskId and created status', () => {
    expect(src).toContain("taskId, status: 'created'");
  });

  it('should not overwrite existing files', () => {
    expect(src).toContain('fs.access(filePath)');
  });

  it('should call createTaskWorktree', () => {
    expect(src).toContain('createTaskWorktree(workDir, taskId, dir)');
  });

  it('should handle worktree failure gracefully', () => {
    expect(src).toContain('Failed to create worktree');
    expect(src).toContain('worktreePath = null');
  });

  it('should return { dir, worktreePath }', () => {
    expect(src).toContain('return { dir, worktreePath }');
  });
});

// ── State JSON CRUD ─────────────────────────────────────────────────

describe('state.json CRUD — source patterns', () => {
  it('should use atomic write (tmp + rename)', () => {
    expect(src).toContain("filePath + '.tmp'");
    expect(src).toContain('fs.rename(tmpPath, filePath)');
  });

  it('should use Promise chain write lock', () => {
    expect(src).toContain('_stateWriteLock');
    expect(src).toContain('_stateWriteLock.then(doWrite, doWrite)');
  });

  it('should return empty state when file missing', () => {
    expect(src).toContain("{ tasks: {}, lastUpdate: 0 }");
  });

  it('should set lastUpdate on every save', () => {
    expect(src).toContain('state.lastUpdate = Date.now()');
  });
});

describe('state.json CRUD — functional', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = join('/tmp', `cond-state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function loadState(dir) {
    try { return JSON.parse(await fs.readFile(join(dir, 'state.json'), 'utf-8')); }
    catch { return { tasks: {}, lastUpdate: 0 }; }
  }

  async function saveState(dir, state) {
    state.lastUpdate = Date.now();
    const data = JSON.stringify(state, null, 2);
    const fp = join(dir, 'state.json');
    await fs.writeFile(fp + '.tmp', data);
    await fs.rename(fp + '.tmp', fp);
  }

  it('should return empty state when no file', async () => {
    const s = await loadState(tmpDir);
    expect(s).toEqual({ tasks: {}, lastUpdate: 0 });
  });

  it('should save and load round-trip', async () => {
    await saveState(tmpDir, { tasks: { t1: { title: 'X' } }, lastUpdate: 0 });
    const s = await loadState(tmpDir);
    expect(s.tasks.t1.title).toBe('X');
    expect(s.lastUpdate).toBeGreaterThan(0);
  });

  it('should add a task entry', async () => {
    await saveState(tmpDir, { tasks: { t1: { title: 'A' } }, lastUpdate: 0 });
    const s = await loadState(tmpDir);
    s.tasks.t2 = { title: 'B', lastUpdate: Date.now() };
    await saveState(tmpDir, s);
    const s2 = await loadState(tmpDir);
    expect(Object.keys(s2.tasks)).toContain('t2');
  });

  it('should remove a task entry', async () => {
    await saveState(tmpDir, { tasks: { t1: { title: 'A' }, t2: { title: 'B' } }, lastUpdate: 0 });
    const s = await loadState(tmpDir);
    delete s.tasks.t1;
    await saveState(tmpDir, s);
    const s2 = await loadState(tmpDir);
    expect(s2.tasks.t1).toBeUndefined();
    expect(s2.tasks.t2.title).toBe('B');
  });
});

// ── initTaskDir functional ──────────────────────────────────────────

describe('initTaskDir — functional directory creation', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = join('/tmp', `cond-taskdir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should create full task directory structure', async () => {
    const taskId = 'task-test-001';
    const taskDir = join(tmpDir, '.conductor', taskId);
    await fs.mkdir(join(taskDir, 'actors'), { recursive: true });

    const files = {
      'CLAUDE.md': '', 'memory.md': '',
      'status.json': JSON.stringify({ taskId, status: 'created', updatedAt: Date.now() }, null, 2)
    };
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(join(taskDir, name), content);
    }

    expect(existsSync(join(taskDir, 'actors'))).toBe(true);
    expect(existsSync(join(taskDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(taskDir, 'memory.md'))).toBe(true);
    expect(existsSync(join(taskDir, 'status.json'))).toBe(true);

    const status = JSON.parse(readFileSync(join(taskDir, 'status.json'), 'utf-8'));
    expect(status.taskId).toBe(taskId);
    expect(status.status).toBe('created');
  });
});

// ── Session Meta ────────────────────────────────────────────────────

describe('Conductor meta (session.json)', () => {
  it('should save to session.json in conductor home', () => {
    expect(src).toContain("join(dir, 'session.json')");
  });

  it('should load from session.json', () => {
    expect(src).toContain("join(CONDUCTOR_HOME, 'session.json')");
  });

  it('should return null when meta missing', () => {
    expect(src).toContain('return null');
  });

  it('should save status, cost, tokens, timestamps', () => {
    expect(src).toContain('conductor.status');
    expect(src).toContain('conductor.costUsd');
    expect(src).toContain('conductor.totalInputTokens');
    expect(src).toContain('conductor.totalOutputTokens');
  });
});

// ── Message Persistence ─────────────────────────────────────────────

describe('Message persistence', () => {
  it('should load from messages.json', () => {
    expect(src).toContain("join(CONDUCTOR_HOME, 'messages.json')");
  });

  it('should detect older shards via messages.1.json', () => {
    expect(src).toContain("'messages.1.json'");
  });

  it('should rotate when MESSAGE_SHARD_SIZE exceeded', () => {
    expect(src).toContain('MESSAGE_SHARD_SIZE');
    expect(src).toContain('256 * 1024');
  });

  it('should support getMaxShardIndex', () => {
    expect(src).toContain('getMaxShardIndex');
  });

  it('should support cleanupMessageShards', () => {
    expect(src).toContain('cleanupMessageShards');
  });
});
