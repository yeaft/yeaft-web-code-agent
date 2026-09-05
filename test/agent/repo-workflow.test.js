import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRepoWorkflowArgs, runRepoWorkflowCli } from '../../agent/repo-workflow-cli.js';
import {
  createRepoCommandRunner,
  formatRepoWorkflowError,
  landRepoWorkflow,
  nextNumericTag,
  parseGithubRemoteUrl,
  prepareRepoReview,
  prepareRepoWorkflow,
  summarizeChecks,
} from '../../agent/repo-workflow.js';
import { CONDITIONAL_BUILTIN_TOOL_NAMES, resolveActiveToolNames } from '../../agent/yeaft/tools/activation.js';
import { discoverToolCapabilities } from '../../agent/yeaft/tools/discover-tools.js';
import { allTools } from '../../agent/yeaft/tools/index.js';

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
  git(seed, 'push', 'origin', `HEAD:refs/pull/1/head`);

  git(seed, 'switch', 'main');
  git(seed, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  const snapshotSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', 'origin', `HEAD:refs/pull/1/merge`);

  git(root, 'clone', remote, checkout);
  git(checkout, 'config', 'user.name', 'Test User');
  git(checkout, 'config', 'user.email', 'test@example.test');
  return { root, remote, seed, checkout, baseSha, headSha, snapshotSha };
}

function pushSyntheticLanding(repo, { sameTree }) {
  let sha;
  if (sameTree) {
    sha = git(repo.seed, 'commit-tree', `${repo.snapshotSha}^{tree}`, '-p', repo.baseSha, '-m', 'synthetic squash');
  } else {
    writeFileSync(join(repo.seed, 'file.txt'), 'unreviewed landing\n');
    git(repo.seed, 'add', 'file.txt');
    git(repo.seed, 'commit', '-m', 'unreviewed landing');
    sha = git(repo.seed, 'rev-parse', 'HEAD');
  }
  git(repo.seed, 'push', 'origin', `${sha}:refs/heads/synthetic-landing`);
  return sha;
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
  const fetchUrl = options.githubRemoteUrl || 'git@github.example.test:acme/repo.git';
  const pushUrls = options.githubPushUrls || [fetchUrl];
  let pr = openPullRequest(repo, options.pullRequest);
  let workflowListCalls = 0;
  const run = async (command, args, commandOptions = {}) => {
    calls.push({ command, args: [...args] });
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return {
        stdout: args.includes('--push') ? pushUrls.join('\n') : fetchUrl,
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'git' && args[0] === 'push') {
      const pushUrlIndex = args.findIndex(arg => pushUrls.includes(arg));
      if (pushUrlIndex >= 0) {
        const refspec = args.find(arg => arg.startsWith('refs/tags/'));
        if (options.tagPushRace && refspec) {
          const [source, target] = refspec.split(':');
          const sha = git(commandOptions.cwd || repo.checkout, 'rev-parse', `${source}^{commit}`);
          git(repo.root, '--git-dir', repo.remote, 'update-ref', target, sha);
          return {
            stdout: `=\t${refspec}\t[up to date]`,
            stderr: '',
            exitCode: 0,
          };
        }
        const mappedArgs = [...args];
        mappedArgs[pushUrlIndex] = repo.remote;
        return baseRun(command, mappedArgs, commandOptions);
      }
    }
    if (command !== 'gh') return baseRun(command, args, commandOptions);
    if (args[0] === 'pr' && args[1] === 'view') {
      return { stdout: JSON.stringify(pr), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'repo' && args[1] === 'view') {
      if (args.includes('nameWithOwner')) {
        return { stdout: JSON.stringify({ nameWithOwner: 'acme/repo' }), stderr: '', exitCode: 0 };
      }
      return { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'api' && args.some(arg => /actions\/workflows\?per_page=100$/.test(arg))) {
      return {
        stdout: JSON.stringify([{
          workflows: options.workflows || [{ id: 77, name: 'Dev Release', path: '.github/workflows/dev-release.yml' }],
        }]),
        stderr: '',
        exitCode: 0,
      };
    }
    if (args[0] === 'api' && args.some(arg => /actions\/workflows\/\d+\/runs\?per_page=100$/.test(arg))) {
      workflowListCalls += 1;
      const runs = workflowListCalls === 1
        ? (options.workflowBaselineRuns || [])
        : (options.workflowRuns || []);
      const workflowRuns = runs.map(item => ({
        id: item.id ?? item.databaseId,
        workflow_id: item.workflow_id ?? item.workflowDatabaseId,
        head_sha: item.head_sha ?? item.headSha,
        head_branch: item.head_branch ?? item.headBranch,
        status: item.status,
        conclusion: item.conclusion,
        html_url: item.html_url ?? item.url,
        event: item.event,
        created_at: item.created_at ?? item.createdAt,
        run_started_at: item.run_started_at ?? item.startedAt,
      }));
      return { stdout: JSON.stringify({ workflow_runs: workflowRuns }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'api' && args.some(arg => /actions\/runs\/\d+$/.test(arg))) {
      const id = Number(args.find(arg => /actions\/runs\/\d+$/.test(arg)).split('/').pop());
      const detail = options.workflowDetails?.[id];
      if (!detail) throw new Error(`Missing workflow detail for run ${id}`);
      return { stdout: JSON.stringify(detail), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'api') {
      const mergeSha = options.mergeSha || repo.snapshotSha;
      git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', mergeSha);
      pr = openPullRequest(repo, {
        state: 'MERGED',
        mergeCommit: { oid: mergeSha },
        mergedAt: '2026-01-01T00:00:00Z',
      });
      return {
        stdout: JSON.stringify({ merged: true, sha: mergeSha, message: 'Pull Request successfully merged' }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const id = Number(args[2]);
      const detail = options.workflowDetails?.[id];
      if (!detail) throw new Error(`Missing workflow detail for run ${id}`);
      return { stdout: JSON.stringify({ jobs: detail.jobs || [] }), stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };
  return { run, calls, getPullRequest: () => pr };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository workflow helpers', () => {
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

  it('redacts URL credentials from command failures', async () => {
    const runner = createRepoCommandRunner({
      execFileImpl: async () => {
        const error = new Error('fetch https://user:secret-token@github.example.test/acme/repo failed');
        error.code = 128;
        error.stderr = 'fatal: unable to access https://user:secret-token@github.example.test/acme/repo';
        throw error;
      },
    });
    let caught;
    try {
      await runner('git', ['fetch', 'https://user:secret-token@github.example.test/acme/repo']);
    } catch (error) {
      caught = error;
    }

    const formatted = formatRepoWorkflowError(caught);
    expect(formatted.code).toBe('COMMAND_FAILED');
    expect(JSON.stringify(formatted)).not.toContain('secret-token');
    expect(JSON.stringify(formatted)).toContain('https://***@github.example.test/acme/repo');
  });

  it('redacts plain and encoded query-string credentials from structured failures', async () => {
    const runner = createRepoCommandRunner({
      execFileImpl: async () => {
        const error = new Error('request failed');
        error.code = 128;
        error.stderr = [
          'https://github.example.test/acme/repo?access_token=plain-secret&x=1',
          'https%3A%2F%2Fgithub.example.test%2Facme%2Frepo%3Ftoken%3Dencoded-secret%26x%3D1',
          'https%253A%252F%252Fgithub.example.test%252Facme%252Frepo%253Faccess%255Ftoken%253Ddouble-secret%2526x%253D1',
        ].join('\n');
        throw error;
      },
    });
    let caught;
    try {
      await runner('git', ['fetch', 'https://github.example.test/acme/repo?token=argument-secret']);
    } catch (error) {
      caught = error;
    }

    const serialized = JSON.stringify(formatRepoWorkflowError(caught));
    expect(serialized).not.toMatch(/plain-secret|encoded-secret|double-secret|argument-secret/);
    expect(serialized.match(/\*\*\*/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('redacts credentials from unexpected errors at the final serialization boundary', () => {
    const error = new Error('request https://github.example.test/acme/repo?access_token=unexpected-secret&keep=visible failed');
    const serialized = JSON.stringify(formatRepoWorkflowError(error));
    expect(serialized).not.toContain('unexpected-secret');
    expect(serialized).toContain('keep=visible');
  });

  it('calculates numeric tags without lexicographic version mistakes', () => {
    expect(nextNumericTag(['v1.0.9', 'v1.0.10', 'v1.0.beta', 'other-99'], 'v1.0.')).toBe('v1.0.11');
    expect(nextNumericTag([], 'release-', 7)).toBe('release-7');
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
  it('creates and then safely reuses a worktree pinned to the latest remote base', async () => {
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

  it('does not expose a credential-bearing remote URL in structured output', async () => {
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
    await expect(prepareRepoWorkflow({ cwd: repo.checkout, remote: '--upload-pack=evil' })).rejects.toMatchObject({
      code: 'INVALID_REMOTE',
    });
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

describe('landRepoWorkflow', () => {
  it('head-match merges, creates the next remote numeric tag, and removes only requested clean worktrees', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const review = await prepareRepoReview({ cwd: repo.checkout, pr: 1 }, { run: github.run });
    const developmentPath = join(repo.root, 'development');
    await prepareRepoWorkflow({
      cwd: repo.checkout,
      name: 'feature',
      baseBranch: 'feature',
      worktreePath: developmentPath,
    }, { run: github.run });

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      tagPrefix: 'v1.0.',
      worktreePaths: [developmentPath, review.reviewWorktree.path],
    }, { run: github.run });

    expect(result).toMatchObject({
      ok: true,
      merge: { sha: repo.snapshotSha, alreadyMerged: false },
      tag: { name: 'v1.0.0', sha: repo.snapshotSha, reused: false },
      cleanup: [
        { path: developmentPath, status: 'removed', branch: 'yeaft-wt/feature', branchDeleted: true },
        { path: review.reviewWorktree.path, status: 'removed', branch: null, branchDeleted: false },
      ],
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
    const mergeCall = github.calls.find(call => call.command === 'gh' && call.args[0] === 'api');
    expect(mergeCall.args).toEqual(expect.arrayContaining([
      '--hostname',
      'github.example.test',
      'repos/acme/repo/pulls/1/merge',
      `sha=${repo.headSha}`,
    ]));
    expect(() => readFileSync(join(developmentPath, 'file.txt'))).toThrow();
  });

  it('stops before merge when the reviewed snapshot is stale', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: '0'.repeat(40),
      approvedBy: 'reviewer',
    }, { run: github.run })).rejects.toMatchObject({ code: 'REVIEW_STALE' });
    expect(github.calls.some(call => call.command === 'gh' && call.args[0] === 'api')).toBe(false);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
  });

  it('rejects a pushurl that targets another repository before merge or tag side effects', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, {
      githubPushUrls: ['git@github.example.test:other/repository.git'],
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      tagPrefix: 'v1.0.',
    }, { run: github.run })).rejects.toMatchObject({
      code: 'GITHUB_PUSH_URL_MISMATCH',
      details: {
        expected: 'github.example.test/acme/repo',
        pushTargets: ['github.example.test/other/repository'],
      },
    });

    expect(github.calls.some(call => call.command === 'gh' && call.args[0] === 'api')).toBe(false);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
  });

  it('keeps dirty requested worktrees after a successful merge', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const developmentPath = join(repo.root, 'development');
    await prepareRepoWorkflow({
      cwd: repo.checkout,
      name: 'feature',
      baseBranch: 'feature',
      worktreePath: developmentPath,
    }, { run: github.run });
    writeFileSync(join(developmentPath, 'untracked.txt'), 'keep me\n');

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      worktreePaths: [developmentPath],
    }, { run: github.run });

    expect(result.cleanup).toEqual([{ path: developmentPath, status: 'kept-dirty' }]);
    expect(readFileSync(join(developmentPath, 'untracked.txt'), 'utf8')).toBe('keep me\n');
  });

  it('keeps an owned worktree when it contains ignored files', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const developmentPath = join(repo.root, 'development');
    await prepareRepoWorkflow({
      cwd: repo.checkout,
      name: 'feature',
      baseBranch: 'feature',
      worktreePath: developmentPath,
    }, { run: github.run });
    const commonDir = git(developmentPath, 'rev-parse', '--git-common-dir');
    const excludePath = join(commonDir, 'info', 'exclude');
    writeFileSync(excludePath, `${readFileSync(excludePath, 'utf8')}\ncredentials.secret\n`);
    writeFileSync(join(developmentPath, 'credentials.secret'), 'must survive\n');
    expect(git(developmentPath, 'status', '--porcelain=v1')).toBe('');

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      worktreePaths: [developmentPath],
    }, { run: github.run });

    expect(result.cleanup).toEqual([{ path: developmentPath, status: 'kept-dirty' }]);
    expect(readFileSync(join(developmentPath, 'credentials.secret'), 'utf8')).toBe('must survive\n');
  });

  it('never removes a requested clean worktree that is not owned by this workflow', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const unrelatedPath = join(repo.root, 'unrelated');
    git(repo.checkout, 'worktree', 'add', '-b', 'human-work', unrelatedPath, 'origin/main');

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      worktreePaths: [unrelatedPath],
    }, { run: github.run });

    expect(result.cleanup).toEqual([{
      path: unrelatedPath,
      status: 'kept-unowned',
      branch: 'human-work',
      head: repo.baseSha,
    }]);
    expect(readFileSync(join(unrelatedPath, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('waits for the newest matching workflow run instead of relying on API order', async () => {
    const repo = createPullRequestRepository();
    const common = {
      headSha: repo.snapshotSha,
      headBranch: 'main',
      workflowDatabaseId: 77,
      workflowName: 'Dev Release',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
    };
    const github = createGithubRunner(repo, {
      workflowBaselineRuns: [{ databaseId: 10, workflowDatabaseId: 77 }],
      workflowRuns: [
        { ...common, databaseId: 11, createdAt: '2026-09-05T12:00:01Z', url: 'https://example.test/runs/11' },
        { ...common, databaseId: 12, createdAt: '2026-09-05T12:00:02Z', url: 'https://example.test/runs/12' },
      ],
      workflowDetails: {
        11: { id: 11, workflow_id: 77, head_sha: repo.snapshotSha, head_branch: 'main', created_at: '2026-09-05T12:00:01Z', status: 'completed', conclusion: 'success', event: 'push', html_url: 'https://example.test/runs/11', jobs: [] },
        12: { id: 12, workflow_id: 77, head_sha: repo.snapshotSha, head_branch: 'main', created_at: '2026-09-05T12:00:02Z', status: 'completed', conclusion: 'success', event: 'push', html_url: 'https://example.test/runs/12', jobs: [] },
      },
    });

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      workflow: 'Dev Release',
      pollIntervalMs: 1,
      waitTimeoutMs: 100,
    }, {
      run: github.run,
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      sleep: async () => {},
    });

    expect(result.workflow).toMatchObject({ id: 12, workflowId: 77, url: 'https://example.test/runs/12' });
    expect(github.calls).toContainEqual(expect.objectContaining({
      command: 'gh',
      args: expect.arrayContaining(['api', 'repos/acme/repo/actions/workflows?per_page=100']),
    }));
    expect(github.calls.some(call => call.command === 'gh'
      && call.args[0] === 'workflow'
      && call.args[1] === 'view')).toBe(false);
    const viewCall = github.calls.find(call => call.command === 'gh' && call.args[0] === 'run' && call.args[1] === 'view');
    expect(viewCall.args[2]).toBe('12');
  });

  it('does not attribute an old push or workflow_dispatch run to this landing', async () => {
    const repo = createPullRequestRepository();
    const timestamp = '2026-09-05T12:00:01Z';
    const github = createGithubRunner(repo, {
      workflowBaselineRuns: [{ databaseId: 20, workflowDatabaseId: 77 }],
      workflowRuns: [
        {
          databaseId: 20,
          workflowDatabaseId: 77,
          headSha: repo.snapshotSha,
          headBranch: 'v1.0.0',
          createdAt: timestamp,
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        },
        {
          databaseId: 21,
          workflowDatabaseId: 77,
          headSha: repo.snapshotSha,
          headBranch: 'v1.0.0',
          createdAt: timestamp,
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    });
    let clock = Date.parse('2026-09-05T12:00:00Z');

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      tagPrefix: 'v1.0.',
      workflow: 'Dev Release',
      pollIntervalMs: 1,
      waitTimeoutMs: 150,
    }, {
      run: github.run,
      now: () => {
        clock += 100;
        return clock;
      },
      sleep: async () => {},
    })).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
      details: {
        remoteEffects: {
          tag: { status: 'created', name: 'v1.0.0', sha: repo.snapshotSha },
        },
      },
    });
  });

  it('revalidates immutable workflow identity from the Actions run API', async () => {
    const repo = createPullRequestRepository();
    const runInfo = {
      databaseId: 31,
      workflowDatabaseId: 77,
      headSha: repo.snapshotSha,
      headBranch: 'main',
      createdAt: '2026-09-05T12:00:01Z',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    };
    const github = createGithubRunner(repo, {
      workflowBaselineRuns: [{ databaseId: 30, workflowDatabaseId: 77 }],
      workflowRuns: [runInfo],
      workflowDetails: {
        31: {
          id: 31,
          workflow_id: 88,
          head_sha: repo.snapshotSha,
          head_branch: 'main',
          created_at: '2026-09-05T12:00:01Z',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        },
      },
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      workflow: 'Dev Release',
      pollIntervalMs: 1,
      waitTimeoutMs: 100,
    }, {
      run: github.run,
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'WORKFLOW_IDENTITY_MISMATCH' });
  });

  it('accepts a different squash commit when its tree matches the approved snapshot', async () => {
    const repo = createPullRequestRepository();
    const mergeSha = pushSyntheticLanding(repo, { sameTree: true });
    const github = createGithubRunner(repo, { mergeSha });

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      mergeMethod: 'squash',
    }, { run: github.run });

    expect(result.merge).toEqual({ sha: mergeSha, alreadyMerged: false });
    expect(mergeSha).not.toBe(repo.snapshotSha);
    expect(git(repo.checkout, 'rev-parse', `${mergeSha}^{tree}`))
      .toBe(git(repo.checkout, 'rev-parse', `${repo.snapshotSha}^{tree}`));
  });

  it('reports remote effects when GitHub lands a tree that was not reviewed', async () => {
    const repo = createPullRequestRepository();
    const mergeSha = pushSyntheticLanding(repo, { sameTree: false });
    const github = createGithubRunner(repo, { mergeSha });

    let caught;
    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
        approvedBy: 'reviewer',
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'LANDING_TREE_MISMATCH',
      details: { remoteEffects: { merge: { status: 'created', sha: mergeSha } } },
    });
    expect(formatRepoWorkflowError(caught)).toMatchObject({
      ok: false,
      errorEffect: 'unknown',
      code: 'LANDING_TREE_MISMATCH',
    });
  });

  it('reuses the latest remote tag when land is retried for the same merged PR', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const input = {
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      tagPrefix: 'v1.0.',
    };

    const first = await landRepoWorkflow(input, { run: github.run });
    const second = await landRepoWorkflow(input, { run: github.run });

    expect(first.tag).toEqual({ name: 'v1.0.0', sha: repo.snapshotSha, reused: false });
    expect(second).toMatchObject({
      merge: { sha: repo.snapshotSha, alreadyMerged: true },
      tag: { name: 'v1.0.0', sha: repo.snapshotSha, reused: true },
    });
    expect(github.calls.filter(call => call.command === 'gh' && call.args[0] === 'api')).toHaveLength(1);
  });

  it('reuses any numeric remote tag already pointing at the landed commit', async () => {
    const repo = createPullRequestRepository();
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/tags/v1.0.0', repo.snapshotSha);
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/tags/v1.0.1', repo.baseSha);
    const github = createGithubRunner(repo);

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      tagPrefix: 'v1.0.',
    }, { run: github.run });

    expect(result.tag).toEqual({ name: 'v1.0.0', sha: repo.snapshotSha, reused: true });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.1')).toBe(repo.baseSha);
  });

  it('reports a same-target concurrent tag winner as reused', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, { tagPushRace: true });

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
      tagPrefix: 'v1.0.',
    }, { run: github.run });

    expect(result.tag).toEqual({ name: 'v1.0.0', sha: repo.snapshotSha, reused: true });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
  });

  it('reports deterministic tag validation failures as not attempted', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    let caught;

    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
        approvedBy: 'reviewer',
        tagPrefix: 'bad tag',
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'INVALID_TAG_PREFIX',
      details: {
        remoteEffects: {
          merge: { status: 'created', sha: repo.snapshotSha },
          tag: { stage: 'validate', status: 'not-attempted', prefix: 'bad tag', sha: repo.snapshotSha },
        },
      },
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
  });

  it('does not let an already-merged retry bypass the reviewed head', async () => {
    const repo = createPullRequestRepository();
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', repo.snapshotSha);
    const github = createGithubRunner(repo, {
      pullRequest: {
        state: 'MERGED',
        mergeCommit: { oid: repo.snapshotSha },
        mergedAt: '2026-01-01T00:00:00Z',
      },
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      reviewedHead: '0'.repeat(40),
      reviewedSnapshot: repo.snapshotSha,
      approvedBy: 'reviewer',
    }, { run: github.run })).rejects.toMatchObject({ code: 'REVIEW_STALE' });
  });
});

describe('CLI and tool surface', () => {
  it('parses repeated cleanup paths and exact review evidence', () => {
    expect(parseRepoWorkflowArgs([
      'land', '--pr', '42', '--reviewed-head', 'a'.repeat(40), '--reviewed-snapshot', 'b'.repeat(40),
      '--approved-by', 'martin', '--tag-prefix', 'v2.', '--cleanup-worktree', '/one', '--cleanup-worktree', '/two',
    ])).toEqual({
      help: false,
      command: 'land',
      options: {
        pr: 42,
        reviewedHead: 'a'.repeat(40),
        reviewedSnapshot: 'b'.repeat(40),
        approvedBy: 'martin',
        tagPrefix: 'v2.',
        worktreePaths: ['/one', '/two'],
      },
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

  it('registers a destructive land phase without hiding read/write preparation', () => {
    const tool = allTools.find(item => item.name === 'RepoWorkflow');
    expect(tool).toBeTruthy();
    expect(tool.isDestructive({ phase: 'prepare' })).toBe(false);
    expect(tool.isDestructive({ phase: 'review-prep' })).toBe(false);
    expect(tool.isDestructive({ phase: 'land' })).toBe(true);
  });

  it('keeps the workflow schema hidden from unrelated turns while preserving activation and discovery', () => {
    const toolNames = allTools.map(tool => tool.name);
    expect(CONDITIONAL_BUILTIN_TOOL_NAMES.has('RepoWorkflow')).toBe(true);
    expect(resolveActiveToolNames({ toolNames, prompt: 'Explain this function.' }).has('RepoWorkflow')).toBe(false);
    expect(resolveActiveToolNames({
      toolNames,
      prompt: 'Prepare a GitHub pull request review workflow.',
    }).has('RepoWorkflow')).toBe(true);
    for (const prompt of ['Review PR #42', 'Merge PR #42', '审查 PR #42', '合并 PR #42']) {
      expect(resolveActiveToolNames({ toolNames, prompt }).has('RepoWorkflow'), prompt).toBe(true);
    }

    const candidate = allTools.find(tool => tool.name === 'RepoWorkflow');
    const directory = discoverToolCapabilities({
      query: 'automate worktree pull request merge tag workflow',
      candidates: [{
        name: candidate.name,
        description: candidate.description.en,
        parameters: candidate.parameters,
      }],
    });
    expect(directory.tools.map(tool => tool.name)).toContain('RepoWorkflow');
  });
});
