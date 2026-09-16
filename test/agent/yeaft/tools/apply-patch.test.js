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
import applyPatch, { parsePatch } from '../../../../agent/yeaft/tools/apply-patch.js';

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

  it('rejects stale context without changing the file', async () => {
    const target = join(cwd, 'source.txt');
    const original = 'alpha\ncurrent\ngamma\n';
    writeFileSync(target, original);

    const result = parseResult(await applyPatch.execute({
      patch: '--- a/source.txt\n+++ b/source.txt\n@@ -1,3 +1,3 @@\n alpha\n-stale\n+updated\n gamma\n',
    }, { cwd }));

    expect(result.errorEffect).toBe('none');
    expect(result.error).toMatch(/context mismatch.*line 2/i);
    expect(readFileSync(target, 'utf8')).toBe(original);
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

  it('supports standard new-file additions and no-newline transitions', async () => {
    writeFileSync(join(cwd, 'existing.txt'), 'before');
    const result = parseResult(await applyPatch.execute({
      patch: [
        '--- a/existing.txt',
        '+++ b/existing.txt',
        '@@ -1 +1 @@',
        '-before',
        '\\ No newline at end of file',
        '+after',
        '--- /dev/null',
        '+++ b/nested/new.txt',
        '@@ -0,0 +1,2 @@',
        '+first',
        '+second',
        '',
      ].join('\n'),
    }, { cwd }));

    expect(result.success).toBe(true);
    expect(readFileSync(join(cwd, 'existing.txt'), 'utf8')).toBe('after\n');
    expect(readFileSync(join(cwd, 'nested/new.txt'), 'utf8')).toBe('first\nsecond\n');
  });

  it('accepts git diff metadata tied to its file headers', async () => {
    writeFileSync(join(cwd, 'tracked.txt'), 'old\n');

    const result = parseResult(await applyPatch.execute({
      patch: [
        'diff --git a/tracked.txt b/tracked.txt',
        'index 1111111..2222222 100644',
        '--- a/tracked.txt',
        '+++ b/tracked.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/created.txt b/created.txt',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/created.txt',
        '@@ -0,0 +1 @@',
        '+created',
        '',
      ].join('\n'),
    }, { cwd }));

    expect(result.success).toBe(true);
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(cwd, 'created.txt'), 'utf8')).toBe('created\n');
  });

  it('preserves CRLF line endings while applying additions and deletions', async () => {
    const target = join(cwd, 'windows.txt');
    writeFileSync(target, 'one\r\ntwo\r\nthree\r\n');

    const result = parseResult(await applyPatch.execute({
      patch: '--- a/windows.txt\n+++ b/windows.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n',
    }, { cwd }));

    expect(result.success).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('one\r\nsecond\r\nthree\r\n');
  });

  it.each([
    {
      name: 'a missing +++ header',
      patch: '--- a/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /followed by a \+\+\+ file header/,
    },
    {
      name: 'an unsupported rename',
      patch: '--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /rename patches are not supported/,
    },
    {
      name: 'an unsupported deletion',
      patch: '--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
      error: /deletion patches are not supported/,
    },
    {
      name: 'path traversal',
      patch: '--- a/file.txt\n+++ b/../escape.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /escapes the working directory/,
    },
    {
      name: 'an unsupported mode header',
      patch: 'old mode 100644\nnew mode 100755\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /unsupported or unexpected patch header/i,
    },
    {
      name: 'detached git metadata',
      patch: 'index 1111111..2222222 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /unsupported or unexpected patch header/i,
    },
    {
      name: 'git metadata that disagrees with file headers',
      patch: 'diff --git a/file.txt b/file.txt\n--- a/other.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
      error: /target does not match diff --git header/i,
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

  it('rejects unsupported creation modes and non-EOF newline markers before writing', async () => {
    writeFileSync(join(cwd, 'file.txt'), 'old\nlast\n');
    const misplaced = parseResult(await applyPatch.execute({
      patch: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n',
    }, { cwd }));
    expect(misplaced.error).toMatch(/final output line/);
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('old\nlast\n');
    for (const mode of ['100755', '120000', '160000']) {
      const result = parseResult(await applyPatch.execute({
        patch: `diff --git a/new.txt b/new.txt\nnew file mode ${mode}\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n`,
      }, { cwd }));
      expect(result.errorEffect).toBe('none');
      expect(result.error).toMatch(/mode changes are not applied/);
      expect(existsSync(join(cwd, 'new.txt'))).toBe(false);
    }
    expect(() => parsePatch('--- a/file.txt\n+++ b/file.txt\n@@ -999999999999999999999 +1 @@\n-old\n+new\n'))
      .toThrow(/safe integers/);
  });

  it('applies a small hunk without spreading a large unchanged file into function arguments', async () => {
    const source = 'line\n'.repeat(150000);
    writeFileSync(join(cwd, 'large.txt'), source);
    const result = parseResult(await applyPatch.execute({
      patch: '--- a/large.txt\n+++ b/large.txt\n@@ -150000 +150000 @@\n-line\n+last\n',
    }, { cwd }));
    expect(result.success).toBe(true);
    expect(readFileSync(join(cwd, 'large.txt'), 'utf8')).toBe('line\n'.repeat(149999) + 'last\n');
  });

  it('preserves mixed line terminators outside and inside hunk context', async () => {
    writeFileSync(join(cwd, 'mixed.txt'), 'one\r\ntwo\nthree\r\n');
    const result = parseResult(await applyPatch.execute({
      patch: '--- a/mixed.txt\n+++ b/mixed.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
    }, { cwd }));
    expect(result.success).toBe(true);
    expect(readFileSync(join(cwd, 'mixed.txt'), 'utf8')).toBe('one\r\nTWO\nthree\r\n');
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

  it('keeps newline removal, blank files and pure insertion semantics exact', async () => {
    for (const [before, patch, after] of [
      ['old\n', '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n', 'new'],
      ['\n', '@@ -1 +1 @@\n-\n+filled\n', 'filled\n'],
      ['one\r\n', '@@ -1,0 +2 @@\n+two\n', 'one\r\ntwo\r\n'],
      ['one\n', '@@ -0,0 +1 @@\n+zero\n', 'zero\none\n'],
    ]) {
      writeFileSync(join(cwd, 'eol.txt'), before);
      const result = parseResult(await applyPatch.execute({ patch: '--- a/eol.txt\n+++ b/eol.txt\n' + patch }, { cwd }));
      expect(result.success).toBe(true);
      expect(readFileSync(join(cwd, 'eol.txt'), 'utf8')).toBe(after);
    }
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

  it('reports no filesystem effect for full-patch parse failures', () => {
    expect(() => parsePatch(
      '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\ntrailing garbage\n',
    )).toThrow(/unsupported or unexpected patch content/i);
  });
});
