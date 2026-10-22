import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gitRead, { buildGitReadArgs, formatGitReadResult, MAX_RESULT_BYTES } from '../../../../agent/yeaft/tools/git-read.js';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('GitRead provider argument compatibility', () => {
  it('ignores every schema-valid non-log limit and empty strict-provider placeholders', () => {
    for (const operation of ['status', 'diff', 'show']) {
      const expected = buildGitReadArgs({ operation });
      for (let limit = 1; limit <= 50; limit++) {
        expect(buildGitReadArgs({ operation, cwd: '', base: '', head: '', revision: '', paths: [], limit })).toEqual(expected);
      }
      expect(buildGitReadArgs({ operation, cwd: null, base: null, head: null, revision: null, paths: null, limit: null })).toEqual(expected);
    }
    for (const limit of [1, 17, 50]) expect(buildGitReadArgs({ operation: 'log', limit }).args).toContain(`--max-count=${limit}`);
  });

  it('continues to reject substantive cross-operation fields, invalid limits and unsafe revisions', async () => {
    for (const operation of ['status', 'diff', 'show', 'log']) {
      for (const limit of [0, 51, -1, 1.5, '20', {}, []]) expect(buildGitReadArgs({ operation, limit }).error).toBeTruthy();
      expect(buildGitReadArgs({ operation, extra: true }).error).toMatch(/Unexpected parameter/);
    }
    for (const input of [
      { operation: 'status', paths: ['file'] }, { operation: 'status', base: 'HEAD' },
      { operation: 'diff', revision: 'HEAD' }, { operation: 'diff', head: 'HEAD' },
      { operation: 'show', base: 'HEAD' }, { operation: 'log', paths: ['file'] },
      { operation: 'show', revision: '--output=stolen' }, { operation: 'diff', paths: ['-unsafe'] },
      { operation: 'log', revision: 'HEAD\n--all' },
    ]) {
      const output = JSON.parse(await gitRead.execute(input, {}));
      expect(output).toMatchObject({ code: 'invalid_arguments', errorEffect: 'none' });
    }
  });

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
