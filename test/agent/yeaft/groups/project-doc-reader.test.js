/**
 * project-doc-reader.test.js — pickProjectDocFile + readProjectDoc.
 *
 * These tests stress the stateless reader:
 *   • workDir validation (empty / non-existent / non-directory)
 *   • single-file presence (CLAUDE.md or AGENTS.md alone)
 *   • mtime-based pick when both files exist
 *   • deterministic tie-break (CLAUDE.md wins on identical mtime)
 *   • size cap + truncation + warn
 *   • empty / whitespace-only file → null
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  pickProjectDocFile,
  readProjectDoc,
  PROJECT_DOC_FILENAMES,
  DEFAULT_PROJECT_DOC_MAX_BYTES,
} from '../../../../agent/yeaft/groups/project-doc.js';

describe('pickProjectDocFile', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'yeaft-pdoc-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns null for empty / non-string workDir', () => {
    expect(pickProjectDocFile('')).toBeNull();
    expect(pickProjectDocFile(undefined)).toBeNull();
    expect(pickProjectDocFile(null)).toBeNull();
    expect(pickProjectDocFile(42)).toBeNull();
  });

  it('returns null for non-existent directory', () => {
    expect(pickProjectDocFile('/this/path/does/not/exist/xyz')).toBeNull();
  });

  it('returns null when workDir exists but is a file, not a directory', () => {
    const filePath = join(workDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'hello');
    expect(pickProjectDocFile(filePath)).toBeNull();
  });

  it('returns null when neither CLAUDE.md nor AGENTS.md exists', () => {
    writeFileSync(join(workDir, 'README.md'), '# Hi');
    expect(pickProjectDocFile(workDir)).toBeNull();
  });

  it('picks CLAUDE.md when only CLAUDE.md present', () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), '# Claude');
    const picked = pickProjectDocFile(workDir);
    expect(picked).not.toBeNull();
    expect(picked.path).toBe(join(workDir, 'CLAUDE.md'));
    expect(typeof picked.mtimeMs).toBe('number');
  });

  it('picks AGENTS.md when only AGENTS.md present', () => {
    writeFileSync(join(workDir, 'AGENTS.md'), '# Agents');
    const picked = pickProjectDocFile(workDir);
    expect(picked).not.toBeNull();
    expect(picked.path).toBe(join(workDir, 'AGENTS.md'));
  });

  it('picks the file with newer mtime when both exist', () => {
    const claudePath = join(workDir, 'CLAUDE.md');
    const agentsPath = join(workDir, 'AGENTS.md');
    writeFileSync(claudePath, '# Claude');
    writeFileSync(agentsPath, '# Agents');
    // Force CLAUDE.md older than AGENTS.md. Dates here are ms since
    // epoch — `new Date(ms)` expects milliseconds, not seconds.
    utimesSync(claudePath, new Date(1700000000000), new Date(1700000000000));
    utimesSync(agentsPath, new Date(1800000000000), new Date(1800000000000));

    const picked = pickProjectDocFile(workDir);
    expect(picked.path).toBe(agentsPath);

    // Now flip: CLAUDE.md becomes newer.
    utimesSync(claudePath, new Date(1900000000000), new Date(1900000000000));
    const reflip = pickProjectDocFile(workDir);
    expect(reflip.path).toBe(claudePath);
  });

  it('CLAUDE.md wins on identical mtime (deterministic tie-break)', () => {
    const claudePath = join(workDir, 'CLAUDE.md');
    const agentsPath = join(workDir, 'AGENTS.md');
    writeFileSync(claudePath, '# Claude');
    writeFileSync(agentsPath, '# Agents');
    const t = new Date(1750000000000);
    utimesSync(claudePath, t, t);
    utimesSync(agentsPath, t, t);
    const picked = pickProjectDocFile(workDir);
    expect(picked.path).toBe(claudePath);
  });

  it('exposes both filenames in PROJECT_DOC_FILENAMES with CLAUDE.md first', () => {
    expect(PROJECT_DOC_FILENAMES).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });
});

describe('readProjectDoc', () => {
  let workDir;
  let warnSpy;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'yeaft-pdoc-read-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('returns null when pick returns null', () => {
    expect(readProjectDoc(workDir)).toBeNull();
  });

  it('returns null for maxBytes === 0 (feature disabled)', () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), '# Hi');
    expect(readProjectDoc(workDir, { maxBytes: 0 })).toBeNull();
  });

  it('reads file contents and reports path + mtimeMs', () => {
    const claudePath = join(workDir, 'CLAUDE.md');
    writeFileSync(claudePath, '# Project Rules\n\nUse pnpm.');
    const doc = readProjectDoc(workDir);
    expect(doc).not.toBeNull();
    expect(doc.path).toBe(claudePath);
    expect(typeof doc.mtimeMs).toBe('number');
    expect(doc.text).toBe('# Project Rules\n\nUse pnpm.');
  });

  it('returns null when file is empty / whitespace-only after trim', () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), '   \n\n  \n');
    expect(readProjectDoc(workDir)).toBeNull();
    writeFileSync(join(workDir, 'CLAUDE.md'), '');
    expect(readProjectDoc(workDir)).toBeNull();
  });

  it('truncates to maxBytes and emits console.warn', () => {
    const big = 'x'.repeat(100);
    writeFileSync(join(workDir, 'CLAUDE.md'), big);
    const doc = readProjectDoc(workDir, { maxBytes: 10 });
    expect(doc).not.toBeNull();
    expect(doc.text.length).toBe(10);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/exceeds 10 bytes — truncated/);
  });

  it('codepoint-safe truncation: never emits U+FFFD for Chinese content', () => {
    // Each Chinese character is 3 UTF-8 bytes. Writing 20 characters
    // produces a 60-byte payload; capping at any byte count that lands
    // mid-codepoint (e.g. 11, 13, 14, 16, 17, 19) must NOT leave a
    // dangling replacement character in the decoded text.
    const body = '中文测试内容很长一段话需要被裁剪掉了'; // 18 chars × 3 bytes = 54 bytes
    writeFileSync(join(workDir, 'CLAUDE.md'), body);
    for (const cap of [7, 8, 10, 11, 13, 14, 17, 20, 25]) {
      warnSpy.mockClear();
      const doc = readProjectDoc(workDir, { maxBytes: cap });
      if (doc) {
        expect(doc.text).not.toMatch(/�/);
      }
    }
  });

  it('does not warn when file is smaller than maxBytes', () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), 'tiny');
    readProjectDoc(workDir, { maxBytes: 1024 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('defaults to DEFAULT_PROJECT_DOC_MAX_BYTES when maxBytes is undefined', () => {
    expect(DEFAULT_PROJECT_DOC_MAX_BYTES).toBe(32 * 1024);
    writeFileSync(join(workDir, 'CLAUDE.md'), 'hi');
    const doc = readProjectDoc(workDir);
    expect(doc.text).toBe('hi');
  });

  it('ignores non-finite maxBytes and falls back to default', () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), 'hi');
    const doc = readProjectDoc(workDir, { maxBytes: NaN });
    expect(doc.text).toBe('hi');
  });
});
