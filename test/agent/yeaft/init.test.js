import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initYeaftDir } from '../../../agent/yeaft/init.js';

describe('initYeaftDir', () => {
  it('does not create obsolete flat group paths during fresh init', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'yeaft-init-test-'));

    try {
      const result = initYeaftDir(testDir);

      expect(result.dir).toBe(testDir);
      expect(existsSync(join(testDir, 'chat', 'index.md'))).toBe(true);
      expect(existsSync(join(testDir, 'group'))).toBe(false);
      expect(existsSync(join(testDir, 'group', 'index.md'))).toBe(false);
      expect(result.created).not.toContain(join(testDir, 'group'));
      expect(result.created).not.toContain(join(testDir, 'group', 'index.md'));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
