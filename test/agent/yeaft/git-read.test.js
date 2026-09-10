import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPersonas } from '../../../agent/yeaft/personas.js';
import { buildChildToolRegistry } from '../../../agent/yeaft/sub-agent/runner.js';
import gitRead, {
  buildGitReadArgs,
  createGitReadTool,
  formatGitReadResult,
  MAX_RESULT_BYTES,
} from '../../../agent/yeaft/tools/git-read.js';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';

const tempRoots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-git-read-'));
  tempRoots.push(root);
  git(root, 'init');
  git(root, 'config', 'user.name', 'GitRead Test');
  git(root, 'config', 'user.email', 'git-read@example.test');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'base commit');
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitRead argument construction', () => {
  it('maps each supported operation to fixed read-only argv', () => {
    expect(buildGitReadArgs({ operation: 'status' }).args).toEqual([
      '--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects',
      '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
      '-c', 'submodule.recurse=false', '-c', 'diff.submodule=short', '-c', 'protocol.allow=never',
      'status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all',
    ]);
    expect(buildGitReadArgs({
      operation: 'diff',
      base: 'origin/main',
      head: 'feature',
      paths: ['src/a.js'],
    }).args).toEqual(expect.arrayContaining([
      'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty',
      'origin/main...feature', '--', 'src/a.js',
    ]));
    expect(buildGitReadArgs({ operation: 'show', revision: 'HEAD~1' }).args).toEqual(expect.arrayContaining([
      'show', '--no-ext-diff', '--no-textconv', '--no-color', '--format=fuller', 'HEAD~1', '--',
    ]));
    expect(buildGitReadArgs({ operation: 'log', revision: 'main', limit: 3 }).args).toEqual(expect.arrayContaining([
      'log', '--no-color', '--max-count=3', '--date=iso-strict',
      '--format=%H%x09%ad%x09%an%x09%s', 'main', '--',
    ]));
  });

  it.each([
    [{ operation: 'diff', base: '--output=/tmp/pwned' }, 'base must not start with'],
    [{ operation: 'diff', paths: ['--ext-diff'] }, 'paths[0] must not start with'],
    [{ operation: 'diff', paths: [':(attr:filter=lfs)secret'] }, 'paths[0] must not use pathspec attributes'],
    [{ operation: 'show', revision: '-p' }, 'revision must not start with'],
    [{ operation: 'log', revision: 'HEAD\n--all' }, 'revision must not contain'],
    [{ operation: 'diff', head: 'feature' }, 'head requires base'],
    [{ operation: 'log', limit: 51 }, 'limit must be an integer'],
    [{ operation: 'status', revision: 'HEAD' }, 'Unexpected parameter'],
    [{ operation: 'fetch' }, 'operation must be one of'],
  ])('rejects option injection and inputs outside the operation contract', (input, expected) => {
    expect(buildGitReadArgs(input)).toEqual({ error: expect.stringContaining(expected) });
  });
});

describe('GitRead execution', () => {
  it('executes git directly with a deterministic cwd and hardened environment', async () => {
    const runProcessImpl = vi.fn().mockResolvedValueOnce({
      code: 1, stdout: '', stderr: '', truncated: false, timedOut: false,
    }).mockResolvedValue({
      code: 0,
      stdout: '## main\n',
      stderr: '',
      truncated: false,
      timedOut: false,
    });
    const tool = createGitReadTool({ runProcessImpl });
    const cwd = join(process.cwd(), '.');

    const output = await tool.execute({ operation: 'status' }, { cwd });

    expect(output).toContain('truncated: false');
    expect(runProcessImpl).toHaveBeenCalledTimes(2);
    expect(runProcessImpl.mock.calls[0][1]).toEqual(expect.arrayContaining(['config', '--name-only']));
    const [command, args, options] = runProcessImpl.mock.calls[1];
    expect(command).toBe('git');
    expect(args).not.toContain('fetch');
    expect(options.cwd).toBe(resolve(cwd));
    expect(options).not.toHaveProperty('shell');
    expect(options.env).toMatchObject({
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_EXTERNAL_DIFF: '',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
    });
  });

  it('keeps output bounded and explicitly marks runner or formatter truncation', () => {
    const formatted = formatGitReadResult('diff', {
      code: 0,
      stdout: '改'.repeat(MAX_RESULT_BYTES),
      stderr: '',
      truncated: false,
      timedOut: false,
    });
    expect(Buffer.byteLength(formatted, 'utf8')).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(formatted).toContain('truncated: true');
    expect(formatted).toContain('[Output truncated by GitRead;');
    expect(formatted).not.toContain('\uFFFD');

    const runnerLimited = formatGitReadResult('show', {
      code: 143,
      stdout: 'partial',
      stderr: '',
      truncated: true,
      timedOut: false,
    });
    expect(runnerLimited).toContain('exitCode: not observed (output limit reached)');
    expect(runnerLimited).toContain('truncated: true');
  });

  it('reads status, diff, show, and log from a local repository', async () => {
    const root = createRepository();
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    writeFileSync(join(root, 'untracked.txt'), 'new\n');

    const status = await gitRead.execute({ operation: 'status' }, { cwd: root });
    expect(status).toContain(' M tracked.txt');
    expect(status).toContain('?? untracked.txt');

    const diff = await gitRead.execute({ operation: 'diff', paths: ['tracked.txt'] }, { cwd: root });
    expect(diff).toContain('+changed');
    expect(diff).not.toContain('untracked.txt');

    const show = await gitRead.execute({ operation: 'show', paths: ['tracked.txt'] }, { cwd: root });
    expect(show).toContain('base commit');
    expect(show).toContain('+base');

    const log = await gitRead.execute({ operation: 'log', limit: 1 }, { cwd: root });
    expect(log).toContain('base commit');
    expect(log).toContain('truncated: false');
  });

  it.each(['clean', 'process'])('does not invoke a configured %s filter during working-tree reads', async filter => {
    const root = createRepository();
    const marker = join(root, 'filter-invoked');
    const driver = join(root, 'filter.cjs');
    writeFileSync(driver, `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.stdout.write(fs.readFileSync(0));`);
    git(root, 'config', `filter.unsafe.${filter}`, `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`);
    git(root, 'config', 'filter.unsafe.required', 'true');
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=unsafe\n');
    writeFileSync(join(root, 'tracked.txt'), 'changed content\n');

    const status = await gitRead.execute({ operation: 'status' }, { cwd: root });
    const diff = await gitRead.execute({ operation: 'diff' }, { cwd: root });

    expect(status).toContain(' M tracked.txt');
    expect(diff).toContain('+changed content');
    expect(existsSync(marker)).toBe(false);
    expect(git(root, 'config', '--get', 'filter.unsafe.required')).toBe('true');
  });

  it('does not enter submodules with independently configured content filters', async () => {
    const root = createRepository();
    const source = createRepository();
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'nested');
    git(root, 'commit', '-m', 'add submodule');
    const nested = join(root, 'nested');
    const marker = join(root, 'submodule-filter-invoked');
    const driver = join(root, 'nested-filter.cjs');
    writeFileSync(driver, `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.stdout.write(fs.readFileSync(0));`);
    git(nested, 'config', 'filter.nested.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`);
    writeFileSync(join(nested, '.gitattributes'), 'tracked.txt filter=nested\n');
    writeFileSync(join(nested, 'tracked.txt'), 'nested change\n');

    const output = await gitRead.execute({ operation: 'diff' }, { cwd: root });
    expect(output).toContain('exitCode: 0');
    expect(existsSync(marker)).toBe(false);
    expect(output).not.toContain('-dirty');

    // Ignoring dirty files must not hide an actual gitlink change in the diff.
    git(source, 'commit', '--allow-empty', '-m', 'new submodule commit');
    const next = git(source, 'rev-parse', 'HEAD');
    git(root, 'update-index', '--cacheinfo', `160000,${next},nested`);
    git(root, 'commit', '-m', 'update submodule pointer');
    const pointerDiff = await gitRead.execute({ operation: 'diff', base: 'HEAD~1', head: 'HEAD' }, { cwd: root });
    expect(pointerDiff).toContain('exitCode: 0');
    expect(pointerDiff).toContain(`+Subproject commit ${next}`);
    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed when filter inspection is incomplete', async () => {
    const runProcessImpl = vi.fn().mockResolvedValue({ code: 0, stdout: 'filter.unsafe.clean\0', truncated: true });
    const output = await createGitReadTool({ runProcessImpl }).execute({ operation: 'diff' }, { cwd: process.cwd() });
    expect(output).toContain('Cannot safely inspect Git content filters');
    expect(runProcessImpl).toHaveBeenCalledOnce();
  });

  it('does not invoke configured external diff or textconv commands', async () => {
    const root = createRepository();
    const marker = join(root, 'driver-invoked');
    const driver = join(root, 'driver.js');
    writeFileSync(driver, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'invoked');\n`);
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt diff=unsafe\n');
    git(root, 'add', '.gitattributes');
    git(root, 'commit', '-m', 'configure attributes');
    git(root, 'config', 'diff.unsafe.command', `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`);
    git(root, 'config', 'diff.unsafe.textconv', `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`);
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');

    const output = await gitRead.execute({ operation: 'diff' }, { cwd: root });

    expect(output).toContain('+changed');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('GitRead registration and reviewer access', () => {
  it('registers the read-only tool and grants it to the reviewer without Bash', () => {
    const registry = createFullRegistry();
    expect(registry.get('GitRead')).toBe(gitRead);
    expect(gitRead.isReadOnly()).toBe(true);
    expect(gitRead.isConcurrencySafe()).toBe(true);

    const reviewer = loadPersonas({ fresh: true }).get('reviewer');
    expect(reviewer.tools).toContain('GitRead');
    expect(reviewer.systemPrompt).toContain('Diff first');
    expect(reviewer.systemPrompt).toContain('先读 diff');

    const child = buildChildToolRegistry(registry, {
      agent: { persona: 'reviewer', personaData: reviewer },
    });
    expect(child.get('GitRead')).toBe(gitRead);
    expect(child.get('Bash')).toBeNull();
  });
});
