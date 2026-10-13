import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as fsp from 'fs/promises';
const { mkdir: actualMkdir } = await vi.importActual('fs/promises');

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});
import { tmpdir } from 'node:os';
import applyPatch from '../../../../agent/yeaft/tools/apply-patch.js';

function parseResult(output) {
  return JSON.parse(output);
}

describe('ApplyPatch', () => {
  let cwd;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'yeaft-apply-patch-'));
  });

  afterEach(() => {
    vi.resetAllMocks();
    fsp.mkdir.mockImplementation(actualMkdir);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('applies ordered hunks only after matching all context and deleted lines', async () => {
    const target = join(cwd, 'source.txt');
    writeFileSync(target, 'alpha\nbeta\ngamma\ndelta\nepsilon\n');

    const result = parseResult(await applyPatch.execute({
      patch: [
        '--- a/source.txt',
        '+++ b/source.txt',
        '@@ -1,3 +1,3 @@',
        ' alpha',
        '-beta',
        '+BETA',
        ' gamma',
        '@@ -4,2 +4,3 @@',
        ' delta',
        '+inserted',
        ' epsilon',
        '',
      ].join('\n'),
    }, { cwd }));

    expect(result).toMatchObject({ success: true, summary: 'Applied 2 hunk(s) to 1 file(s)' });
    expect(readFileSync(target, 'utf8')).toBe('alpha\nBETA\ngamma\ndelta\ninserted\nepsilon\n');
  });

  it('prevalidates every file before writing any file', async () => {
    const first = join(cwd, 'first.txt');
    const second = join(cwd, 'second.txt');
    writeFileSync(first, 'one\n');
    writeFileSync(second, 'actual\n');

    const result = parseResult(await applyPatch.execute({
      patch: [
        '--- a/first.txt',
        '+++ b/first.txt',
        '@@ -1 +1 @@',
        '-one',
        '+ONE',
        '--- a/second.txt',
        '+++ b/second.txt',
        '@@ -1 +1 @@',
        '-stale',
        '+SECOND',
        '',
      ].join('\n'),
    }, { cwd }));

    expect(result.errorEffect).toBe('none');
    expect(result.error).toMatch(/second\.txt/);
    expect(readFileSync(first, 'utf8')).toBe('one\n');
    expect(readFileSync(second, 'utf8')).toBe('actual\n');
  });

  it.each([
    {
      name: 'a missing +++ header',
      patch: '--- a/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /followed by a \+\+\+ file header/,
    },
    {
      name: 'path traversal',
      patch: '--- a/file.txt\n+++ b/../escape.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /escapes the working directory/,
    },
    {
      name: 'a malformed hunk count',
      patch: '--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1 @@\n-old\n+new\n',
      error: /hunk ended before its declared ranges/i,
    },
  ])('rejects $name before filesystem changes', async ({ patch, error }) => {
    const target = join(cwd, 'file.txt');
    writeFileSync(target, 'old\n');

    const result = parseResult(await applyPatch.execute({ patch }, { cwd }));

    expect(result.errorEffect).toBe('none');
    expect(result.error).toMatch(error);
    expect(readFileSync(target, 'utf8')).toBe('old\n');
    expect(existsSync(join(cwd, '../escape.txt'))).toBe(false);
  });

  it('reports the non-transactional boundary when a write fails after validation', async () => {
    writeFileSync(join(cwd, 'first.txt'), 'one\n');
    const mkdir = actualMkdir;
    fsp.mkdir.mockImplementation(async (dir, options) => {
      if (dir === join(cwd, 'blocked')) throw new Error('simulated I/O failure');
      return mkdir(dir, options);
    });

    const result = parseResult(await applyPatch.execute({
      patch: [
        '--- a/first.txt',
        '+++ b/first.txt',
        '@@ -1 +1 @@',
        '-one',
        '+ONE',
        '--- /dev/null',
        '+++ b/blocked/new.txt',
        '@@ -0,0 +1 @@',
        '+new',
        '',
      ].join('\n'),
    }, { cwd }));

    expect(result).toMatchObject({
      errorEffect: 'unknown',
      failedFile: 'blocked/new.txt',
      results: [{ file: 'first.txt', success: true, hunks: 1 }],
    });
    expect(result.warning).toMatch(/not transactional/);
    expect(readFileSync(join(cwd, 'first.txt'), 'utf8')).toBe('ONE\n');
  });

  it.skipIf(process.platform === 'win32')('rejects target and ancestor symlinks without changing any source', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'yeaft-patch-outside-'));
    try {
      writeFileSync(join(outside, 'victim'), 'old\n');
      symlinkSync(outside, join(cwd, 'link'));
      symlinkSync(join(outside, 'victim'), join(cwd, 'file-link'));
      for (const file of ['link/victim', 'file-link']) {
        const result = parseResult(await applyPatch.execute({
          patch: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`,
        }, { cwd }));
        expect(result.errorEffect).toBe('none');
        expect(result.error).toMatch(/Symbolic link/);
        expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('old\n');
      }
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('rechecks symlink replacement between validation and writing', async () => {
    writeFileSync(join(cwd, 'victim'), 'old\n');
    writeFileSync(join(cwd, 'untouched'), 'external\n');
    const mkdir = actualMkdir;
    fsp.mkdir.mockImplementationOnce(async (...args) => {
      unlinkSync(join(cwd, 'victim'));
      symlinkSync(join(cwd, 'untouched'), join(cwd, 'victim'));
      return mkdir(...args);
    });
    const result = parseResult(await applyPatch.execute({
      patch: '--- a/victim\n+++ b/victim\n@@ -1 +1 @@\n-old\n+new\n',
    }, { cwd }));
    expect(result.error).toMatch(/Symbolic link/);
    expect(readFileSync(join(cwd, 'untouched'), 'utf8')).toBe('external\n');
  });

  it('does not overwrite a file externally changed after prevalidation', async () => {
    writeFileSync(join(cwd, 'victim'), 'old\n');
    fsp.mkdir.mockImplementationOnce(async (...args) => {
      writeFileSync(join(cwd, 'victim'), 'external\n');
      return actualMkdir(...args);
    });
    const result = parseResult(await applyPatch.execute({
      patch: '--- a/victim\n+++ b/victim\n@@ -1 +1 @@\n-old\n+new\n',
    }, { cwd }));
    expect(result.error).toMatch(/content changed after validation/);
    expect(readFileSync(join(cwd, 'victim'), 'utf8')).toBe('external\n');
  });
});
