import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryStore, parseEntry, serializeEntry, slugify, MEMORY_KINDS } from '../../../../agent/unify/memory/store.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-mem-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── slugify ────────────────────────────────────────────────────

describe('slugify', () => {
  it('should create a filename-safe slug', () => {
    expect(slugify('Auth Null Check Pattern')).toBe('auth-null-check-pattern');
    expect(slugify('user-prefers-typescript')).toBe('user-prefers-typescript');
    expect(slugify('Hello World!!!')).toBe('hello-world');
  });

  it('should handle CJK characters', () => {
    const slug = slugify('用户偏好typescript');
    expect(slug).toContain('用户偏好');
    expect(slug).toContain('typescript');
  });

  it('should truncate to 60 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

// ─── parseEntry / serializeEntry ────────────────────────────────

describe('parseEntry', () => {
  it('should parse a well-formed entry', () => {
    const raw = `---
name: auth-null-check
kind: lesson
scope: work/project/auth
tags: [null-check, typescript, auth]
importance: high
frequency: 3
created_at: 2026-04-09T14:30:00Z
updated_at: 2026-04-09T15:00:00Z
---

# Auth Null Check Pattern

JWT 解析经常忘记 null check`;

    const entry = parseEntry(raw);
    expect(entry.name).toBe('auth-null-check');
    expect(entry.kind).toBe('lesson');
    expect(entry.scope).toBe('work/project/auth');
    expect(entry.tags).toEqual(['null-check', 'typescript', 'auth']);
    expect(entry.importance).toBe('high');
    expect(entry.frequency).toBe(3);
    expect(entry.content).toContain('Auth Null Check Pattern');
  });

  it('should return null for invalid input', () => {
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry('')).toBeNull();
    expect(parseEntry('no frontmatter')).toBeNull();
  });

  it('should parse related field', () => {
    const raw = `---
name: test
kind: fact
scope: global
tags: [a, b]
importance: normal
frequency: 1
related: [other-entry, another-one]
created_at: 2026-04-10T10:00:00Z
updated_at: 2026-04-10T10:00:00Z
---

Test content`;

    const entry = parseEntry(raw);
    expect(entry.related).toEqual(['other-entry', 'another-one']);
  });
});

describe('serializeEntry', () => {
  it('should round-trip through parse/serialize', () => {
    const original = {
      name: 'test-entry',
      kind: 'fact',
      scope: 'tech/typescript',
      tags: ['ts', 'generics'],
      importance: 'normal',
      frequency: 2,
      content: 'TypeScript generics are powerful.',
    };

    const serialized = serializeEntry(original);
    const parsed = parseEntry(serialized);

    expect(parsed.name).toBe(original.name);
    expect(parsed.kind).toBe(original.kind);
    expect(parsed.scope).toBe(original.scope);
    expect(parsed.tags).toEqual(original.tags);
    expect(parsed.frequency).toBe(original.frequency);
    expect(parsed.content).toBe(original.content);
  });
});

// ─── MEMORY_KINDS ───────────────────────────────────────────────

describe('MEMORY_KINDS', () => {
  it('should have exactly 6 kinds', () => {
    expect(MEMORY_KINDS).toHaveLength(6);
    expect(MEMORY_KINDS).toContain('fact');
    expect(MEMORY_KINDS).toContain('preference');
    expect(MEMORY_KINDS).toContain('skill');
    expect(MEMORY_KINDS).toContain('lesson');
    expect(MEMORY_KINDS).toContain('context');
    expect(MEMORY_KINDS).toContain('relation');
  });
});

// ─── MemoryStore ────────────────────────────────────────────────

describe('MemoryStore', () => {
  let store;

  beforeEach(() => {
    store = new MemoryStore(TEST_DIR);
  });

  describe('constructor', () => {
    it('should create memory directories', () => {
      expect(existsSync(join(TEST_DIR, 'memory'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'memory', 'entries'))).toBe(true);
    });
  });

  describe('MEMORY.md (profile)', () => {
    it('should read/write profile', () => {
      store.writeProfile('# User Profile\n\nLikes TypeScript.');
      expect(store.readProfile()).toContain('Likes TypeScript.');
    });

    it('should return empty string when no profile', () => {
      expect(store.readProfile()).toBe('');
    });

    it('should read sections', () => {
      store.writeProfile('# Memory\n\n## Facts\n\n- Uses TypeScript\n\n## Preferences\n\n- Dark mode\n');
      expect(store.readSection('Facts')).toContain('Uses TypeScript');
      expect(store.readSection('Preferences')).toContain('Dark mode');
      expect(store.readSection('NonExistent')).toBe('');
    });

    it('should add to existing section', () => {
      store.writeProfile('# Memory\n\n## Facts\n\n- Fact 1\n');
      store.addToSection('Facts', '- Fact 2');
      const content = store.readProfile();
      expect(content).toContain('Fact 1');
      expect(content).toContain('Fact 2');
    });

    it('should create new section if missing', () => {
      store.writeProfile('# Memory\n');
      store.addToSection('NewSection', '- Entry 1');
      expect(store.readProfile()).toContain('## NewSection');
      expect(store.readProfile()).toContain('Entry 1');
    });
  });

  describe('entries CRUD', () => {
    it('should write and read an entry', () => {
      const slug = store.writeEntry({
        name: 'Test Entry',
        kind: 'fact',
        scope: 'global',
        tags: ['test'],
        content: 'This is a test entry.',
      });

      expect(slug).toBe('test-entry');
      const entry = store.readEntry('test-entry');
      expect(entry).not.toBeNull();
      expect(entry.name).toBe('Test Entry');
      expect(entry.kind).toBe('fact');
      expect(entry.content).toBe('This is a test entry.');
    });

    it('should list all entries', () => {
      store.writeEntry({ name: 'Entry A', kind: 'fact', content: 'A' });
      store.writeEntry({ name: 'Entry B', kind: 'preference', content: 'B' });

      const entries = store.listEntries();
      expect(entries).toHaveLength(2);
    });

    it('should delete an entry', () => {
      store.writeEntry({ name: 'To Delete', kind: 'fact', content: 'Delete me' });
      expect(store.readEntry('to-delete')).not.toBeNull();

      const deleted = store.deleteEntry('to-delete');
      expect(deleted).toBe(true);
      expect(store.readEntry('to-delete')).toBeNull();
    });

    it('should handle non-existent delete gracefully', () => {
      expect(store.deleteEntry('nonexistent')).toBe(false);
    });

    it('should write multiple entries', () => {
      const slugs = store.writeEntries([
        { name: 'Multi A', kind: 'fact', content: 'A' },
        { name: 'Multi B', kind: 'skill', content: 'B' },
      ]);
      expect(slugs).toHaveLength(2);
      expect(store.listEntries()).toHaveLength(2);
    });

    it('should bump frequency', () => {
      store.writeEntry({ name: 'Freq Test', kind: 'fact', content: 'Test', frequency: 1 });
      store.bumpFrequency('freq-test');
      const entry = store.readEntry('freq-test');
      expect(entry.frequency).toBe(2);
    });
  });

  describe('scopes', () => {
    it('should rebuild scopes from entries', () => {
      store.writeEntry({ name: 'E1', kind: 'fact', scope: 'global', tags: ['a'], content: 'A' });
      store.writeEntry({ name: 'E2', kind: 'fact', scope: 'tech/ts', tags: ['b'], content: 'B' });
      store.writeEntry({ name: 'E3', kind: 'lesson', scope: 'tech/ts', tags: ['c'], content: 'C' });

      store.rebuildScopes();
      const scopes = store.readScopes();

      expect(scopes).toHaveLength(2);
      const globalScope = scopes.find(s => s.scope === 'global');
      const tsScope = scopes.find(s => s.scope === 'tech/ts');
      expect(globalScope.count).toBe(1);
      expect(tsScope.count).toBe(2);
    });

    it('should return empty when no scopes file', () => {
      expect(store.readScopes()).toEqual([]);
    });
  });

  describe('findByFilter', () => {
    beforeEach(() => {
      store.writeEntry({ name: 'ts-generics', kind: 'skill', scope: 'tech/typescript', tags: ['typescript', 'generics'], content: 'TS generics' });
      store.writeEntry({ name: 'auth-bug', kind: 'lesson', scope: 'work/project/auth', tags: ['auth', 'bugfix'], content: 'Auth bug' });
      store.writeEntry({ name: 'user-pref', kind: 'preference', scope: 'global', tags: ['dark-mode'], content: 'Dark mode' });
    });

    it('should find by scope', () => {
      const results = store.findByFilter({ scope: 'tech/typescript' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('ts-generics');
    });

    it('should find by tags', () => {
      const results = store.findByFilter({ tags: ['auth'] });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.name === 'auth-bug')).toBe(true);
    });

    it('should score exact scope higher than ancestor', () => {
      const results = store.findByFilter({ scope: 'tech/typescript', tags: ['typescript'] });
      expect(results[0].name).toBe('ts-generics');
    });

    it('should return empty when no scope or tag matches', () => {
      // Note: global scope entries always get a score of 1 for any scope query
      // So we test with no scope to ensure tags-only mismatch returns empty
      const results = store.findByFilter({ tags: ['nonexistent-tag-xyz'] });
      expect(results).toEqual([]);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      store.writeEntry({ name: 'TypeScript Facts', kind: 'fact', tags: ['ts'], content: 'TypeScript is great' });
      store.writeEntry({ name: 'Python Facts', kind: 'fact', tags: ['python'], content: 'Python is versatile' });
    });

    it('should find by keyword in content', () => {
      const results = store.search('TypeScript');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('TypeScript Facts');
    });

    it('should find by keyword in tags', () => {
      const results = store.search('python');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for no matches', () => {
      expect(store.search('nonexistent')).toEqual([]);
    });

    it('should return empty for empty keyword', () => {
      expect(store.search('')).toEqual([]);
    });
  });

  describe('stats', () => {
    it('should return correct stats', () => {
      store.writeEntry({ name: 'S1', kind: 'fact', scope: 'global', content: 'A' });
      store.writeEntry({ name: 'S2', kind: 'lesson', scope: 'tech/ts', content: 'B' });

      const s = store.stats();
      expect(s.entryCount).toBe(2);
      expect(s.scopes).toContain('global');
      expect(s.scopes).toContain('tech/ts');
      expect(s.kinds.fact).toBe(1);
      expect(s.kinds.lesson).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all entries and profile', () => {
      store.writeEntry({ name: 'X', kind: 'fact', content: 'X' });
      store.writeProfile('Profile content');
      store.rebuildScopes();

      store.clear();

      expect(store.listEntries()).toHaveLength(0);
      expect(store.readProfile()).toBe('');
      expect(store.readScopes()).toEqual([]);
    });
  });
});
