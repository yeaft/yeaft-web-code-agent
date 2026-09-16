import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRepoWorkflowArgs, repoWorkflowHelp, runRepoWorkflowCli } from '../../agent/repo-workflow-cli.js';
import {
  createRepoCommandRunner,
  formatRepoWorkflowError,
  parseGithubRemoteUrl,
  prepareRepoReview,
  prepareRepoWorkflow,
  summarizeChecks,
} from '../../agent/repo-workflow.js';

const tempRoots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createPullRequestRepository() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-repo-workflow-'));
  tempRoots.push(root);
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');

  git(root, 'init', '--bare', remote);
  git(root, 'init', seed);
  git(seed, 'checkout', '-b', 'main');
  git(seed, 'config', 'user.name', 'Test User');
  git(seed, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(seed, 'file.txt'), 'base\n');
  git(seed, 'add', 'file.txt');
  git(seed, 'commit', '-m', 'base');
  const baseSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  git(seed, 'switch', '-c', 'feature');
  writeFileSync(join(seed, 'file.txt'), 'base\nfeature\n');
  git(seed, 'commit', '-am', 'feature');
  const headSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', 'origin', 'feature');
  git(seed, 'push', 'origin', 'HEAD:refs/pull/1/head');

  git(seed, 'switch', 'main');
  git(seed, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  const snapshotSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', 'origin', 'HEAD:refs/pull/1/merge');

  git(root, 'clone', remote, checkout);
  git(checkout, 'config', 'user.name', 'Test User');
  git(checkout, 'config', 'user.email', 'test@example.test');
  return { root, remote, checkout, baseSha, headSha, snapshotSha };
}

function openPullRequest(repo, overrides = {}) {
  return {
    number: 1,
    url: 'https://github.test/acme/repo/pull/1',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feature',
    headRefOid: repo.headSha,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [],
    reviewDecision: '',
    mergedAt: null,
    mergeCommit: null,
    ...overrides,
  };
}

function createGithubRunner(repo, options = {}) {
  const baseRun = createRepoCommandRunner();
  const calls = [];
  const remoteUrl = options.githubRemoteUrl || 'git@github.example.test:acme/repo.git';
  const pullRequest = openPullRequest(repo, options.pullRequest);
  const run = async (command, args, commandOptions = {}) => {
    calls.push({ command, args: [...args] });
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: remoteUrl, stderr: '', exitCode: 0 };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return { stdout: JSON.stringify(pullRequest), stderr: '', exitCode: 0 };
    }
    return baseRun(command, args, commandOptions);
  };
  return { run, calls };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository preparation helpers', () => {
  it('parses credential-free GitHub selectors from supported remote URLs', () => {
    expect(parseGithubRemoteUrl('git@github.com:acme/repo.git')).toEqual({
      host: 'github.com',
      nameWithOwner: 'acme/repo',
      selector: 'acme/repo',
    });
    expect(parseGithubRemoteUrl('https://token-value@github.example.test/acme/repo.git')).toEqual({
      host: 'github.example.test',
      nameWithOwner: 'acme/repo',
      selector: 'github.example.test/acme/repo',
    });
    expect(parseGithubRemoteUrl('ssh://git@github.example.test/acme/repo.git')).toEqual({
      host: 'github.example.test',
      nameWithOwner: 'acme/repo',
      selector: 'github.example.test/acme/repo',
    });
    expect(() => parseGithubRemoteUrl('/tmp/local.git')).toThrowError(expect.objectContaining({
      code: 'GITHUB_REMOTE_UNSUPPORTED',
    }));
  });

  it('redacts credentials from command failures and serialized errors', async () => {
    const runner = createRepoCommandRunner({
      execFileImpl: async () => {
        const error = new Error('fetch https://user:secret-token@github.example.test/acme/repo failed');
        error.code = 128;
        error.stderr = 'https://github.example.test/acme/repo?access_token=query-secret&x=1';
        throw error;
      },
    });
    let caught;
    try {
      await runner('git', ['fetch', 'https://user:argument-secret@github.example.test/acme/repo']);
    } catch (error) {
      caught = error;
    }

    const serialized = JSON.stringify(formatRepoWorkflowError(caught));
    expect(serialized).not.toMatch(/secret-token|query-secret|argument-secret/);
    expect(serialized).toContain('***');
  });

  it('classifies failed, successful, and in-progress checks', () => {
    expect(summarizeChecks([
      { name: 'test', conclusion: 'SUCCESS' },
      { name: 'lint', conclusion: 'FAILURE' },
      { name: 'build', status: 'IN_PROGRESS' },
    ])).toEqual({
      total: 3,
      passed: [{ name: 'test', state: 'SUCCESS' }],
      failed: [{ name: 'lint', state: 'FAILURE' }],
      pending: [{ name: 'build', state: 'IN_PROGRESS' }],
    });
  });
});

describe('prepareRepoWorkflow', () => {
  it('creates and safely reuses a worktree pinned to the latest remote base', async () => {
    const repo = createPullRequestRepository();
    const first = await prepareRepoWorkflow({ cwd: repo.checkout, name: 'feature-task' });
    expect(first).toMatchObject({
      ok: true,
      phase: 'prepare',
      reused: false,
      base: { branch: 'main', sha: repo.baseSha },
      worktree: { branch: 'yeaft-wt/feature-task', head: repo.baseSha },
    });
    expect(git(first.worktree.path, 'rev-parse', 'HEAD')).toBe(repo.baseSha);

    const second = await prepareRepoWorkflow({ cwd: repo.checkout, name: 'feature-task' });
    expect(second.reused).toBe(true);
    expect(second.worktree).toEqual(first.worktree);
  });

  it('does not expose credential-bearing remote URLs', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, {
      githubRemoteUrl: 'https://secret-token@github.example.test/acme/repo.git',
    });
    const result = await prepareRepoWorkflow({ cwd: repo.checkout, name: 'safe-output' }, { run: github.run });

    expect(result.repository).toEqual({
      root: repo.checkout,
      workspaceRoot: repo.checkout,
      remote: 'origin',
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('remoteUrl');
  });

  it('rejects option-like remote names before passing them to Git', async () => {
    const repo = createPullRequestRepository();
    await expect(prepareRepoWorkflow({ cwd: repo.checkout, remote: '--upload-pack=evil' }))
      .rejects.toMatchObject({ code: 'INVALID_REMOTE' });
  });

  it('CAS-preserves a branch that advances after ownership persistence fails', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const branchRef = 'refs/heads/yeaft-wt/ownership-race';
    const worktreePath = join(repo.root, 'ownership-race');

    await expect(prepareRepoWorkflow({
      cwd: repo.checkout,
      name: 'ownership-race',
      worktreePath,
    }, {
      run: github.run,
      persistWorktreeOwnership: async () => {
        throw new Error('simulated ownership persistence failure');
      },
      beforePrepareBranchRollback: async ({ ref, expectedHead }) => {
        expect(ref).toBe(branchRef);
        expect(expectedHead).toBe(repo.baseSha);
        git(repo.checkout, 'update-ref', ref, repo.headSha, expectedHead);
      },
    })).rejects.toThrow('simulated ownership persistence failure');

    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo.checkout, 'rev-parse', branchRef)).toBe(repo.headSha);
    expect(github.calls.some(call => call.command === 'git'
      && call.args.join(' ') === `update-ref --no-deref -d ${branchRef} ${repo.baseSha}`)).toBe(true);
  });
});

describe('prepareRepoReview', () => {
  it('freezes exact GitHub refs and creates a detached merge-snapshot worktree', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const result = await prepareRepoReview({ cwd: repo.checkout, pr: 1 }, { run: github.run });

    expect(result.pullRequest).toMatchObject({
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      snapshotSha: repo.snapshotSha,
    });
    expect(result.landInput).toEqual({
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
    });
    const pullRequestCall = github.calls.find(call => call.command === 'gh' && call.args[0] === 'pr');
    expect(pullRequestCall.args).toEqual(expect.arrayContaining([
      '--repo',
      'github.example.test/acme/repo',
    ]));
    expect(git(result.reviewWorktree.path, 'rev-parse', 'HEAD')).toBe(repo.snapshotSha);
    expect(git(result.reviewWorktree.path, 'status', '--porcelain')).toBe('');
    expect(() => git(result.reviewWorktree.path, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });

  it('rejects failed checks before creating a review worktree', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, {
      pullRequest: { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] },
    });
    await expect(prepareRepoReview({ cwd: repo.checkout, pr: 1 }, { run: github.run }))
      .rejects.toMatchObject({ code: 'CHECKS_FAILED' });
    expect(github.calls.some(call => call.args[0] === 'fetch')).toBe(false);
  });
});

describe('standalone CLI surface', () => {
  it('only advertises worktree and review preparation', () => {
    expect(repoWorkflowHelp()).toContain('yeaft-repo prepare');
    expect(repoWorkflowHelp()).toContain('yeaft-repo review-prep');
    expect(repoWorkflowHelp()).not.toContain('yeaft-repo land');
    expect(() => parseRepoWorkflowArgs(['land'])).toThrow('Unknown command: land');
  });

  it('parses the supported preparation options', () => {
    expect(parseRepoWorkflowArgs([
      'prepare', '--name', 'feature-task', '--base', 'main', '--worktree', '/tmp/worktree',
    ])).toEqual({
      help: false,
      command: 'prepare',
      options: { name: 'feature-task', baseBranch: 'main', worktreePath: '/tmp/worktree' },
    });
    expect(parseRepoWorkflowArgs(['review-prep', '--pr', '42'])).toEqual({
      help: false,
      command: 'review-prep',
      options: { pr: 42 },
    });
  });

  it('emits one JSON error instead of shell logs', async () => {
    const stdout = [];
    const stderr = [];
    const exitCode = await runRepoWorkflowCli(['prepare', '--unknown', 'x'], {
      writeOut: text => stdout.push(text),
      writeErr: text => stderr.push(text),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0])).toMatchObject({ ok: false, code: 'UNEXPECTED_ERROR' });
  });
});
