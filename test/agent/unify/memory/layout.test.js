/**
 * layout.test.js — task-287 new-layout memory helpers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  memoryDir,
  ensureLayout,
  readMemoryFile,
  writeMemoryFile,
  listClassificationFiles,
  findProjectFile,
  excerpt,
  renderIndex,
  buildMemoryInjection,
  SINGLE_FILES,
  CATEGORY_DIRS,
  PROMPT_INJECTION_CHAR_BUDGET,
} from '../../../../agent/unify/memory/layout.js';

let TEST_DIR;

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `yeaft-layout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('memoryDir / ensureLayout', () => {
  it('creates the new-layout directory skeleton', () => {
    ensureLayout(TEST_DIR);
    const root = memoryDir(TEST_DIR);
    expect(existsSync(root)).toBe(true);
    for (const d of CATEGORY_DIRS) {
      expect(existsSync(join(root, d))).toBe(true);
    }
    expect(existsSync(join(root, 'entries'))).toBe(true);
  });

  it('is idempotent', () => {
    ensureLayout(TEST_DIR);
    ensureLayout(TEST_DIR);
    expect(existsSync(memoryDir(TEST_DIR))).toBe(true);
  });
});

describe('readMemoryFile / writeMemoryFile', () => {
  it('writes and reads a file under memory/', () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', '# Preferences\n\n- likes dark mode\n');
    const text = readMemoryFile(TEST_DIR, 'user-preferences.md');
    expect(text).toContain('dark mode');
  });

  it('returns empty string for missing files', () => {
    expect(readMemoryFile(TEST_DIR, 'nope.md')).toBe('');
  });
});

describe('listClassificationFiles', () => {
  it('lists single files and category files', () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', '# Prefs\n');
    writeMemoryFile(TEST_DIR, 'by-project/claude-web-chat.md', '# Project\n');
    writeMemoryFile(TEST_DIR, 'by-topic/memory.md', '# Topic\n');

    const list = listClassificationFiles(TEST_DIR);
    const paths = list.map(f => f.path);
    expect(paths).toContain('user-preferences.md');
    expect(paths).toContain('by-project/claude-web-chat.md');
    expect(paths).toContain('by-topic/memory.md');
  });
});

describe('findProjectFile', () => {
  it('matches exact slug', () => {
    writeMemoryFile(TEST_DIR, 'by-project/claude-web-chat.md', '# x\n');
    expect(findProjectFile(TEST_DIR, '/home/user/claude-web-chat')).toBe('by-project/claude-web-chat.md');
  });

  it('matches substring either direction', () => {
    writeMemoryFile(TEST_DIR, 'by-project/claude.md', '# x\n');
    expect(findProjectFile(TEST_DIR, '/home/user/claude-web-chat')).toBe('by-project/claude.md');
  });

  it('returns null when no match', () => {
    writeMemoryFile(TEST_DIR, 'by-project/some-other.md', '# x\n');
    expect(findProjectFile(TEST_DIR, '/home/user/claude-web-chat')).toBeNull();
  });

  it('returns null for missing by-project dir', () => {
    expect(findProjectFile(TEST_DIR, '/some/cwd')).toBeNull();
  });
});

describe('excerpt', () => {
  it('returns full text if under budget', () => {
    expect(excerpt('hello', 100)).toBe('hello');
  });

  it('trims to last newline when over budget', () => {
    const text = 'line1\nline2\nline3\nline4\nline5\n';
    const out = excerpt(text, 15);
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out).toContain('line');
  });
});

describe('renderIndex', () => {
  it('renders a Memory Index with sections', () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', '# User Preferences\n\nLikes dark mode\n');
    writeMemoryFile(TEST_DIR, 'by-project/foo.md', '# foo\n\nfoo project summary\n');
    writeMemoryFile(TEST_DIR, 'by-topic/memory.md', '# memory\n\nmemory topic\n');
    writeMemoryFile(TEST_DIR, 'timeline/2026-04.md', '# April 2026\n\nmonth digest\n');

    const idx = renderIndex(TEST_DIR, 42);
    expect(idx).toContain('# Memory Index');
    expect(idx).toContain('user-preferences.md');
    expect(idx).toContain('by-project/foo.md');
    expect(idx).toContain('by-topic/memory.md');
    expect(idx).toContain('timeline/2026-04.md');
    expect(idx).toContain('42 atomic entries');
    expect(idx).toContain('memory_query');
  });
});

describe('buildMemoryInjection', () => {
  it('returns Memory Index heading plus auto-generated index when index.md missing', () => {
    const out = buildMemoryInjection({ yeaftDir: TEST_DIR, entryCount: 3 });
    expect(out).toContain('## Memory Index');
    expect(out).toContain('3 atomic entries');
  });

  it('includes user-preferences when present', () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', 'Likes typescript');
    const out = buildMemoryInjection({ yeaftDir: TEST_DIR });
    expect(out).toContain('## User Preferences');
    expect(out).toContain('typescript');
  });

  it('includes project header when cwd matches', () => {
    writeMemoryFile(TEST_DIR, 'by-project/claude-web-chat.md', '# claude-web-chat\n\nYeaft Unify notes.\n');
    const out = buildMemoryInjection({ yeaftDir: TEST_DIR, cwd: '/tmp/claude-web-chat' });
    expect(out).toContain('## Current Project Summary');
    expect(out).toContain('Yeaft Unify notes');
  });

  it('supports zh headings', () => {
    const out = buildMemoryInjection({ yeaftDir: TEST_DIR, language: 'zh' });
    expect(out).toContain('## 记忆索引');
  });

  it('enforces char budget by dropping trailing sections', () => {
    // Make a huge user-preferences file to push us over budget
    writeMemoryFile(TEST_DIR, 'user-preferences.md', 'x'.repeat(PROMPT_INJECTION_CHAR_BUDGET * 2));
    writeMemoryFile(TEST_DIR, 'by-project/test.md', '# test\nproject notes');
    const out = buildMemoryInjection({ yeaftDir: TEST_DIR, cwd: '/tmp/test' });
    expect(out.length).toBeLessThanOrEqual(PROMPT_INJECTION_CHAR_BUDGET);
  });

  it('returns empty string without yeaftDir', () => {
    expect(buildMemoryInjection({})).toBe('');
  });
});
