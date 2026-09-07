import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRepoWorkflowArgs, repoWorkflowHelp, runRepoWorkflowCli } from '../../agent/repo-workflow-cli.js';
import {
  createRepoCommandRunner,
  formatRepoWorkflowError,
  landRepoWorkflow as landRepoWorkflowCore,
  nextNumericTag,
  parseGithubRemoteUrl,
  prepareRepoReview,
  prepareRepoWorkflow,
  summarizeChecks,
} from '../../agent/repo-workflow.js';
import { bindRepoApprovalCapability, createRouter } from '../../agent/yeaft/routing/router.js';
import { createCoordinator } from '../../agent/yeaft/sessions/coordinator.js';
import { CONDITIONAL_BUILTIN_TOOL_NAMES, resolveActiveToolNames } from '../../agent/yeaft/tools/activation.js';
import { discoverToolCapabilities } from '../../agent/yeaft/tools/discover-tools.js';
import { allTools } from '../../agent/yeaft/tools/index.js';

const tempRoots = [];

function issueTestApproval(options, repository = 'github.example.test/acme/repo', {
  turnId = 'turn-repo-workflow-test',
  now = Date.now,
} = {}) {
  let envelope = null;
  const group = {
    getMeta: () => ({
      id: 'test-session',
      roster: ['linus', 'martin'],
      defaultVpId: 'linus',
    }),
    appendMessage: record => ({ id: 'msg-approval', ts: new Date(0).toISOString(), ...record }),
  };
  const coordinator = createCoordinator(group, {
    deliver(vpId, delivered) {
      if (vpId === 'linus') envelope = delivered;
    },
  });
  const result = createRouter({ coordinator, now }).forward({
    from: 'martin',
    to: 'linus',
    text: 'APPROVE exact repository landing tuple',
    repoApproval: {
      repository,
      pr: options.pr,
      baseBranch: options.baseBranch,
      baseSha: options.baseSha,
      reviewedHead: options.reviewedHead,
      reviewedSnapshot: options.reviewedSnapshot,
    },
  });
  if (!result.ok || !envelope?._repoApproval) throw new Error('test approval capability was not issued');
  if (!bindRepoApprovalCapability(envelope._repoApproval, {
    sessionId: envelope.sessionId,
    recipientVpId: 'linus',
    turnId,
  }, { now })) {
    throw new Error('test approval capability was not bound');
  }
  return { envelope, turnId };
}

function landRepoWorkflow(options = {}, dependencies = {}) {
  const { envelope, turnId } = issueTestApproval(options, dependencies.approvalRepository, {
    turnId: dependencies.approvalTurnId,
    now: dependencies.now,
  });
  return landRepoWorkflowCore(options, {
    ...dependencies,
    approvalCapability: envelope._repoApproval,
    approvalContext: { sessionId: envelope.sessionId, recipientVpId: 'linus', turnId },
  });
}

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

function runReleaseFence(checkout, tag, commit) {
  return execFileSync('sh', [
    join(process.cwd(), 'scripts/verify-dev-release.sh'),
    'verify',
    tag,
    commit,
  ], { cwd: checkout, encoding: 'utf8' }).trim();
}

function createBaseAdvanceCommit(repo) {
  writeFileSync(join(repo.seed, 'advanced.txt'), 'advance remote base\n');
  git(repo.seed, 'add', 'advanced.txt');
  git(repo.seed, 'commit', '-m', 'advance remote base');
  const advancedBaseSha = git(repo.seed, 'rev-parse', 'HEAD');
  git(repo.seed, 'push', 'origin', `${advancedBaseSha}:refs/heads/race-object`);
  return advancedBaseSha;
}

function installBaseReceiveAdvanceHook(repo) {
  const advancedBaseSha = createBaseAdvanceCommit(repo);
  const requestSeen = join(repo.root, 'base-request-seen');
  const baseAdvanced = join(repo.root, 'base-advanced');
  const hook = join(repo.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh
set -eu
touch ${JSON.stringify(requestSeen)}
for attempt in $(seq 1 1000); do
  [ -e ${JSON.stringify(baseAdvanced)} ] && exit 0
  sleep 0.001
done
exit 1
`);
  chmodSync(hook, 0o755);
  return { advancedBaseSha, requestSeen, baseAdvanced };
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
  let exactRemoteTagLookups = 0;
  let exactRemoteTagLookupPending = false;
  const run = async (command, args, commandOptions = {}) => {
    calls.push({ command, args: [...args] });
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return {
        stdout: args.includes('--push') ? pushUrls.join('\n') : fetchUrl,
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'git' && args[0] === 'ls-remote' && pushUrls.includes(args[1])) {
      const mappedArgs = [...args];
      mappedArgs[1] = repo.remote;
      return baseRun(command, mappedArgs, commandOptions);
    }
    if (command === 'git' && args[0] === 'ls-remote' && args.includes('origin')) {
      const tagPattern = args.find(arg => arg.startsWith('refs/tags/') && arg.endsWith('*'));
      const exactTag = args.find(arg => /^refs\/tags\/[^*]+$/.test(arg));
      const waitsForExactLookup = exactTag && !exactTag.endsWith('^{}');
      if (waitsForExactLookup) exactRemoteTagLookupPending = true;
      try {
        const readRemote = () => baseRun(command, args, commandOptions);
        const result = options.onRemoteBaseLookup && args.includes('refs/heads/main')
          ? await options.onRemoteBaseLookup({ exactRemoteTagLookupPending, readRemote })
          : await readRemote();
        if (options.afterRemoteTagScan && tagPattern) await options.afterRemoteTagScan();
        if (waitsForExactLookup) {
          exactRemoteTagLookups += 1;
          if (options.afterExactRemoteTagLookup) {
            await options.afterExactRemoteTagLookup(exactTag, exactRemoteTagLookups);
          }
        }
        return result;
      } finally {
        if (waitsForExactLookup) exactRemoteTagLookupPending = false;
      }
    }
    if (command === 'git' && args[0] === 'push') {
      const pushUrlIndex = args.findIndex(arg => pushUrls.includes(arg));
      const tagRefspec = args.find(arg => /^[^:]*:refs\/tags\//.test(arg));
      const baseRefspec = args.find(arg => /^[0-9a-f]{40}:refs\/heads\/main$/i.test(arg));
      const deletesTag = tagRefspec?.startsWith(':');
      if (pushUrlIndex >= 0 && baseRefspec && options.basePushResult) {
        return options.basePushResult(baseRefspec);
      }
      if (options.baseReceiveRace && pushUrlIndex >= 0 && baseRefspec) {
        const mappedArgs = [...args];
        mappedArgs[pushUrlIndex] = repo.remote;
        const push = baseRun(command, mappedArgs, commandOptions);
        for (let attempt = 0; attempt < 1000 && !existsSync(options.baseReceiveRace.requestSeen); attempt += 1) {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 1));
        }
        if (!existsSync(options.baseReceiveRace.requestSeen)) throw new Error('Timed out waiting for base receive hook');
        git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', options.baseReceiveRace.advancedBaseSha, repo.baseSha);
        writeFileSync(options.baseReceiveRace.baseAdvanced, 'advanced\n');
        return push;
      }
      if (pushUrlIndex >= 0) {
        if (options.beforeTagDelete && deletesTag) await options.beforeTagDelete(tagRefspec);
        if (options.tagPushRace && tagRefspec && !deletesTag) {
          const [source, target] = tagRefspec.split(':');
          const sha = git(commandOptions.cwd || repo.checkout, 'rev-parse', `${source}^{commit}`);
          git(repo.root, '--git-dir', repo.remote, 'update-ref', target, sha);
          return {
            stdout: `=\t${tagRefspec}\t[up to date]`,
            stderr: '',
            exitCode: 0,
          };
        }
        const mappedArgs = [...args];
        mappedArgs[pushUrlIndex] = repo.remote;
        const result = await baseRun(command, mappedArgs, commandOptions);
        if (baseRefspec && result.exitCode === 0) {
          const [mergeSha] = baseRefspec.split(':');
          pr = openPullRequest(repo, {
            state: 'MERGED',
            mergeCommit: { oid: mergeSha },
            mergedAt: '2026-01-01T00:00:00Z',
          });
          if (options.basePushAcceptedThenErrorAndReset) {
            git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', repo.baseSha, mergeSha);
            if (options.basePushAcceptedThenErrorAndReset === 'exit-code') {
              return { stdout: '', stderr: 'connection lost after receive-pack', exitCode: 1 };
            }
            throw new Error('simulated transport failure after remote base acceptance and ABA reset');
          }
          if (options.basePushAcceptedThenError) {
            git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', options.basePushAcceptedThenError, mergeSha);
            throw new Error('simulated transport failure after remote base acceptance and advance');
          }
        }
        if (options.afterTagPushAccepted && tagRefspec && !deletesTag && result.exitCode === 0) {
          await options.afterTagPushAccepted(tagRefspec);
        }
        if (options.tagPushAcceptedThenError && tagRefspec && !deletesTag) {
          throw new Error('simulated transport failure after remote acceptance');
        }
        return result;
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

  it('calculates numeric development tags without lexicographic version mistakes', () => {
    expect(nextNumericTag(['v1.0.9', 'v1.0.10', 'v1.0.beta', 'other-99'], 'v1.0.')).toBe('v1.0.11');
    expect(nextNumericTag([], 'v2.3.', 7)).toBe('v2.3.7');
  });

  it.each(['', 'release-', 'v2.', 'v1.0', 'v1.0.$(touch nope)', 'v1.0.;echo nope']) (
    'rejects non-development tag prefix %s',
    prefix => {
      expect(() => nextNumericTag([], prefix)).toThrowError(expect.objectContaining({
        code: 'INVALID_TAG_PREFIX',
      }));
    },
  );

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

describe('landRepoWorkflow', () => {
  it('atomically installs the exact reviewed snapshot on the frozen base and tags it', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run });

    expect(result).toMatchObject({
      ok: true,
      merge: { sha: repo.snapshotSha, alreadyMerged: false },
      tag: { name: 'v1.0.0', sha: repo.snapshotSha, reused: false },
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.snapshotSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
    const basePush = github.calls.find(call => call.command === 'git'
      && call.args[0] === 'push'
      && call.args.includes(`${repo.snapshotSha}:refs/heads/main`));
    expect(basePush.args).toContain(`--force-with-lease=refs/heads/main:${repo.baseSha}`);
    expect(github.calls.some(call => call.command === 'gh'
      && call.args[0] === 'api'
      && call.args.some(arg => /pulls\/1\/merge$/.test(arg)))).toBe(false);
  });

  it('rejects a same-tip PR retarget before any push', async () => {
    const repo = createPullRequestRepository();
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/release', repo.baseSha);
    const github = createGithubRunner(repo, {
      pullRequest: { baseRefName: 'release' },
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
    }, { run: github.run })).rejects.toMatchObject({
      code: 'REVIEW_STALE',
      details: {
        reviewed: { baseBranch: 'main', baseSha: repo.baseSha },
        current: { baseBranch: 'release' },
      },
    });

    expect(github.calls.some(call => call.command === 'git' && call.args[0] === 'push')).toBe(false);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/release')).toBe(repo.baseSha);
  });

  it('stops before merge when the reviewed snapshot is stale', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: '0'.repeat(40),
    }, { run: github.run })).rejects.toMatchObject({ code: 'REVIEW_STALE' });
    expect(github.calls.some(call => call.command === 'gh' && call.args[0] === 'api')).toBe(false);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
  });

  it('rejects approval for the same owner and repository on another GitHub host', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
    }, {
      run: github.run,
      approvalRepository: 'github.com/acme/repo',
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
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

  it.each([
    ['the active repository root', repo => [repo.checkout]],
    ['another worktree', repo => [join(repo.root, 'development')]],
  ])('rejects cleanup for %s before any repository or remote side effect', async (_label, cleanupPaths) => {
    const repo = createPullRequestRepository();
    let calls = 0;

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      worktreePaths: cleanupPaths(repo),
    }, {
      run: async () => {
        calls += 1;
        throw new Error('runner must not execute');
      },
    })).rejects.toMatchObject({ code: 'LANDING_CLEANUP_UNSUPPORTED' });

    expect(calls).toBe(0);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      workflow: 'Dev Release',
      pollIntervalMs: 1,
      waitTimeoutMs: 100,
    }, {
      run: github.run,
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'WORKFLOW_IDENTITY_MISMATCH' });
  });

  it('rejects mergeMethod before any repository or remote side effect', async () => {
    const repo = createPullRequestRepository();
    let calls = 0;

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      mergeMethod: 'squash',
    }, {
      run: async () => {
        calls += 1;
        throw new Error('runner must not execute');
      },
    })).rejects.toMatchObject({ code: 'MERGE_METHOD_UNSUPPORTED' });

    expect(calls).toBe(0);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
  });

  it('reuses the latest remote tag when land is retried for the same merged PR', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const input = {
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    };

    const first = await landRepoWorkflow(input, { run: github.run });
    const second = await landRepoWorkflow(input, { run: github.run });

    expect(first.tag).toEqual({ name: 'v1.0.0', sha: repo.snapshotSha, reused: false });
    expect(second).toMatchObject({
      merge: { sha: repo.snapshotSha, alreadyMerged: true },
      tag: { name: 'v1.0.0', sha: repo.snapshotSha, reused: true },
    });
    expect(github.calls.filter(call => call.command === 'gh'
      && call.args[0] === 'api'
      && call.args.some(arg => /pulls\/1\/merge$/.test(arg)))).toHaveLength(0);
  });

  it('reuses any numeric remote tag already pointing at the landed commit', async () => {
    const repo = createPullRequestRepository();
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/tags/v1.0.0', repo.snapshotSha);
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/tags/v1.0.1', repo.baseSha);
    const github = createGithubRunner(repo);

    const result = await landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run });

    expect(result.tag).toEqual({ name: 'v1.0.0', sha: repo.snapshotSha, reused: true });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
  });

  it('fails closed when base advances after a matching tag is found in the remote scan', async () => {
    const repo = createPullRequestRepository();
    const advancedBaseSha = createBaseAdvanceCommit(repo);
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/tags/v1.0.0', repo.snapshotSha);
    const github = createGithubRunner(repo, {
      afterRemoteTagScan: () => {
        git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', advancedBaseSha, repo.snapshotSha);
      },
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run })).rejects.toMatchObject({
      code: 'BASE_ADVANCED_DURING_TAG_PUSH',
      details: {
        tag: 'v1.0.0',
        expected: repo.snapshotSha,
        actual: advancedBaseSha,
        tagRolledBack: false,
        transientTagMayHaveTriggeredAutomation: false,
      },
    });

    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(advancedBaseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
  });

  it('fails closed when base advances after a concurrently created target tag is resolved', async () => {
    const repo = createPullRequestRepository();
    const advancedBaseSha = createBaseAdvanceCommit(repo);
    const github = createGithubRunner(repo, {
      afterRemoteTagScan: () => {
        git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/tags/v1.0.0', repo.snapshotSha);
      },
      afterExactRemoteTagLookup: () => {
        git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', advancedBaseSha, repo.snapshotSha);
      },
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run })).rejects.toMatchObject({
      code: 'BASE_ADVANCED_DURING_TAG_PUSH',
      details: {
        tag: 'v1.0.0',
        expected: repo.snapshotSha,
        actual: advancedBaseSha,
        tagRolledBack: false,
        transientTagMayHaveTriggeredAutomation: false,
      },
    });

    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(advancedBaseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
  });

  it('preserves an unknown tag effect after a successful rollback', async () => {
    const repo = createPullRequestRepository();
    const advancedBaseSha = createBaseAdvanceCommit(repo);
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', repo.snapshotSha, repo.baseSha);
    const github = createGithubRunner(repo, {
      pullRequest: {
        state: 'MERGED',
        mergeCommit: { oid: repo.snapshotSha },
        mergedAt: '2026-01-01T00:00:00Z',
      },
      afterTagPushAccepted: () => {
        git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', advancedBaseSha, repo.snapshotSha);
      },
    });

    let caught;
    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        baseBranch: 'main',
        baseSha: repo.baseSha,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
        tagPrefix: 'v1.0.',
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'BASE_ADVANCED_DURING_TAG_PUSH',
      details: {
        tagRolledBack: true,
        transientTagMayHaveTriggeredAutomation: true,
        remoteEffects: {
          base: { status: 'preexisting' },
          tag: {
            stage: 'rolled-back',
            status: 'unknown',
            name: 'v1.0.0',
            sha: repo.snapshotSha,
            transientTagMayHaveTriggeredAutomation: true,
          },
        },
      },
    });
    expect(formatRepoWorkflowError(caught)).toMatchObject({
      errorEffect: 'unknown',
      code: 'BASE_ADVANCED_DURING_TAG_PUSH',
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(advancedBaseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
  });

  it('checks the base after the final tag lookup completes', async () => {
    const repo = createPullRequestRepository();
    const advancedBaseSha = createBaseAdvanceCommit(repo);
    git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', repo.snapshotSha, repo.baseSha);
    let concurrentBaseLookupStarted = false;
    let finishConcurrentBaseRead;
    const concurrentBaseRead = new Promise(resolvePromise => { finishConcurrentBaseRead = resolvePromise; });
    const github = createGithubRunner(repo, {
      pullRequest: {
        state: 'MERGED',
        mergeCommit: { oid: repo.snapshotSha },
        mergedAt: '2026-01-01T00:00:00Z',
      },
      onRemoteBaseLookup: async ({ exactRemoteTagLookupPending, readRemote }) => {
        if (!exactRemoteTagLookupPending) return readRemote();
        concurrentBaseLookupStarted = true;
        const result = await readRemote();
        finishConcurrentBaseRead();
        return result;
      },
      afterExactRemoteTagLookup: async (_ref, lookupNumber) => {
        if (lookupNumber !== 2) return;
        if (concurrentBaseLookupStarted) await concurrentBaseRead;
        git(repo.root, '--git-dir', repo.remote, 'update-ref', 'refs/heads/main', advancedBaseSha, repo.snapshotSha);
      },
    });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run })).rejects.toMatchObject({
      code: 'BASE_ADVANCED_DURING_TAG_PUSH',
      details: {
        expected: repo.snapshotSha,
        actual: advancedBaseSha,
        tagRolledBack: true,
      },
    });

    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(advancedBaseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
  });

  it('reports an accepted tag push followed by a transport error as unknown', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, { tagPushAcceptedThenError: true });

    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run })).rejects.toMatchObject({
      code: 'TAG_PUSH_OUTCOME_UNKNOWN',
      details: {
        tag: 'v1.0.0',
        directSha: repo.snapshotSha,
        commitSha: repo.snapshotSha,
        transientTagMayHaveTriggeredAutomation: true,
        remoteEffects: {
          tag: {
            stage: 'push-outcome-unknown',
            status: 'unknown',
            name: 'v1.0.0',
            sha: repo.snapshotSha,
            transientTagMayHaveTriggeredAutomation: true,
          },
        },
      },
    });

    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(repo.snapshotSha);
    expect(git(repo.checkout, 'tag')).toBe('');
    const tagPushes = github.calls.filter(call => call.command === 'git'
      && call.args[0] === 'push'
      && call.args.some(arg => arg.endsWith(':refs/tags/v1.0.0')));
    expect(tagPushes).toHaveLength(1);
  });

  it.each([true, 'exit-code'])('keeps an accepted base push followed by transport failure (%s) and ABA reset unknown', async (failureMode) => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, { basePushAcceptedThenErrorAndReset: failureMode });

    let caught;
    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        baseBranch: 'main',
        baseSha: repo.baseSha,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'BASE_UPDATE_OUTCOME_UNKNOWN',
      details: {
        ref: 'refs/heads/main',
        expectedOld: repo.baseSha,
        expectedNew: repo.snapshotSha,
        actual: repo.baseSha,
        remoteEffects: {
          base: {
            status: 'unknown',
            ref: 'refs/heads/main',
            before: repo.baseSha,
            sha: repo.snapshotSha,
          },
        },
      },
    });
    expect(formatRepoWorkflowError(caught)).toMatchObject({
      errorEffect: 'unknown',
      code: 'BASE_UPDATE_OUTCOME_UNKNOWN',
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
  });

  it.each([
    ['[rejected] (stale info)', false, 'BASE_LEASE_REJECTED', 'rejected'],
    ['[remote rejected] (pre-receive hook declined)', false, 'BASE_LEASE_REJECTED', 'rejected'],
    ['[remote failure] (remote failed to report status)', false, 'BASE_UPDATE_OUTCOME_UNKNOWN', 'unknown'],
    ['[rejected] (stale info)', true, 'BASE_UPDATE_OUTCOME_UNKNOWN', 'unknown'],
  ])('requires exact-ref porcelain rejection: %s, other ref=%s', async (summary, otherRef, code, status) => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo, {
      basePushResult: refspec => ({
        stdout: `!\t${otherRef ? refspec.replace('refs/heads/main', 'refs/heads/other') : refspec}\t${summary}`,
        stderr: 'push failed',
        exitCode: 1,
      }),
    });
    await expect(landRepoWorkflow({
      cwd: repo.checkout,
      pr: 1,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      tagPrefix: 'v1.0.',
    }, { run: github.run })).rejects.toMatchObject({
      code,
      details: { remoteEffects: { base: { status } } },
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
    expect(github.calls.filter(call => call.command === 'git' && call.args[0] === 'push')).toHaveLength(1);
  });

  it('reports an accepted base push followed by a transport error and concurrent advance as unknown', async () => {
    const repo = createPullRequestRepository();
    const advancedBaseSha = createBaseAdvanceCommit(repo);
    const github = createGithubRunner(repo, { basePushAcceptedThenError: advancedBaseSha });

    let caught;
    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        baseBranch: 'main',
        baseSha: repo.baseSha,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
        tagPrefix: 'v1.0.',
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'BASE_UPDATE_OUTCOME_UNKNOWN',
      details: {
        ref: 'refs/heads/main',
        expectedOld: repo.baseSha,
        expectedNew: repo.snapshotSha,
        actual: advancedBaseSha,
        remoteEffects: {
          base: {
            status: 'unknown',
            ref: 'refs/heads/main',
            before: repo.baseSha,
            sha: repo.snapshotSha,
          },
        },
      },
    });
    expect(formatRepoWorkflowError(caught)).toMatchObject({
      errorEffect: 'unknown',
      code: 'BASE_UPDATE_OUTCOME_UNKNOWN',
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(advancedBaseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
  });

  it('leaves the competing base intact and creates no tag when base advances during receive', async () => {
    const repo = createPullRequestRepository();
    const baseReceiveRace = installBaseReceiveAdvanceHook(repo);
    const github = createGithubRunner(repo, { baseReceiveRace });

    let caught;
    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        baseBranch: 'main',
        baseSha: repo.baseSha,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
        tagPrefix: 'v1.0.',
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'BASE_UPDATE_OUTCOME_UNKNOWN',
      details: {
        expectedOld: repo.baseSha,
        expectedNew: repo.snapshotSha,
        actual: baseReceiveRace.advancedBaseSha,
        remoteEffects: {
          base: {
            status: 'unknown',
            ref: 'refs/heads/main',
            before: repo.baseSha,
            sha: repo.snapshotSha,
          },
        },
      },
    });
    expect(formatRepoWorkflowError(caught)).toMatchObject({
      errorEffect: 'unknown',
      code: 'BASE_UPDATE_OUTCOME_UNKNOWN',
    });
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main'))
      .toBe(baseReceiveRace.advancedBaseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
    expect(github.calls.some(call => call.command === 'git'
      && call.args[0] === 'push'
      && call.args.some(arg => arg.includes('refs/tags/')))).toBe(false);
  });

  it('rejects a metacharacter tag prefix without executing it', async () => {
    const repo = createPullRequestRepository();
    const github = createGithubRunner(repo);
    const marker = join(repo.root, 'prefix-command-ran');
    const tagPrefix = `v1.0.;touch ${marker};#`;
    let caught;

    try {
      await landRepoWorkflow({
        cwd: repo.checkout,
        pr: 1,
        baseBranch: 'main',
        baseSha: repo.baseSha,
        reviewedHead: repo.headSha,
        reviewedSnapshot: repo.snapshotSha,
        tagPrefix,
      }, { run: github.run });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'INVALID_TAG_PREFIX',
      details: {},
    });
    expect(existsSync(marker)).toBe(false);
    expect(git(repo.root, '--git-dir', repo.remote, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha);
    expect(git(repo.root, '--git-dir', repo.remote, 'tag')).toBe('');
    expect(github.calls.some(call => call.command === 'gh' && call.args[0] === 'api')).toBe(false);
    expect(github.calls.some(call => call.command === 'git' && call.args[0] === 'push')).toBe(false);
  });

  it('fails closed when an already-merged retry requests an unfenced branch workflow', async () => {
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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: repo.headSha,
      reviewedSnapshot: repo.snapshotSha,
      workflow: 'Dev Release',
    }, { run: github.run })).rejects.toMatchObject({ code: 'WORKFLOW_NOT_TRIGGERED' });

    const workflowRunCalls = github.calls.filter(call => call.command === 'gh'
      && call.args.some(arg => /actions\/workflows\/\d+\/runs\?per_page=100$/.test(arg)));
    expect(workflowRunCalls).toHaveLength(0);
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
      baseBranch: 'main',
      baseSha: repo.baseSha,
      reviewedHead: '0'.repeat(40),
      reviewedSnapshot: repo.snapshotSha,
    }, { run: github.run })).rejects.toMatchObject({ code: 'REVIEW_STALE' });
  });
});

describe('CLI and tool surface', () => {
  it('keeps the bundled skill consistent with the standalone CLI landing boundary', () => {
    const skill = readFileSync(
      join(process.cwd(), 'agent', 'skills', 'review-merge-tag', 'SKILL.md'),
      'utf8',
    );

    expect(repoWorkflowHelp()).not.toContain('yeaft-repo land');
    expect(repoWorkflowHelp('land')).toContain('Landing is unavailable from the standalone CLI');
    expect(skill).toContain('CLI 不能执行 `land`');
    expect(skill).toContain('yeaft-repo prepare --name fix-short-description');
    expect(skill).toContain('yeaft-repo review-prep --pr 123');
    expect(skill).not.toContain('yeaft-repo land');
    expect(skill).not.toContain('--approved-by');
  });

  it('rejects removed cleanup, merge-method, and approval metadata CLI options', () => {
    expect(() => parseRepoWorkflowArgs(['land', '--cleanup-worktree', '/one']))
      .toThrow('Unknown option: --cleanup-worktree');
    expect(() => parseRepoWorkflowArgs(['land', '--merge-method', 'squash']))
      .toThrow('Unknown option: --merge-method');
    expect(() => parseRepoWorkflowArgs(['land', '--approved-by', 'martin']))
      .toThrow('Unknown option: --approved-by');
  });

  it('rejects direct landing with arbitrary approvedBy before invoking a command runner', async () => {
    let calls = 0;
    await expect(landRepoWorkflowCore({
      cwd: process.cwd(),
      pr: 42,
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
      reviewedHead: 'a'.repeat(40),
      reviewedSnapshot: 'b'.repeat(40),
      approvedBy: 'martin',
    }, {
      run: async () => {
        calls += 1;
        throw new Error('runner must not execute');
      },
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(calls).toBe(0);
  });

  it('does not expose a caller-accessible repository approval mint', async () => {
    const routerModule = await import('../../agent/yeaft/routing/router.js');
    let calls = 0;

    expect(routerModule.issueRepoApprovalCapability).toBeUndefined();
    await expect(landRepoWorkflowCore({
      cwd: process.cwd(),
      pr: 42,
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
      reviewedHead: 'a'.repeat(40),
      reviewedSnapshot: 'b'.repeat(40),
    }, {
      approvalCapability: Object.freeze(Object.create(null)),
      approvalContext: { sessionId: 'session-direct', recipientVpId: 'linus' },
      run: async () => {
        calls += 1;
        throw new Error('runner must not execute');
      },
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(calls).toBe(0);
  });

  it('keeps standalone CLI landing fail closed even with exact review evidence', async () => {
    const stdout = [];
    const stderr = [];
    let calls = 0;
    const exitCode = await runRepoWorkflowCli([
      'land', '--pr', '42', '--reviewed-head', 'a'.repeat(40), '--reviewed-snapshot', 'b'.repeat(40),
    ], {
      run: async () => {
        calls += 1;
        throw new Error('runner must not execute');
      },
      writeOut: text => stdout.push(text),
      writeErr: text => stderr.push(text),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0])).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(calls).toBe(0);
  });

  it('rejects arbitrary approvedBy at the real tool boundary without an inbound capability', async () => {
    const tool = allTools.find(item => item.name === 'RepoWorkflow');
    const result = JSON.parse(await tool.execute({
      phase: 'land',
      cwd: process.cwd(),
      pr: 42,
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
      reviewedHead: 'a'.repeat(40),
      reviewedSnapshot: 'b'.repeat(40),
      approvedBy: 'vp-martin',
    }, {
      senderVpId: 'vp-linus',
      inboundEnvelope: { sessionId: 'session-untrusted-tool-call' },
    }));

    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(tool.parameters.properties.approvedBy).toBeUndefined();
    expect(tool.parameters.properties.mergeMethod).toBeUndefined();
    expect(tool.parameters.properties.worktreePaths).toBeUndefined();
  });

  it('passes the exact current tool turn to repository approval consumption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-repo-tool-turn-'));
    tempRoots.push(root);
    const checkout = join(root, 'checkout');
    const bin = join(root, 'bin');
    const marker = join(root, 'gh-calls.log');
    execFileSync('git', ['init', checkout]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.example.test/acme/repo.git'], { cwd: checkout });
    execFileSync('mkdir', ['-p', bin]);
    const ghPath = join(bin, 'gh');
    writeFileSync(ghPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$YEAFT_GH_MARKER"\nexit 17\n');
    chmodSync(ghPath, 0o755);
    const previousPath = process.env.PATH;
    const previousMarker = process.env.YEAFT_GH_MARKER;
    process.env.PATH = `${bin}:${previousPath || ''}`;
    process.env.YEAFT_GH_MARKER = marker;
    const tool = allTools.find(item => item.name === 'RepoWorkflow');
    const input = {
      phase: 'land',
      cwd: checkout,
      pr: 42,
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
      reviewedHead: 'a'.repeat(40),
      reviewedSnapshot: 'b'.repeat(40),
    };

    try {
      const approved = issueTestApproval(input, 'github.example.test/acme/repo', {
        turnId: 'turn-approved-tool',
      });
      const approvedResult = JSON.parse(await tool.execute(input, {
        sessionId: approved.envelope.sessionId,
        senderVpId: 'linus',
        turnId: approved.turnId,
        inboundEnvelope: approved.envelope,
      }));
      expect(approvedResult.code).not.toBe('APPROVAL_REQUIRED');
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);

      const wrongTurn = issueTestApproval(input, 'github.example.test/acme/repo', {
        turnId: 'turn-approved-tool-2',
      });
      const wrongTurnResult = JSON.parse(await tool.execute(input, {
        sessionId: wrongTurn.envelope.sessionId,
        senderVpId: 'linus',
        turnId: 'turn-wrong-tool',
        inboundEnvelope: wrongTurn.envelope,
      }));
      expect(wrongTurnResult).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.YEAFT_GH_MARKER;
      else process.env.YEAFT_GH_MARKER = previousMarker;
    }
  });

  it('keeps untrusted workflow values out of run scripts and revalidates before each publisher', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/dev-release.yml'), 'utf8');
    const helper = readFileSync(join(process.cwd(), 'scripts/verify-dev-release.sh'), 'utf8');
    const lines = workflow.split('\n');
    const runScripts = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
      if (!match) continue;
      const indent = match[1].length;
      if (match[2] && match[2] !== '|') runScripts.push(match[2]);
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() && next.match(/^\s*/)[0].length <= indent) break;
        runScripts.push(next);
        index += 1;
      }
    }
    const scripts = runScripts.join('\n');

    expect(scripts).not.toContain('${{ github.');
    expect(scripts).not.toContain('${{ steps.');
    expect(scripts).not.toContain('${{ needs.');
    expect(workflow.match(/scripts\/verify-dev-release\.sh verify/g)).toHaveLength(4);
    expect(workflow.indexOf('Revalidate authoritative release refs')).toBeLessThan(workflow.indexOf('Publish to npm'));
    expect(workflow.indexOf('Revalidate authoritative release refs for Server image')).toBeLessThan(workflow.indexOf('Build and push Server image'));
    expect(workflow.indexOf('Revalidate authoritative release refs for Agent image')).toBeLessThan(workflow.indexOf('Build and push Agent image'));
    expect(helper).toContain("'^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
    for (const unsafe of ['v1.0.$(touch pwned)', 'v1.0.`touch pwned`', 'v1.0.1\\nrun: touch pwned']) {
      expect(unsafe).not.toMatch(/^v[0-9]+\.[0-9]+\.[0-9]+$/);
    }
  });

  it('accepts an annotated release tag peeled to the current origin/main commit', () => {
    const repo = createPullRequestRepository();
    const releaseCommit = git(repo.seed, 'rev-parse', 'main');
    git(repo.seed, 'push', 'origin', 'main');
    git(repo.seed, 'tag', '-a', 'v1.2.3', '-m', 'release', releaseCommit);
    git(repo.seed, 'push', 'origin', 'refs/tags/v1.2.3');
    git(repo.checkout, 'fetch', 'origin', releaseCommit);
    git(repo.checkout, 'checkout', '--detach', releaseCommit);

    expect(runReleaseFence(repo.checkout, 'v1.2.3', releaseCommit)).toContain('Release fence passed');
  });

  it('rejects publishing from a checkout other than the fenced release commit', () => {
    const repo = createPullRequestRepository();
    const releaseCommit = git(repo.seed, 'rev-parse', 'main');
    git(repo.seed, 'push', 'origin', 'main');
    git(repo.seed, 'tag', 'v1.2.3', releaseCommit);
    git(repo.seed, 'push', 'origin', 'refs/tags/v1.2.3');

    expect(() => runReleaseFence(repo.checkout, 'v1.2.3', releaseCommit)).toThrowError(
      expect.objectContaining({ stderr: expect.stringContaining('Current checkout HEAD points to') }),
    );
  });

  it('rejects a transient release tag deleted after validation', () => {
    const repo = createPullRequestRepository();
    const releaseCommit = git(repo.seed, 'rev-parse', 'main');
    git(repo.seed, 'push', 'origin', 'main');
    git(repo.seed, 'tag', 'v1.2.3', releaseCommit);
    git(repo.seed, 'push', 'origin', 'refs/tags/v1.2.3');
    git(repo.checkout, 'fetch', 'origin', releaseCommit);
    git(repo.checkout, 'checkout', '--detach', releaseCommit);

    expect(runReleaseFence(repo.checkout, 'v1.2.3', releaseCommit)).toContain('Release fence passed');
    git(repo.seed, 'push', 'origin', ':refs/tags/v1.2.3');

    expect(() => runReleaseFence(repo.checkout, 'v1.2.3', releaseCommit)).toThrowError(
      expect.objectContaining({ stderr: expect.stringContaining("Remote tag 'v1.2.3' does not exist on origin") }),
    );
  });

  it('rejects a historical main tag that is not current origin/main', () => {
    const repo = createPullRequestRepository();
    git(repo.seed, 'tag', 'v1.2.3', repo.baseSha);
    git(repo.seed, 'push', 'origin', 'refs/tags/v1.2.3');
    git(repo.seed, 'push', 'origin', 'main');

    expect(() => runReleaseFence(repo.checkout, 'v1.2.3', repo.baseSha)).toThrowError(
      expect.objectContaining({ stderr: expect.stringContaining('origin/main points to') }),
    );
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
