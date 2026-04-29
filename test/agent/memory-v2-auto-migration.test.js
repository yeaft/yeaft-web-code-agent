/**
 * Auto-migration: when memoryV2 is on and a R6-shaped tree exists,
 * `loadSession` runs migrateR6toV2 once and writes a state file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the heavy bits we don't want loadSession to spin up.
vi.mock('../../agent/unify/llm/adapter.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    createLLMAdapter: vi.fn().mockResolvedValue({ stream: async () => {}, name: 'mock' }),
  };
});

const { loadSession } = await import('../../agent/unify/session.js');

describe('memory v2 auto-migration', () => {
  let dir;

  beforeEach(() => {
    dir = join(tmpdir(), `yeaft-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    // minimal config — memoryV2 on, no LLM, skip everything we can.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      providers: [],
      primaryModel: 'mock',
      memoryV2: true,
      debug: false,
    }));
    // Plant an R6-shaped tree that should trigger migration.
    mkdirSync(join(dir, 'memory', 'groups', 'g-eng'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'groups', 'g-eng', 'summary.md'), 'eng group summary');
    writeFileSync(join(dir, 'memory', 'groups', 'g-eng', 'index.md'), '# index');
  });

  afterEach(async () => {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('runs migration on first boot and records state file', async () => {
    const session = await loadSession({ dir, skipMCP: true, skipSkills: true });
    try {
      const stateFile = join(dir, '.memory-v2-migration.json');
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(state.completedAt).toBeTruthy();
      // R6 layout was migrated → v2 group/g-eng dir should exist
      expect(existsSync(join(dir, 'memory', 'group', 'g-eng'))).toBe(true);
    } finally {
      if (session?.shutdown) await session.shutdown().catch(() => {});
    }
  });

  it('does NOT re-run migration once state file says completed', async () => {
    const stateFile = join(dir, '.memory-v2-migration.json');
    writeFileSync(stateFile, JSON.stringify({
      completedAt: '2026-01-01T00:00:00Z',
      migratedScopes: 0,
      note: 'pre-existing',
    }));

    const session = await loadSession({ dir, skipMCP: true, skipSkills: true });
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(state.completedAt).toBe('2026-01-01T00:00:00Z'); // unchanged
      // R6 dirs untouched
      expect(existsSync(join(dir, 'memory', 'groups', 'g-eng'))).toBe(true);
    } finally {
      if (session?.shutdown) await session.shutdown().catch(() => {});
    }
  });

  it('marks as done with note=fresh when no R6 layout present', async () => {
    // Wipe the R6 we planted in beforeEach
    await fsp.rm(join(dir, 'memory'), { recursive: true, force: true });

    const session = await loadSession({ dir, skipMCP: true, skipSkills: true });
    try {
      const stateFile = join(dir, '.memory-v2-migration.json');
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(state.note).toMatch(/fresh|no R6/i);
      expect(state.migratedScopes).toBe(0);
    } finally {
      if (session?.shutdown) await session.shutdown().catch(() => {});
    }
  });
});
