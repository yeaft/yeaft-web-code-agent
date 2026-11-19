import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFileReferences } from '../../agent/workbench/file-reference-resolver.js';

describe('resolveFileReferences', () => {
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

});
