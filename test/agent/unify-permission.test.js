import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for task-268: Unify ~/.yeaft/ permission fix + graceful error handling.
 *
 * Bug: Agent writes to ~/.yeaft/ without catching EACCES/EPERM, causing raw
 * "Permission denied" errors to show as red messages in the frontend.
 *
 * Fix:
 * 1. initYeaftDir() sets explicit permissions (0755/0644) and returns writable status
 * 2. loadSession() checks writability and sets config._readOnly
 * 3. All write operations in persist.js/store.js catch permission errors gracefully
 * 4. stop-hooks.js shows friendly error messages for permission issues
 * 5. web-bridge.js filters permission errors with one-time friendly diagnostic
 * 6. engine.js skips persistence when config._readOnly is set
 */

// ─── Helpers ────────────────────────────────────────────────────

function createTmpDir() {
  const dir = join(tmpdir(), `yeaft-perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  if (existsSync(dir)) {
    // Restore write permissions before cleanup (in case we removed them)
    try {
      chmodSync(dir, 0o755);
      // Also restore subdirectory permissions
      const restorePermissions = (d) => {
        try {
          const { readdirSync, statSync } = require('fs');
          chmodSync(d, 0o755);
          for (const item of readdirSync(d)) {
            const full = join(d, item);
            try {
              const stat = statSync(full);
              if (stat.isDirectory()) {
                restorePermissions(full);
              } else {
                chmodSync(full, 0o644);
              }
            } catch { /* best effort */ }
          }
        } catch { /* best effort */ }
      };
      restorePermissions(dir);
    } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── init.js tests ──────────────────────────────────────────────

describe('init.js — isPermissionError', () => {
  it('recognizes EACCES errors', async () => {
    const { isPermissionError } = await import('../../agent/unify/init.js');
    expect(isPermissionError({ code: 'EACCES' })).toBe(true);
  });

  it('recognizes EPERM errors', async () => {
    const { isPermissionError } = await import('../../agent/unify/init.js');
    expect(isPermissionError({ code: 'EPERM' })).toBe(true);
  });

  it('rejects other error codes', async () => {
    const { isPermissionError } = await import('../../agent/unify/init.js');
    expect(isPermissionError({ code: 'ENOENT' })).toBe(false);
    expect(isPermissionError({ code: 'EEXIST' })).toBe(false);
  });

  it('handles null/undefined', async () => {
    const { isPermissionError } = await import('../../agent/unify/init.js');
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError({})).toBe(false);
  });
});

describe('init.js — isWritable', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns true for a writable directory', async () => {
    const { isWritable } = await import('../../agent/unify/init.js');
    expect(isWritable(tmpDir)).toBe(true);
  });

  it('returns false for a non-existent directory', async () => {
    const { isWritable } = await import('../../agent/unify/init.js');
    expect(isWritable('/nonexistent-path-that-does-not-exist')).toBe(false);
  });
});

describe('init.js — initYeaftDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns writable: true for a writable directory', async () => {
    const { initYeaftDir } = await import('../../agent/unify/init.js');
    const subDir = join(tmpDir, 'yeaft-writable');
    const result = initYeaftDir(subDir);
    expect(result.writable).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.dir).toBe(subDir);
  });

  it('creates all required subdirectories', async () => {
    const { initYeaftDir } = await import('../../agent/unify/init.js');
    const subDir = join(tmpDir, 'yeaft-new');
    const result = initYeaftDir(subDir);

    expect(existsSync(join(subDir, 'conversation', 'messages'))).toBe(true);
    expect(existsSync(join(subDir, 'conversation', 'cold'))).toBe(true);
    expect(existsSync(join(subDir, 'memory', 'entries'))).toBe(true);
    expect(existsSync(join(subDir, 'tasks'))).toBe(true);
    expect(existsSync(join(subDir, 'dream'))).toBe(true);
    expect(existsSync(join(subDir, 'skills'))).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it('creates default config.json', async () => {
    const { initYeaftDir } = await import('../../agent/unify/init.js');
    const subDir = join(tmpDir, 'yeaft-config');
    initYeaftDir(subDir);

    const configPath = join(subDir, 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('"providers"');
  });

  it('returns warnings array', async () => {
    const { initYeaftDir } = await import('../../agent/unify/init.js');
    const subDir = join(tmpDir, 'yeaft-warnings');
    const result = initYeaftDir(subDir);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ─── session.js code structure tests ────────────────────────────

describe('session.js — readOnly support', () => {
  it('imports isWritable from init.js', async () => {
    const sessionSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'session.js'), 'utf8'
    );
    expect(sessionSrc).toContain("import { initYeaftDir, DEFAULT_YEAFT_DIR, isWritable } from './init.js'");
  });

  it('checks initResult.writable and sets config._readOnly', async () => {
    const sessionSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'session.js'), 'utf8'
    );
    expect(sessionSrc).toContain('initResult.writable');
    expect(sessionSrc).toContain('config._readOnly = true');
  });

  it('stores initYeaftDir result with writable status', async () => {
    const sessionSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'session.js'), 'utf8'
    );
    expect(sessionSrc).toContain('const initResult = initYeaftDir(yeaftDir)');
  });
});

// ─── engine.js readOnly tests ───────────────────────────────────

describe('engine.js — readOnly mode', () => {
  it('checks config._readOnly in persistMessages', async () => {
    const engineSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'engine.js'), 'utf8'
    );
    expect(engineSrc).toContain('this.#config._readOnly');
  });

  it('skips stop hooks in readOnly mode', async () => {
    const engineSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'engine.js'), 'utf8'
    );
    expect(engineSrc).toContain("config._readOnly");
    // Should have a branch that skips persistence
    expect(engineSrc).toContain("Read-only mode: skip all persistence");
  });

  it('skips consolidation in readOnly mode', async () => {
    const engineSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'engine.js'), 'utf8'
    );
    // maybeConsolidate should check _readOnly
    expect(engineSrc).toMatch(/maybeConsolidate[\s\S]*?_readOnly/);
  });
});

// ─── stop-hooks.js permission handling ──────────────────────────

describe('stop-hooks.js — permission error handling', () => {
  it('imports isPermissionError from init.js', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'stop-hooks.js'), 'utf8'
    );
    expect(src).toContain("import { isPermissionError } from './init.js'");
  });

  it('shows friendly message for permission errors', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'stop-hooks.js'), 'utf8'
    );
    expect(src).toContain('Cannot write to ~/.yeaft/ — check directory permissions');
  });

  it('only warns once about permissions (_permissionWarned)', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'stop-hooks.js'), 'utf8'
    );
    expect(src).toContain('_permissionWarned');
  });
});

// ─── web-bridge.js permission filtering ─────────────────────────

describe('web-bridge.js — permission error filtering', () => {
  it('has isPermissionErrorMsg helper', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'web-bridge.js'), 'utf8'
    );
    expect(src).toContain('function isPermissionErrorMsg(msg)');
  });

  it('shows one-time friendly diagnostic for permission errors', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'web-bridge.js'), 'utf8'
    );
    expect(src).toContain('_permissionDiagnosticSent');
    expect(src).toContain('Cannot write to ~/.yeaft/ directory');
    expect(src).toContain('chmod -R u+rw ~/.yeaft/');
  });

  it('does not forward subsequent permission errors', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'web-bridge.js'), 'utf8'
    );
    // After sending the diagnostic once, subsequent permission errors are silenced
    expect(src).toContain("Don't show subsequent permission errors");
  });
});

// ─── conversation/persist.js graceful handling ──────────────────

describe('conversation/persist.js — graceful error handling', () => {
  it('imports isPermissionError', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'conversation', 'persist.js'), 'utf8'
    );
    expect(src).toContain("import { isPermissionError } from '../init.js'");
  });

  it('wraps append() writeFileSync in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'conversation', 'persist.js'), 'utf8'
    );
    // The append method should have permission error handling
    expect(src).toContain('Cannot write message');
    expect(src).toContain('message not persisted');
  });

  it('wraps constructor mkdirSync in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'conversation', 'persist.js'), 'utf8'
    );
    expect(src).toContain('persistence disabled');
  });

  it('wraps updateCompactSummary in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'conversation', 'persist.js'), 'utf8'
    );
    expect(src).toContain('Cannot write compact summary');
  });

  it('wraps updateIndex in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'conversation', 'persist.js'), 'utf8'
    );
    expect(src).toContain('Cannot write conversation index');
  });

  it('sets file mode 0o644 on writes', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'conversation', 'persist.js'), 'utf8'
    );
    expect(src).toContain('mode: 0o644');
  });
});

// ─── memory/store.js graceful handling ──────────────────────────

describe('memory/store.js — graceful error handling', () => {
  it('imports isPermissionError', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'memory', 'store.js'), 'utf8'
    );
    expect(src).toContain("import { isPermissionError } from '../init.js'");
  });

  it('wraps constructor mkdirSync in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'memory', 'store.js'), 'utf8'
    );
    expect(src).toContain('memory persistence disabled');
  });

  it('wraps writeProfile in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'memory', 'store.js'), 'utf8'
    );
    expect(src).toContain('Cannot write MEMORY.md');
  });

  it('wraps writeEntry in try-catch', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'memory', 'store.js'), 'utf8'
    );
    expect(src).toContain('Cannot write memory entry');
  });

  it('sets file mode 0o644 on writes', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'memory', 'store.js'), 'utf8'
    );
    expect(src).toContain('mode: 0o644');
  });
});

// ─── Functional: ConversationStore still works with writable dirs ─

describe('ConversationStore — normal operation (writable dir)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    // Create subdirectories
    mkdirSync(join(tmpDir, 'conversation', 'messages'), { recursive: true });
    mkdirSync(join(tmpDir, 'conversation', 'cold'), { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('appends and loads messages normally', async () => {
    const { ConversationStore } = await import('../../agent/unify/conversation/persist.js');
    const store = new ConversationStore(tmpDir);

    const msg = store.append({
      role: 'user',
      content: 'Hello world',
      mode: 'chat',
    });

    expect(msg.id).toMatch(/^m\d{4}$/);
    expect(msg.role).toBe('user');

    const loaded = store.loadAll();
    expect(loaded.length).toBe(1);
    expect(loaded[0].content).toBe('Hello world');
  });
});

// ─── Functional: MemoryStore still works with writable dirs ──────

describe('MemoryStore — normal operation (writable dir)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
    mkdirSync(join(tmpDir, 'memory', 'entries'), { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('writes and reads entries normally', async () => {
    const { MemoryStore } = await import('../../agent/unify/memory/store.js');
    const store = new MemoryStore(tmpDir);

    const slug = store.writeEntry({
      name: 'test-entry',
      kind: 'fact',
      scope: 'global',
      tags: ['test'],
      content: 'This is a test',
    });

    expect(slug).toBe('test-entry');
    const entry = store.readEntry('test-entry');
    expect(entry).not.toBeNull();
    expect(entry.content).toBe('This is a test');
  });
});

// ─── index.js exports ──────────────────────────────────────────

describe('index.js exports new permission utilities', () => {
  it('exports isPermissionError and isWritable', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'index.js'), 'utf8'
    );
    expect(src).toContain('isWritable');
    expect(src).toContain('isPermissionError');
  });
});
