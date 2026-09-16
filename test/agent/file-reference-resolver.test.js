import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFileReferences } from '../../agent/workbench/file-reference-resolver.js';

describe('resolveFileReferences', () => {
  it('resolves Session/worktree paths, absolute paths, unique basenames, and Unicode or spaced names', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'yeaft-reference-worktrees-'));
    const workDir = join(parent, '.yeaft', 'worktrees', '响应 links');
    try {
      await mkdir(join(workDir, 'src', '中文 目录'), { recursive: true });
      await writeFile(join(workDir, 'README.md'), 'readme');
      await writeFile(join(workDir, 'src', '中文 目录', '结果 file.js'), 'result');

      await expect(resolveFileReferences([
        './README.md',
        join(workDir, 'src', '中文 目录', '结果 file.js'),
        '结果 file.js',
      ], workDir)).resolves.toEqual([
        { requestedPath: './README.md', resolvedPath: 'README.md' },
        {
          requestedPath: join(workDir, 'src', '中文 目录', '结果 file.js'),
          resolvedPath: 'src/中文 目录/结果 file.js',
        },
        { requestedPath: '结果 file.js', resolvedPath: 'src/中文 目录/结果 file.js' },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects external absolute paths and URI-shaped references instead of basename-repairing them', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-reference-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'yeaft-reference-outside-'));
    try {
      await writeFile(join(workDir, 'README.md'), 'inside');
      await writeFile(join(outside, 'README.md'), 'outside');

      await expect(resolveFileReferences([
        join(outside, 'README.md'),
        'https://example.test/README.md',
        'data:text/plain,README.md',
        'README.md',
      ], workDir)).resolves.toEqual([
        { requestedPath: 'README.md', resolvedPath: 'README.md' },
      ]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous basename fallback matches', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-reference-ambiguous-'));
    try {
      await mkdir(join(workDir, 'a'), { recursive: true });
      await mkdir(join(workDir, 'b'), { recursive: true });
      await writeFile(join(workDir, 'a', 'target.js'), 'first');
      await writeFile(join(workDir, 'b', 'target.js'), 'second');

      await expect(resolveFileReferences(['wrong/target.js'], workDir)).resolves.toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('bounds reference count and ignores path values too large for a filesystem reference', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-reference-bounds-'));
    try {
      await writeFile(join(workDir, 'kept.js'), 'kept');
      const references = ['x'.repeat(4097), 'kept.js', ...Array.from({ length: 40 }, (_, i) => `missing-${i}.js`)];
      await expect(resolveFileReferences(references, workDir)).resolves.toEqual([
        { requestedPath: 'kept.js', resolvedPath: 'kept.js' },
      ]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
