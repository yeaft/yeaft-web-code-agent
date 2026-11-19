import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  symlinkSync,
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

});
