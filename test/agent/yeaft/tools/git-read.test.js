import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gitRead, { formatGitReadResult, MAX_RESULT_BYTES } from '../../../../agent/yeaft/tools/git-read.js';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('GitRead provider argument compatibility', () => {
  it('reads real repository evidence without mutating files and preserves bounded structured failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yeaft-git-read-')); directories.push(cwd);
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(join(cwd, 'file.txt'), 'before\n'); git('add', '.'); git('commit', '-qm', 'initial');
    writeFileSync(join(cwd, 'file.txt'), 'after\n');
    expect(await gitRead.execute({ operation: 'status', limit: 10 }, { cwd })).toContain(' M file.txt');
    expect(await gitRead.execute({ operation: 'diff', limit: 50 }, { cwd })).toContain('+after');
    expect(await gitRead.execute({ operation: 'show', limit: 1 }, { cwd })).toContain('initial');
    expect(await gitRead.execute({ operation: 'log', limit: 1 }, { cwd })).toContain('initial');
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('after\n');
    for (const revision of ['missing-ref', 'HEAD^{tree}', 'HEAD..HEAD']) {
      expect(JSON.parse(await gitRead.execute({ operation: 'show', revision }, { cwd }))).toMatchObject({ error: expect.any(String), errorEffect: 'none' });
    }
    for (const result of [
      { code: 128, stderr: 'bad revision' }, { code: null, timedOut: true },
      { code: 0, truncated: true }, { code: null, terminationError: 'exit unconfirmed' },
    ]) {
      const output = formatGitReadResult('diff', { stdout: '\u0000你'.repeat(20000), stderr: '', ...result }, { resolvedCwd: cwd });
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      expect(JSON.parse(output)).toMatchObject({ error: expect.any(String), errorEffect: 'none' });
    }
  });
});
