import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for Conductor persistence logic.
 *
 * Replicates persistence functions from agent/conductor/persistence.js
 * using temp directories instead of ~/.claude.
 */

// =====================================================================
// Replicate persistence functions with configurable base dir
// =====================================================================

let testDir;

function getSessionDataDir(baseDir, sessionId) {
  return join(baseDir, sessionId);
}

async function initSessionDataDir(baseDir, sessionId) {
  const dir = getSessionDataDir(baseDir, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function initTaskDir(workDir, taskId) {
  const taskDir = join(workDir, '.conductor', 'tasks', taskId);
  await fs.mkdir(taskDir, { recursive: true });
  return taskDir;
}

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    status: session.status,
    name: session.name || '',
    workDir: session.workDir || null,
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    scenarioId: session.scenarioId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

async function loadIndex(indexPath) {
  try { return JSON.parse(await fs.readFile(indexPath, 'utf-8')); }
  catch { return []; }
}

async function saveIndex(indexPath, index) {
  const data = JSON.stringify(index, null, 2);
  const tmpPath = indexPath + '.tmp';
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, indexPath);
}

async function upsertIndex(indexPath, session) {
  const index = await loadIndex(indexPath);
  const entry = sessionToIndexEntry(session);
  const idx = index.findIndex(e => e.sessionId === session.id);
  if (idx >= 0) index[idx] = entry; else index.push(entry);
  await saveIndex(indexPath, index);
}

async function removeFromIndex(indexPath, sessionId) {
  const index = await loadIndex(indexPath);
  const filtered = index.filter(e => e.sessionId !== sessionId);
  if (filtered.length !== index.length) {
    await saveIndex(indexPath, filtered);
    return true;
  }
  return false;
}

async function hideInIndex(indexPath, sessionId) {
  const index = await loadIndex(indexPath);
  const entry = index.find(e => e.sessionId === sessionId);
  if (entry) {
    entry.hidden = true;
    entry.hiddenAt = Date.now();
    await saveIndex(indexPath, index);
    return true;
  }
  return false;
}

async function saveSessionMeta(dir, meta) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'session.json'), JSON.stringify(meta, null, 2));
}

async function loadSessionMeta(dir) {
  try { return JSON.parse(await fs.readFile(join(dir, 'session.json'), 'utf-8')); }
  catch { return null; }
}

async function getMaxShardIndex(dir) {
  let max = 0;
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      const match = f.match(/^messages\.(\d+)\.json$/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (idx > max) max = idx;
      }
    }
  } catch { /* dir may not exist */ }
  return max;
}

async function cleanupMessageShards(dir) {
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (/^messages\.\d+\.json$/.test(f)) {
        await fs.unlink(join(dir, f)).catch(() => {});
      }
    }
  } catch { /* dir may not exist */ }
}

async function loadSessionMessages(dir) {
  let messages = [];
  try { messages = JSON.parse(await fs.readFile(join(dir, 'messages.json'), 'utf-8')); }
  catch { /* file may not exist */ }
  let hasOlderMessages = false;
  try {
    await fs.access(join(dir, 'messages.1.json'));
    hasOlderMessages = true;
  } catch { /* no older shards */ }
  return { messages, hasOlderMessages };
}

// =====================================================================
// Tests
// =====================================================================

describe('Conductor Persistence', () => {
  beforeEach(async () => {
    testDir = join(tmpdir(), `conductor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('Session Data Directory', () => {
    it('should compute correct session data dir path', () => {
      const dir = getSessionDataDir(testDir, 'session-123');
      expect(dir).toBe(join(testDir, 'session-123'));
    });

    it('should create session data directory', async () => {
      const dir = await initSessionDataDir(testDir, 'session-new');
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should be idempotent (create twice is safe)', async () => {
      await initSessionDataDir(testDir, 'session-idem');
      await initSessionDataDir(testDir, 'session-idem');
      const dir = getSessionDataDir(testDir, 'session-idem');
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('Task Directory', () => {
    it('should create .conductor/tasks/<taskId> under workDir', async () => {
      const workDir = join(testDir, 'project');
      await fs.mkdir(workDir, { recursive: true });

      const taskDir = await initTaskDir(workDir, 'task-001');
      expect(taskDir).toBe(join(workDir, '.conductor', 'tasks', 'task-001'));

      const stat = await fs.stat(taskDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create nested directories as needed', async () => {
      const workDir = join(testDir, 'deep', 'project');
      const taskDir = await initTaskDir(workDir, 'task-deep');
      const stat = await fs.stat(taskDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('Conductor Index (global)', () => {
    let indexPath;

    beforeEach(() => {
      indexPath = join(testDir, 'conductor-sessions.json');
    });

    it('should return empty array for non-existent index', async () => {
      const index = await loadIndex(indexPath);
      expect(index).toEqual([]);
    });

    it('should save and load index', async () => {
      const entries = [
        { sessionId: 's1', status: 'running', name: 'S1' },
        { sessionId: 's2', status: 'stopped', name: 'S2' }
      ];
      await saveIndex(indexPath, entries);
      const loaded = await loadIndex(indexPath);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].sessionId).toBe('s1');
      expect(loaded[1].sessionId).toBe('s2');
    });

    it('should upsert: add new session to index', async () => {
      const session = {
        id: 'new-session', status: 'running', name: 'New',
        workDir: '/project', userId: 'u1', username: 'alice',
        agentId: null, scenarioId: null, createdAt: Date.now()
      };

      await upsertIndex(indexPath, session);
      const index = await loadIndex(indexPath);
      expect(index).toHaveLength(1);
      expect(index[0].sessionId).toBe('new-session');
    });

    it('should upsert: update existing session in index', async () => {
      const session = {
        id: 'update-session', status: 'running', name: 'Original',
        workDir: '/p', userId: 'u1', username: 'a',
        agentId: null, scenarioId: null, createdAt: Date.now()
      };

      await upsertIndex(indexPath, session);

      // Update status
      session.status = 'stopped';
      session.name = 'Updated';
      await upsertIndex(indexPath, session);

      const index = await loadIndex(indexPath);
      expect(index).toHaveLength(1);
      expect(index[0].status).toBe('stopped');
      expect(index[0].name).toBe('Updated');
    });

    it('should remove session from index', async () => {
      await saveIndex(indexPath, [
        { sessionId: 's1' },
        { sessionId: 's2' },
        { sessionId: 's3' }
      ]);

      const removed = await removeFromIndex(indexPath, 's2');
      expect(removed).toBe(true);

      const index = await loadIndex(indexPath);
      expect(index).toHaveLength(2);
      expect(index.map(e => e.sessionId)).toEqual(['s1', 's3']);
    });

    it('should return false when removing non-existent session', async () => {
      await saveIndex(indexPath, [{ sessionId: 's1' }]);
      const removed = await removeFromIndex(indexPath, 'non-existent');
      expect(removed).toBe(false);
    });

    it('should hide session in index', async () => {
      await saveIndex(indexPath, [
        { sessionId: 's1', hidden: false },
        { sessionId: 's2', hidden: false }
      ]);

      const hidden = await hideInIndex(indexPath, 's1');
      expect(hidden).toBe(true);

      const index = await loadIndex(indexPath);
      expect(index[0].hidden).toBe(true);
      expect(index[0].hiddenAt).toBeDefined();
      expect(index[1].hidden).toBe(false);
    });

    it('should handle concurrent upserts gracefully', async () => {
      const sessions = [];
      for (let i = 0; i < 5; i++) {
        sessions.push({
          id: `concurrent-${i}`, status: 'running', name: `S${i}`,
          workDir: '/p', userId: 'u', username: 'a',
          agentId: null, scenarioId: null, createdAt: Date.now()
        });
      }

      // Upsert sequentially (in real code, _indexWriteLock serializes)
      for (const s of sessions) {
        await upsertIndex(indexPath, s);
      }

      const index = await loadIndex(indexPath);
      expect(index).toHaveLength(5);
    });
  });

  describe('Session Metadata', () => {
    it('should save and load session metadata', async () => {
      const dir = join(testDir, 'meta-session');
      await fs.mkdir(dir, { recursive: true });

      const meta = {
        sessionId: 'meta-session',
        name: 'Test Session',
        status: 'running',
        workDir: '/project',
        tasks: [{ taskId: 't1', title: 'Task 1' }],
        costUsd: 0.05,
        totalInputTokens: 1000,
        totalOutputTokens: 500
      };

      await saveSessionMeta(dir, meta);
      const loaded = await loadSessionMeta(dir);

      expect(loaded.sessionId).toBe('meta-session');
      expect(loaded.name).toBe('Test Session');
      expect(loaded.tasks).toHaveLength(1);
      expect(loaded.costUsd).toBe(0.05);
    });

    it('should return null for non-existent metadata', async () => {
      const result = await loadSessionMeta(join(testDir, 'non-existent'));
      expect(result).toBeNull();
    });

    it('should overwrite existing metadata', async () => {
      const dir = join(testDir, 'overwrite-session');
      await fs.mkdir(dir, { recursive: true });

      await saveSessionMeta(dir, { sessionId: 's1', name: 'V1' });
      await saveSessionMeta(dir, { sessionId: 's1', name: 'V2' });

      const loaded = await loadSessionMeta(dir);
      expect(loaded.name).toBe('V2');
    });
  });

  describe('Message Shards', () => {
    it('should return 0 max shard index for empty directory', async () => {
      const dir = join(testDir, 'empty-dir');
      await fs.mkdir(dir, { recursive: true });
      expect(await getMaxShardIndex(dir)).toBe(0);
    });

    it('should return 0 for non-existent directory', async () => {
      expect(await getMaxShardIndex(join(testDir, 'no-such-dir'))).toBe(0);
    });

    it('should find max shard index', async () => {
      const dir = join(testDir, 'shard-dir');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'messages.1.json'), '[]');
      await fs.writeFile(join(dir, 'messages.2.json'), '[]');
      await fs.writeFile(join(dir, 'messages.5.json'), '[]');
      await fs.writeFile(join(dir, 'messages.json'), '[]'); // current, not a shard

      expect(await getMaxShardIndex(dir)).toBe(5);
    });

    it('should ignore non-shard files', async () => {
      const dir = join(testDir, 'mixed-dir');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'messages.json'), '[]');
      await fs.writeFile(join(dir, 'session.json'), '{}');
      await fs.writeFile(join(dir, 'messages.abc.json'), '[]'); // not a number

      expect(await getMaxShardIndex(dir)).toBe(0);
    });

    it('should cleanup shard files', async () => {
      const dir = join(testDir, 'cleanup-dir');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'messages.1.json'), '[]');
      await fs.writeFile(join(dir, 'messages.2.json'), '[]');
      await fs.writeFile(join(dir, 'messages.json'), '[]'); // should NOT be deleted
      await fs.writeFile(join(dir, 'session.json'), '{}'); // should NOT be deleted

      await cleanupMessageShards(dir);

      const files = await fs.readdir(dir);
      expect(files).toContain('messages.json');
      expect(files).toContain('session.json');
      expect(files).not.toContain('messages.1.json');
      expect(files).not.toContain('messages.2.json');
    });

    it('should handle cleanup of non-existent directory gracefully', async () => {
      await cleanupMessageShards(join(testDir, 'no-such-dir'));
      // Should not throw
    });
  });

  describe('loadSessionMessages', () => {
    it('should load messages from messages.json', async () => {
      const dir = join(testDir, 'load-msgs');
      await fs.mkdir(dir, { recursive: true });
      const msgs = [
        { source: 'user', type: 'text', content: 'hi' },
        { source: 'conductor', type: 'text', content: 'hello' }
      ];
      await fs.writeFile(join(dir, 'messages.json'), JSON.stringify(msgs));

      const result = await loadSessionMessages(dir);
      expect(result.messages).toHaveLength(2);
      expect(result.hasOlderMessages).toBe(false);
    });

    it('should detect older shards', async () => {
      const dir = join(testDir, 'load-older');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'messages.json'), JSON.stringify([{ content: 'current' }]));
      await fs.writeFile(join(dir, 'messages.1.json'), JSON.stringify([{ content: 'older' }]));

      const result = await loadSessionMessages(dir);
      expect(result.messages).toHaveLength(1);
      expect(result.hasOlderMessages).toBe(true);
    });

    it('should return empty messages for non-existent dir', async () => {
      const result = await loadSessionMessages(join(testDir, 'no-dir'));
      expect(result.messages).toEqual([]);
      expect(result.hasOlderMessages).toBe(false);
    });

    it('should return empty messages for dir without messages.json', async () => {
      const dir = join(testDir, 'no-msgs');
      await fs.mkdir(dir, { recursive: true });
      const result = await loadSessionMessages(dir);
      expect(result.messages).toEqual([]);
    });
  });

  describe('History Loading (shard validation)', () => {
    it('should validate shardIndex is a finite positive number', () => {
      // Replicate the validation logic
      const testCases = [
        { input: '1', valid: true },
        { input: '5', valid: true },
        { input: '0', valid: false },
        { input: '-1', valid: false },
        { input: 'abc', valid: false },
        { input: undefined, valid: false },
        { input: 'NaN', valid: false }
      ];

      for (const tc of testCases) {
        const shardIndex = parseInt(tc.input, 10);
        const isValid = Number.isFinite(shardIndex) && shardIndex >= 1;
        expect(isValid).toBe(tc.valid);
      }
    });

    it('should load shard file by index', async () => {
      const dir = join(testDir, 'history-load');
      await fs.mkdir(dir, { recursive: true });
      const archiveData = [{ content: 'archived msg 1' }, { content: 'archived msg 2' }];
      await fs.writeFile(join(dir, 'messages.1.json'), JSON.stringify(archiveData));

      const shardPath = join(dir, 'messages.1.json');
      const messages = JSON.parse(await fs.readFile(shardPath, 'utf-8'));
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('archived msg 1');
    });

    it('should return empty for non-existent shard', async () => {
      const dir = join(testDir, 'history-missing');
      await fs.mkdir(dir, { recursive: true });

      let messages = [];
      try {
        messages = JSON.parse(await fs.readFile(join(dir, 'messages.99.json'), 'utf-8'));
      } catch { /* expected */ }
      expect(messages).toEqual([]);
    });

    it('should determine hasMore based on shard index vs max', async () => {
      const dir = join(testDir, 'history-more');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'messages.1.json'), '[]');
      await fs.writeFile(join(dir, 'messages.2.json'), '[]');
      await fs.writeFile(join(dir, 'messages.3.json'), '[]');

      const max = await getMaxShardIndex(dir);
      expect(1 < max).toBe(true);  // shardIndex=1, hasMore=true
      expect(2 < max).toBe(true);  // shardIndex=2, hasMore=true
      expect(3 < max).toBe(false); // shardIndex=3, hasMore=false
    });
  });
});
