import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  consumeRepoApprovalCapability,
  isRepoApprovalCapability,
} from './yeaft/routing/router.js';

const execFile = promisify(execFileCallback);
const DEFAULT_REMOTE = 'origin';
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_ERROR_OUTPUT = 4_000;
const WORKTREE_OWNERSHIP_FILE = 'yeaft-repo-workflow-owner.json';
const WORKTREE_OWNERSHIP_VERSION = 1;

function redactUrlCredentials(value) {
  return String(value || '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1***@')
    .replace(/((?:[?&]|%3f|%26|%253f|%2526)(?:access(?:_|%5f|%255f)token|token)(?:=|%3d|%253d))(?:(?![&#\s]|%26|%2526).)*/giu, '$1***');
}

function redactStructured(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactUrlCredentials(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactStructured(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(?:access_?token|token)$/iu.test(key) ? '***' : redactStructured(item, seen),
  ]));
}

export class RepoWorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(redactUrlCredentials(message));
    this.name = 'RepoWorkflowError';
    this.code = code;
    this.details = redactStructured(details);
  }
}

function clip(value, max = MAX_ERROR_OUTPUT) {
  const text = redactUrlCredentials(value).trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function validateRemoteName(value) {
  const remote = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)
    || remote.includes('..')
    || remote.includes('//')
    || remote.endsWith('/')) {
    throw new RepoWorkflowError('INVALID_REMOTE', 'Git remote name contains unsupported characters');
  }
  return remote;
}

export function createRepoCommandRunner({ execFileImpl = execFile, signal } = {}) {
  return async function run(command, args, options = {}) {
    const { cwd, allowExitCodes = [], timeoutMs = 120_000 } = options;
    try {
      const result = await execFileImpl(command, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        signal: options.signal || signal,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0', GH_PAGER: 'cat' },
      });
      return {
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        exitCode: 0,
      };
    } catch (error) {
      if (signal?.aborted || options.signal?.aborted || error?.name === 'AbortError') {
        throw new RepoWorkflowError('ABORTED', 'Repository workflow aborted');
      }
      const exitCode = Number.isInteger(error?.code) ? error.code : null;
      if (exitCode !== null && allowExitCodes.includes(exitCode)) {
        return {
          stdout: String(error.stdout || '').trim(),
          stderr: String(error.stderr || '').trim(),
          exitCode,
        };
      }
      const safeArgs = args.map(arg => redactUrlCredentials(arg));
      throw new RepoWorkflowError('COMMAND_FAILED', redactUrlCredentials(`${command} ${args.join(' ')} failed`), {
        command,
        args: safeArgs,
        exitCode,
        stderr: clip(error?.stderr || error?.message),
      });
    }
  };
}

function parseJson(text, code, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new RepoWorkflowError(code, `${label} returned invalid JSON`, { output: clip(text) });
  }
}

async function runGit(run, cwd, args, options = {}) {
  return run('git', args, { cwd, ...options });
}

async function runGh(run, cwd, args, options = {}) {
  return run('gh', args, { cwd, ...options });
}

async function gitOutput(run, cwd, args) {
  return (await runGit(run, cwd, args)).stdout;
}

async function ghJson(run, cwd, args, code = 'GITHUB_QUERY_FAILED') {
  const result = await runGh(run, cwd, args);
  return parseJson(result.stdout, code, `gh ${args.join(' ')}`);
}

function sanitizeName(value, fallback) {
  const sanitized = String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!sanitized) {
    throw new RepoWorkflowError('INVALID_NAME', 'Worktree name is empty after sanitization');
  }
  return sanitized;
}

function assertPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RepoWorkflowError('INVALID_INPUT', `${label} must be a positive integer`);
  }
  return number;
}

function githubRepositoryParts(host, path) {
  const segments = String(path || '').replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length !== 2) return null;
  const [owner, rawName] = segments;
  const name = rawName.replace(/\.git$/i, '');
  const safePart = value => /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
  if (!safePart(host) || !safePart(owner) || !safePart(name)) return null;
  const normalizedHost = host.toLowerCase();
  const nameWithOwner = `${owner}/${name}`;
  return {
    host: normalizedHost,
    nameWithOwner,
    selector: normalizedHost === 'github.com' ? nameWithOwner : `${normalizedHost}/${nameWithOwner}`,
  };
}

export function parseGithubRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  let parsed = null;
  try {
    const url = new URL(value);
    if (['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol)) {
      parsed = githubRepositoryParts(url.hostname, url.pathname);
    }
  } catch {
    const scpLike = value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if (scpLike) parsed = githubRepositoryParts(scpLike[1], scpLike[2]);
  }
  if (!parsed) {
    throw new RepoWorkflowError('GITHUB_REMOTE_UNSUPPORTED', 'Selected remote is not a supported GitHub repository URL');
  }
  return parsed;
}

async function resolveRepository(run, cwd, options = {}) {
  const repoRoot = await gitOutput(run, cwd, ['rev-parse', '--show-toplevel']);
  const commonDir = await gitOutput(run, repoRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  // Older Git releases may accept --path-format but still return a relative
  // common dir. Resolve it against the checkout instead of process.cwd().
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir);
  const workspaceRoot = dirname(absoluteCommonDir);
  const remote = validateRemoteName(options.remote || DEFAULT_REMOTE);
  const remotes = (await gitOutput(run, repoRoot, ['remote'])).split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new RepoWorkflowError('REMOTE_NOT_FOUND', `Git remote "${remote}" does not exist`, { remotes });
  }
  const remoteUrl = await gitOutput(run, repoRoot, ['remote', 'get-url', remote]);
  return {
    repoRoot,
    workspaceRoot,
    commonDir: absoluteCommonDir,
    remote,
    remoteUrl,
  };
}

async function resolveDefaultBranch(run, repository, explicitBase) {
  if (explicitBase) return explicitBase;
  const symbolic = await runGit(run, repository.repoRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    `refs/remotes/${repository.remote}/HEAD`,
  ], { allowExitCodes: [1] });
  if (symbolic.exitCode === 0 && symbolic.stdout.startsWith(`${repository.remote}/`)) {
    return symbolic.stdout.slice(repository.remote.length + 1);
  }
  const github = githubRepository(repository);
  const info = await ghJson(run, repository.repoRoot, [
    'repo',
    'view',
    github.selector,
    '--json',
    'defaultBranchRef',
  ]);
  const branch = info?.defaultBranchRef?.name;
  if (!branch) {
    throw new RepoWorkflowError('DEFAULT_BRANCH_UNKNOWN', 'Could not determine the repository default branch');
  }
  return branch;
}

async function validateBranchRef(run, cwd, branch) {
  const result = await runGit(run, cwd, ['check-ref-format', `refs/heads/${branch}`], { allowExitCodes: [1] });
  if (result.exitCode !== 0) {
    throw new RepoWorkflowError('INVALID_BRANCH', `Invalid branch name: ${branch}`);
  }
}

async function fetchBase(run, repository, baseBranch) {
  await validateBranchRef(run, repository.repoRoot, baseBranch);
  await runGit(run, repository.repoRoot, [
    'fetch',
    '--no-tags',
    '--prune',
    repository.remote,
    `+refs/heads/${baseBranch}:refs/remotes/${repository.remote}/${baseBranch}`,
  ]);
  return gitOutput(run, repository.repoRoot, ['rev-parse', `refs/remotes/${repository.remote}/${baseBranch}`]);
}

export function parseWorktreeList(output) {
  const records = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null, detached: false };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  if (current) records.push(current);
  return records;
}

async function listWorktrees(run, repository) {
  return parseWorktreeList(await gitOutput(run, repository.repoRoot, ['worktree', 'list', '--porcelain']));
}

function resolveWorktreePath(repository, requestedPath, defaultName) {
  if (!requestedPath) {
    return join(dirname(repository.workspaceRoot), '.yeaft', 'worktrees', basename(repository.workspaceRoot), defaultName);
  }
  return isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(repository.workspaceRoot, requestedPath);
}

function compactRepository(repository) {
  return {
    root: repository.repoRoot,
    workspaceRoot: repository.workspaceRoot,
    remote: repository.remote,
  };
}

function githubRepository(repository) {
  return parseGithubRemoteUrl(repository.remoteUrl);
}

async function assertPushTarget(run, repository) {
  const github = githubRepository(repository);
  const pushUrls = (await gitOutput(run, repository.repoRoot, [
    'remote', 'get-url', '--push', '--all', repository.remote,
  ])).split(/\r?\n/).filter(Boolean);
  if (pushUrls.length === 0) {
    throw new RepoWorkflowError('GITHUB_PUSH_URL_UNKNOWN', `Git remote "${repository.remote}" has no push URL`);
  }
  const targets = pushUrls.map(pushUrl => {
    try {
      return parseGithubRemoteUrl(pushUrl);
    } catch {
      return null;
    }
  });
  const valid = targets.every(target => target
    && target.host === github.host
    && target.nameWithOwner.toLowerCase() === github.nameWithOwner.toLowerCase());
  if (!valid) {
    throw new RepoWorkflowError('GITHUB_PUSH_URL_MISMATCH', 'Selected remote fetch and push URLs do not identify the same GitHub repository', {
      remote: repository.remote,
      expected: github.selector,
      pushTargets: targets.map(target => target?.selector || 'unsupported'),
    });
  }
  return pushUrls[0];
}

function worktreeOwnershipKey(path) {
  return createHash('sha256').update(resolve(path)).digest('hex');
}

async function worktreeOwnershipPaths(run, repository, path) {
  const key = worktreeOwnershipKey(path);
  const rawGitDir = await gitOutput(run, path, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(path, rawGitDir);
  return {
    worktree: join(gitDir, WORKTREE_OWNERSHIP_FILE),
    repository: join(repository.commonDir, 'yeaft-repo-workflow', `${key}.json`),
  };
}

function createWorktreeOwnership(path, kind, createdHead, branch = null) {
  return {
    version: WORKTREE_OWNERSHIP_VERSION,
    nonce: randomBytes(32).toString('hex'),
    path: resolve(path),
    kind,
    createdHead,
    branch,
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function persistWorktreeOwnership(run, repository, ownership) {
  const paths = await worktreeOwnershipPaths(run, repository, ownership.path);
  try {
    await writeJsonAtomic(paths.repository, ownership);
    await writeJsonAtomic(paths.worktree, ownership);
  } catch (error) {
    await Promise.allSettled([unlink(paths.repository), unlink(paths.worktree)]);
    throw new RepoWorkflowError('WORKTREE_OWNERSHIP_WRITE_FAILED', 'Could not persist worktree ownership metadata', {
      path: ownership.path,
      error: error?.message || String(error),
    });
  }
  return ownership;
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

async function verifyWorktreeOwnership(run, repository, path, expected = {}) {
  let paths;
  try {
    paths = await worktreeOwnershipPaths(run, repository, path);
  } catch {
    return null;
  }
  const [worktree, repositoryCopy] = await Promise.all([
    readJsonFile(paths.worktree),
    readJsonFile(paths.repository),
  ]);
  const valid = worktree?.version === WORKTREE_OWNERSHIP_VERSION
    && repositoryCopy?.version === WORKTREE_OWNERSHIP_VERSION
    && sameSecret(worktree.nonce, repositoryCopy.nonce)
    && worktree.path === resolve(path)
    && repositoryCopy.path === resolve(path)
    && worktree.kind === repositoryCopy.kind
    && worktree.createdHead === repositoryCopy.createdHead
    && worktree.branch === repositoryCopy.branch
    && (!expected.kind || worktree.kind === expected.kind)
    && (!expected.createdHead || worktree.createdHead === expected.createdHead)
    && (expected.branch === undefined || worktree.branch === expected.branch);
  return valid ? { ownership: worktree, paths } : null;
}

async function worktreeStatus(run, path) {
  return gitOutput(run, path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);
}

export async function prepareRepoWorkflow(options = {}, dependencies = {}) {
  const run = dependencies.run || createRepoCommandRunner({ signal: dependencies.signal });
  const repository = await resolveRepository(run, options.cwd || process.cwd(), options);
  const baseBranch = await resolveDefaultBranch(run, repository, options.baseBranch);
  const baseSha = await fetchBase(run, repository, baseBranch);
  const name = sanitizeName(options.name, `work-${baseSha.slice(0, 8)}`);
  const branch = `yeaft-wt/${name}`;
  const worktreePath = resolveWorktreePath(repository, options.worktreePath, name);
  const worktrees = await listWorktrees(run, repository);
  const existing = worktrees.find(item => resolve(item.path) === worktreePath);

  if (existing) {
    const ownership = await verifyWorktreeOwnership(run, repository, worktreePath, {
      kind: 'development',
      createdHead: baseSha,
      branch,
    });
    if (existing.branch !== branch || existing.head !== baseSha || !ownership) {
      throw new RepoWorkflowError('WORKTREE_CONFLICT', 'Existing worktree is not an owned checkout of the requested branch and latest base', {
        requested: { worktreePath, branch, baseSha },
        existing,
        ownershipVerified: Boolean(ownership),
      });
    }
    return {
      ok: true,
      phase: 'prepare',
      reused: true,
      repository: compactRepository(repository),
      base: { branch: baseBranch, sha: baseSha },
      worktree: { path: worktreePath, branch, head: existing.head },
    };
  }

  if (existsSync(worktreePath)) {
    throw new RepoWorkflowError('PATH_EXISTS', `Worktree path already exists: ${worktreePath}`);
  }
  const branchExists = await runGit(run, repository.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowExitCodes: [1],
  });
  if (branchExists.exitCode === 0) {
    throw new RepoWorkflowError('BRANCH_EXISTS', `Local branch already exists: ${branch}`, { branch });
  }

  await runGit(run, repository.repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
  try {
    const persistOwnership = dependencies.persistWorktreeOwnership || persistWorktreeOwnership;
    await persistOwnership(
      run,
      repository,
      createWorktreeOwnership(worktreePath, 'development', baseSha, branch),
    );
  } catch (error) {
    await runGit(run, repository.repoRoot, ['worktree', 'remove', worktreePath]);
    const branchRef = `refs/heads/${branch}`;
    if (dependencies.beforePrepareBranchRollback) {
      await dependencies.beforePrepareBranchRollback({ ref: branchRef, expectedHead: baseSha });
    }
    await runGit(run, repository.repoRoot, [
      'update-ref',
      '--no-deref',
      '-d',
      branchRef,
      baseSha,
    ], { allowExitCodes: [1, 128] });
    throw error;
  }
  return {
    ok: true,
    phase: 'prepare',
    reused: false,
    repository: compactRepository(repository),
    base: { branch: baseBranch, sha: baseSha },
    worktree: { path: worktreePath, branch, head: baseSha },
  };
}

const FAILED_CHECK_STATES = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'ERROR',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);
const PASSED_CHECK_STATES = new Set(['NEUTRAL', 'SKIPPED', 'SUCCESS']);

function checkName(check, index) {
  return check?.name || check?.context || check?.workflowName || `check-${index + 1}`;
}

export function summarizeChecks(checks = []) {
  const summary = { total: checks.length, passed: [], pending: [], failed: [] };
  checks.forEach((check, index) => {
    const rawState = check?.conclusion || check?.state || check?.status || 'UNKNOWN';
    const state = String(rawState).toUpperCase();
    const record = { name: checkName(check, index), state };
    if (FAILED_CHECK_STATES.has(state)) summary.failed.push(record);
    else if (PASSED_CHECK_STATES.has(state)) summary.passed.push(record);
    else summary.pending.push(record);
  });
  return summary;
}

async function loadPullRequest(run, repository, pr) {
  const github = githubRepository(repository);
  return ghJson(run, repository.repoRoot, [
    'pr',
    'view',
    String(pr),
    '--repo',
    github.selector,
    '--json',
    [
      'number',
      'url',
      'state',
      'isDraft',
      'baseRefName',
      'headRefName',
      'headRefOid',
      'mergeable',
      'mergeStateStatus',
      'statusCheckRollup',
      'reviewDecision',
      'mergedAt',
      'mergeCommit',
    ].join(','),
  ]);
}

function validateOpenPullRequest(info, { requireChecksComplete = false } = {}) {
  if (info.state !== 'OPEN') {
    throw new RepoWorkflowError('PR_NOT_OPEN', `PR #${info.number} is ${String(info.state).toLowerCase()}`, {
      state: info.state,
      mergeCommit: info.mergeCommit?.oid || null,
    });
  }
  if (info.isDraft) throw new RepoWorkflowError('PR_IS_DRAFT', `PR #${info.number} is a draft`);
  if (info.mergeable === 'CONFLICTING' || info.mergeStateStatus === 'DIRTY') {
    throw new RepoWorkflowError('PR_CONFLICTING', `PR #${info.number} has merge conflicts`, {
      mergeable: info.mergeable,
      mergeStateStatus: info.mergeStateStatus,
    });
  }
  const checks = summarizeChecks(info.statusCheckRollup || []);
  if (checks.failed.length > 0) {
    throw new RepoWorkflowError('CHECKS_FAILED', `PR #${info.number} has failing checks`, { checks });
  }
  if (requireChecksComplete && checks.pending.length > 0) {
    throw new RepoWorkflowError('CHECKS_PENDING', `PR #${info.number} still has pending checks`, { checks });
  }
  return checks;
}

async function fetchPullRequestSnapshot(run, repository, info) {
  const namespace = `refs/yeaft/pull/${info.number}`;
  await runGit(run, repository.repoRoot, [
    'fetch',
    '--no-tags',
    repository.remote,
    `+refs/heads/${info.baseRefName}:refs/remotes/${repository.remote}/${info.baseRefName}`,
    `+refs/pull/${info.number}/head:${namespace}/head`,
    `+refs/pull/${info.number}/merge:${namespace}/merge`,
  ]);
  const baseSha = await gitOutput(run, repository.repoRoot, ['rev-parse', `refs/remotes/${repository.remote}/${info.baseRefName}`]);
  const headSha = await gitOutput(run, repository.repoRoot, ['rev-parse', `${namespace}/head`]);
  const snapshotSha = await gitOutput(run, repository.repoRoot, ['rev-parse', `${namespace}/merge`]);
  if (headSha !== info.headRefOid) {
    throw new RepoWorkflowError('PR_HEAD_INCONSISTENT', 'GitHub PR metadata and fetched head ref disagree', {
      metadataHead: info.headRefOid,
      fetchedHead: headSha,
    });
  }
  const parentLine = await gitOutput(run, repository.repoRoot, ['rev-list', '--parents', '-n', '1', snapshotSha]);
  const [, ...parents] = parentLine.split(/\s+/);
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
    throw new RepoWorkflowError('SNAPSHOT_INCONSISTENT', 'GitHub merge snapshot does not have the frozen base/head parents', {
      baseSha,
      headSha,
      snapshotSha,
      parents,
    });
  }
  return { baseSha, headSha, snapshotSha, parents };
}

export async function prepareRepoReview(options = {}, dependencies = {}) {
  const run = dependencies.run || createRepoCommandRunner({ signal: dependencies.signal });
  const pr = assertPositiveInteger(options.pr, 'pr');
  const repository = await resolveRepository(run, options.cwd || process.cwd(), options);
  const info = await loadPullRequest(run, repository, pr);
  const checks = validateOpenPullRequest(info);
  const frozen = await fetchPullRequestSnapshot(run, repository, info);
  const name = sanitizeName(options.name, `review-pr-${pr}-${frozen.headSha.slice(0, 8)}`);
  const worktreePath = resolveWorktreePath(repository, options.worktreePath, name);
  const worktrees = await listWorktrees(run, repository);
  const existing = worktrees.find(item => resolve(item.path) === worktreePath);

  if (existing) {
    const [status, ownership] = await Promise.all([
      worktreeStatus(run, worktreePath),
      verifyWorktreeOwnership(run, repository, worktreePath, {
        kind: 'review',
        createdHead: frozen.snapshotSha,
        branch: null,
      }),
    ]);
    if (!existing.detached || existing.head !== frozen.snapshotSha || status || !ownership) {
      throw new RepoWorkflowError('REVIEW_WORKTREE_CONFLICT', 'Existing review worktree is not an owned clean checkout of the frozen merge snapshot', {
        existing,
        dirty: Boolean(status),
        ownershipVerified: Boolean(ownership),
      });
    }
  } else {
    if (existsSync(worktreePath)) {
      throw new RepoWorkflowError('PATH_EXISTS', `Review worktree path already exists: ${worktreePath}`);
    }
    await runGit(run, repository.repoRoot, ['worktree', 'add', '--detach', worktreePath, frozen.snapshotSha]);
    try {
      await persistWorktreeOwnership(
        run,
        repository,
        createWorktreeOwnership(worktreePath, 'review', frozen.snapshotSha),
      );
    } catch (error) {
      await runGit(run, repository.repoRoot, ['worktree', 'remove', worktreePath]);
      throw error;
    }
  }

  return {
    ok: true,
    phase: 'review-prep',
    reused: Boolean(existing),
    repository: compactRepository(repository),
    pullRequest: {
      number: info.number,
      url: info.url,
      baseBranch: info.baseRefName,
      headBranch: info.headRefName,
      baseSha: frozen.baseSha,
      headSha: frozen.headSha,
      snapshotSha: frozen.snapshotSha,
      checks,
    },
    reviewWorktree: { path: worktreePath, head: frozen.snapshotSha, detached: true },
    landInput: {
      pr: info.number,
      baseBranch: info.baseRefName,
      baseSha: frozen.baseSha,
      reviewedHead: frozen.headSha,
      reviewedSnapshot: frozen.snapshotSha,
    },
  };
}

function validateTagPrefix(prefix) {
  if (typeof prefix !== 'string' || !/^v\d+\.\d+\.$/.test(prefix)) {
    throw new RepoWorkflowError('INVALID_TAG_PREFIX', 'tagPrefix must match v<digits>.<digits>.');
  }
  return prefix;
}

export function nextNumericTag(tagNames, prefix, start = 0) {
  validateTagPrefix(prefix);
  const suffixes = tagNames
    .filter(name => name.startsWith(prefix))
    .map(name => name.slice(prefix.length))
    .filter(suffix => /^\d+$/.test(suffix))
    .map(Number)
    .filter(Number.isSafeInteger);
  const next = suffixes.length === 0 ? Number(start) : Math.max(...suffixes) + 1;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RepoWorkflowError('INVALID_TAG_SEQUENCE', `Could not calculate the next tag for prefix ${prefix}`);
  }
  return `${prefix}${next}`;
}

function parseRemoteTags(output) {
  const refs = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/i);
    if (!match) continue;
    const [, sha, name, peeled] = match;
    const current = refs.get(name) || { name, directSha: null, commitSha: null };
    if (peeled) current.commitSha = sha;
    else current.directSha = sha;
    refs.set(name, current);
  }
  return [...refs.values()].map(ref => ({
    name: ref.name,
    directSha: ref.directSha,
    commitSha: ref.commitSha || ref.directSha,
  }));
}

function numericTagSuffix(name, prefix) {
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const number = Number(suffix);
  return Number.isSafeInteger(number) ? number : null;
}

async function resolveRemoteTag(run, repository, tag) {
  const result = await runGit(run, repository.repoRoot, [
    'ls-remote',
    '--tags',
    repository.remote,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  return parseRemoteTags(result.stdout).find(ref => ref.name === tag) || null;
}

async function resolveRemoteRefSha(run, repository, ref, remote = repository.remote) {
  const output = await gitOutput(run, repository.repoRoot, ['ls-remote', remote, ref]);
  const line = output.split(/\r?\n/).find(candidate => candidate.endsWith(`\t${ref}`));
  return line?.split(/\s+/)[0] || null;
}

async function rollbackRemoteTag(run, repository, pushUrl, tag, directSha, targetSha, onStage) {
  const ref = `refs/tags/${tag}`;
  onStage({ stage: 'rollback-started', status: 'unknown', name: tag, sha: targetSha });
  let rollbackError = null;
  try {
    await runGit(run, repository.repoRoot, [
      'push',
      '--porcelain',
      `--force-with-lease=${ref}:${directSha}`,
      pushUrl,
      `:${ref}`,
    ]);
  } catch (error) {
    rollbackError = error;
  }
  let remaining;
  try {
    remaining = await resolveRemoteTag(run, repository, tag);
  } catch (verifyError) {
    onStage({ stage: 'rollback-verify-failed', status: 'unknown', name: tag, sha: targetSha });
    throw new RepoWorkflowError('TAG_ROLLBACK_VERIFY_FAILED', `Remote tag ${tag} rollback could not be verified after the base advanced`, {
      tag,
      expected: null,
      actual: 'unknown',
      rollbackError: rollbackError ? formatRepoWorkflowError(rollbackError) : null,
      verifyError: formatRepoWorkflowError(verifyError),
      transientTagMayHaveTriggeredAutomation: true,
    });
  }
  if (remaining !== null) {
    onStage({ stage: 'rollback-failed', status: 'unknown', name: tag, sha: targetSha });
    throw new RepoWorkflowError('TAG_ROLLBACK_FAILED', `Remote tag ${tag} could not be rolled back after the base advanced`, {
      tag,
      expected: null,
      actual: remaining,
      rollbackError: rollbackError ? formatRepoWorkflowError(rollbackError) : null,
      transientTagMayHaveTriggeredAutomation: true,
    });
  }
  onStage({
    stage: 'rolled-back',
    status: 'unknown',
    name: tag,
    sha: targetSha,
    transientTagMayHaveTriggeredAutomation: true,
  });
}

async function assertTagBaseGuard(run, repository, baseGuard, tag) {
  if (!baseGuard) return;
  const currentBase = await resolveRemoteRefSha(run, repository, baseGuard.ref);
  if (currentBase !== baseGuard.sha) {
    throw new RepoWorkflowError('BASE_ADVANCED_DURING_TAG_PUSH', `Remote base advanced while tag ${tag} was being reused`, {
      tag,
      expected: baseGuard.sha,
      actual: currentBase,
      tagRolledBack: false,
      transientTagMayHaveTriggeredAutomation: false,
    });
  }
}

async function createAndPushNextTag(run, repository, pushUrl, targetSha, prefix, start = 0, callbacks = {}) {
  const onStage = callbacks.onStage || (() => {});
  const beforePush = callbacks.beforePush || (async () => {});
  const baseGuard = callbacks.baseGuard || null;
  onStage({ stage: 'validate', status: 'not-attempted', prefix, sha: targetSha });
  validateTagPrefix(prefix);
  const initialTag = nextNumericTag([], prefix, start);
  const refCheck = await runGit(run, repository.repoRoot, ['check-ref-format', `refs/tags/${initialTag}`], {
    allowExitCodes: [1],
  });
  if (refCheck.exitCode !== 0) {
    throw new RepoWorkflowError('INVALID_TAG_PREFIX', `tagPrefix does not form a valid Git tag: ${prefix}`);
  }
  onStage({ stage: 'scan-remote', status: 'not-attempted', prefix, sha: targetSha });
  const remoteTags = await runGit(run, repository.repoRoot, [
    'ls-remote',
    '--tags',
    repository.remote,
    `refs/tags/${prefix}*`,
  ]);
  const matchingTags = parseRemoteTags(remoteTags.stdout)
    .map(ref => ({ ...ref, suffix: numericTagSuffix(ref.name, prefix) }))
    .filter(ref => ref.suffix !== null)
    .sort((a, b) => b.suffix - a.suffix);
  const existingTarget = matchingTags.find(ref => ref.commitSha === targetSha);
  if (existingTarget) {
    await assertTagBaseGuard(run, repository, baseGuard, existingTarget.name);
    onStage({ stage: 'verified-preexisting', status: 'preexisting', name: existingTarget.name, sha: targetSha });
    return { name: existingTarget.name, sha: targetSha, reused: true };
  }

  const tag = nextNumericTag(matchingTags.map(ref => ref.name), prefix, start);
  const tagRef = `refs/tags/${tag}`;
  onStage({ stage: 'selected', status: 'not-attempted', name: tag, sha: targetSha });
  const remoteExisting = await resolveRemoteTag(run, repository, tag);
  if (remoteExisting) {
    if (remoteExisting.commitSha !== targetSha) {
      throw new RepoWorkflowError('TAG_CONFLICT', `Remote tag ${tag} already points to another commit`, {
        tag,
        expected: targetSha,
        actual: remoteExisting,
      });
    }
    await assertTagBaseGuard(run, repository, baseGuard, tag);
    onStage({ stage: 'verified-preexisting', status: 'preexisting', name: tag, sha: targetSha });
    return { name: tag, sha: targetSha, reused: true };
  }

  await beforePush();
  onStage({ stage: 'push-started', status: 'unknown', name: tag, sha: targetSha });
  let reused = false;
  try {
    // Push the commit object directly. This deliberately leaves the local tag
    // namespace untouched and makes the empty-ref lease the creation fence.
    const pushed = await runGit(run, repository.repoRoot, [
      'push',
      '--porcelain',
      `--force-with-lease=${tagRef}:`,
      pushUrl,
      `${targetSha}:${tagRef}`,
    ]);
    const porcelain = `${pushed.stdout}\n${pushed.stderr}`;
    reused = porcelain.split(/\r?\n/).some(line => line.startsWith('=') && line.includes(tagRef));
    onStage({ stage: 'push-returned', status: 'unknown', name: tag, sha: targetSha });
  } catch (pushError) {
    let observedTag;
    let currentBase;
    try {
      [observedTag, currentBase] = await Promise.all([
        resolveRemoteTag(run, repository, tag),
        baseGuard ? resolveRemoteRefSha(run, repository, baseGuard.ref) : Promise.resolve(null),
      ]);
    } catch (verifyError) {
      const effect = {
        stage: 'push-outcome-unknown',
        status: 'unknown',
        name: tag,
        sha: targetSha,
        transientTagMayHaveTriggeredAutomation: true,
      };
      onStage(effect);
      throw new RepoWorkflowError('TAG_PUSH_OUTCOME_UNKNOWN', `Remote tag ${tag} state is unknown after push failed`, {
        tag,
        directSha: 'unknown',
        commitSha: 'unknown',
        currentBase: 'unknown',
        pushError: formatRepoWorkflowError(pushError),
        verifyError: formatRepoWorkflowError(verifyError),
        transientTagMayHaveTriggeredAutomation: true,
      });
    }
    const effect = {
      stage: 'push-outcome-unknown',
      status: 'unknown',
      name: tag,
      sha: targetSha,
      transientTagMayHaveTriggeredAutomation: true,
    };
    onStage(effect);
    throw new RepoWorkflowError('TAG_PUSH_OUTCOME_UNKNOWN', `Remote tag ${tag} outcome is unknown after push failed`, {
      tag,
      directSha: observedTag?.directSha || null,
      commitSha: observedTag?.commitSha || null,
      currentBase,
      pushError: formatRepoWorkflowError(pushError),
      transientTagMayHaveTriggeredAutomation: true,
    });
  }

  const remoteTag = await resolveRemoteTag(run, repository, tag);
  const currentBase = baseGuard
    ? await resolveRemoteRefSha(run, repository, baseGuard.ref)
    : null;
  if (remoteTag?.commitSha !== targetSha || (!reused && remoteTag.directSha !== targetSha)) {
    throw new RepoWorkflowError('TAG_VERIFY_FAILED', `Remote tag ${tag} could not be verified`, {
      tag,
      expected: { directSha: reused ? 'preexisting' : targetSha, commitSha: targetSha },
      actual: remoteTag,
    });
  }
  if (baseGuard && currentBase !== baseGuard.sha) {
    if (!reused) await rollbackRemoteTag(run, repository, pushUrl, tag, remoteTag.directSha, targetSha, onStage);
    throw new RepoWorkflowError('BASE_ADVANCED_DURING_TAG_PUSH', `Remote base advanced while tag ${tag} was being created`, {
      tag,
      expected: baseGuard.sha,
      actual: currentBase,
      tagRolledBack: !reused,
      transientTagMayHaveTriggeredAutomation: !reused,
    });
  }
  const effect = { stage: reused ? 'verified-preexisting' : 'verified-created', status: reused ? 'preexisting' : 'created', name: tag, sha: targetSha };
  onStage(effect);
  return { name: tag, sha: targetSha, reused };
}

function abortedError() {
  return new RepoWorkflowError('ABORTED', 'Repository workflow aborted');
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function captureWorkflowIdentity(run, repository, workflow) {
  const github = githubRepository(repository);
  const response = await ghJson(run, repository.repoRoot, [
    'api',
    '--hostname',
    github.host,
    '--paginate',
    '--slurp',
    `repos/${github.nameWithOwner}/actions/workflows?per_page=100`,
  ]);
  const pages = Array.isArray(response) ? response : [response];
  const workflows = pages.flatMap(page => Array.isArray(page?.workflows) ? page.workflows : []);
  const selector = String(workflow || '').trim();
  const matches = workflows.filter(item => {
    const id = Number(item?.id);
    const path = String(item?.path || '');
    return (Number.isSafeInteger(id) && String(id) === selector)
      || path === selector
      || basename(path) === selector
      || String(item?.name || '') === selector;
  });
  if (matches.length > 1) {
    throw new RepoWorkflowError('WORKFLOW_AMBIGUOUS', `Workflow "${selector}" matches multiple GitHub workflows`, {
      matches: matches.map(item => ({ id: item.id, name: item.name, path: item.path })),
    });
  }
  const info = matches[0];
  const workflowId = Number(info?.id);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
    throw new RepoWorkflowError('WORKFLOW_ID_UNKNOWN', `Workflow "${selector}" has no immutable GitHub workflow ID`);
  }
  return { id: workflowId, name: String(info.name || selector), path: String(info.path || '') };
}

async function listWorkflowRuns(run, repository, workflowIdentity) {
  const github = githubRepository(repository);
  const response = await ghJson(run, repository.repoRoot, [
    'api',
    '--hostname',
    github.host,
    `repos/${github.nameWithOwner}/actions/workflows/${workflowIdentity.id}/runs?per_page=100`,
  ]);
  return Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
}

async function captureWorkflowBaseline(run, repository, workflowIdentity) {
  const runs = await listWorkflowRuns(run, repository, workflowIdentity);
  const baselineRunId = runs.reduce((maximum, item) => {
    const id = Number(item?.databaseId ?? item?.id);
    return Number.isSafeInteger(id) ? Math.max(maximum, id) : maximum;
  }, 0);
  return { ...workflowIdentity, baselineRunId };
}

function workflowRunTimestamp(runInfo) {
  const value = Date.parse(runInfo?.createdAt
    || runInfo?.startedAt
    || runInfo?.created_at
    || runInfo?.run_started_at
    || '');
  return Number.isFinite(value) ? value : null;
}

function matchesWorkflowRun(runInfo, options, { requireWorkflowId = false } = {}) {
  const id = Number(runInfo?.databaseId ?? runInfo?.id);
  const workflowId = Number(runInfo?.workflowDatabaseId ?? runInfo?.workflow_id);
  const timestamp = workflowRunTimestamp(runInfo);
  return Number.isSafeInteger(id)
    && id > options.workflowFence.baselineRunId
    && (!requireWorkflowId || workflowId === options.workflowFence.id)
    && runInfo.event === 'push'
    && (runInfo.headSha ?? runInfo.head_sha) === options.targetSha
    && (runInfo.headBranch ?? runInfo.head_branch) === options.ref
    && timestamp !== null
    && timestamp >= Math.floor(options.notBeforeMs / 1000) * 1000;
}

async function loadWorkflowRunDetail(run, repository, runId) {
  const github = githubRepository(repository);
  return ghJson(run, repository.repoRoot, [
    'api',
    '--hostname',
    github.host,
    `repos/${github.nameWithOwner}/actions/runs/${runId}`,
  ]);
}

async function waitForWorkflow(run, repository, options, dependencies = {}) {
  const sleepImpl = dependencies.sleep || sleep;
  const signal = dependencies.signal;
  const now = dependencies.now || (() => Date.now());
  const github = githubRepository(repository);
  const timeoutMs = Number(options.waitTimeoutMs || DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  const waitStartedAt = now();
  let runInfo = null;

  while (now() - waitStartedAt <= timeoutMs) {
    const runs = await listWorkflowRuns(run, repository, options.workflowFence);
    runInfo = runs
      .filter(item => matchesWorkflowRun(item, options, { requireWorkflowId: true }))
      .sort((a, b) => Number(b.id ?? b.databaseId) - Number(a.id ?? a.databaseId))[0] || null;
    if (runInfo) break;
    await sleepImpl(pollIntervalMs, signal);
  }

  if (!runInfo) {
    throw new RepoWorkflowError('WORKFLOW_NOT_FOUND', `Workflow "${options.workflowFence.name}" did not produce a new matching push run before timeout`, {
      effect: 'merge-and-tag-completed',
      workflow: options.workflowFence,
      targetSha: options.targetSha,
      ref: options.ref,
      notBefore: new Date(options.notBeforeMs).toISOString(),
    });
  }

  const selectedRunId = Number(runInfo.id ?? runInfo.databaseId);
  while (now() - waitStartedAt <= timeoutMs) {
    const detail = await loadWorkflowRunDetail(run, repository, selectedRunId);
    const detailRunId = Number(detail.id ?? detail.databaseId);
    if (!matchesWorkflowRun(detail, options, { requireWorkflowId: true })
      || detailRunId !== selectedRunId) {
      throw new RepoWorkflowError('WORKFLOW_IDENTITY_MISMATCH', 'GitHub workflow run details do not match the fenced push run', {
        expected: {
          runId: selectedRunId,
          workflowId: options.workflowFence.id,
          targetSha: options.targetSha,
          ref: options.ref,
          event: 'push',
        },
        actual: {
          runId: detailRunId || null,
          workflowId: Number(detail.workflow_id ?? detail.workflowDatabaseId) || null,
          targetSha: detail.head_sha ?? detail.headSha ?? null,
          ref: detail.head_branch ?? detail.headBranch ?? null,
          event: detail.event || null,
        },
      });
    }
    if (detail.status === 'completed') {
      const jobsResponse = await ghJson(run, repository.repoRoot, [
        'run',
        'view',
        String(selectedRunId),
        '--repo',
        github.selector,
        '--json',
        'jobs',
      ]);
      const jobs = (jobsResponse.jobs || []).map(job => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion || null,
      }));
      if (detail.conclusion !== 'success') {
        throw new RepoWorkflowError('WORKFLOW_FAILED', `Workflow "${options.workflowFence.name}" completed with ${detail.conclusion}`, {
          effect: 'merge-and-tag-completed',
          run: { id: detailRunId, url: detail.html_url || detail.url, conclusion: detail.conclusion, jobs },
        });
      }
      return {
        id: detailRunId,
        workflowId: options.workflowFence.id,
        url: detail.html_url || detail.url,
        conclusion: detail.conclusion,
        jobs,
      };
    }
    await sleepImpl(pollIntervalMs, signal);
  }

  throw new RepoWorkflowError('WORKFLOW_TIMEOUT', `Workflow "${options.workflowFence.name}" did not finish before timeout`, {
    effect: 'merge-and-tag-completed',
    run: { id: selectedRunId, url: runInfo.html_url || runInfo.url },
  });
}

function attachRemoteEffects(error, remoteEffects) {
  if (error instanceof RepoWorkflowError) {
    error.details = { ...error.details, remoteEffects };
    return error;
  }
  return new RepoWorkflowError('POST_LANDING_FAILED', error?.message || String(error), {
    remoteEffects,
  });
}

function rejectLegacyLandingOptions(options) {
  if (Object.hasOwn(options, 'mergeMethod')) {
    throw new RepoWorkflowError('MERGE_METHOD_UNSUPPORTED', 'land always installs the exact reviewed merge snapshot; mergeMethod is not supported');
  }
  if (Object.hasOwn(options, 'worktreePaths') || Object.hasOwn(options, 'cleanupWorktree')) {
    throw new RepoWorkflowError('LANDING_CLEANUP_UNSUPPORTED', 'land never removes worktrees; cleanup must be requested separately after landing');
  }
}

async function pushReviewedSnapshot(run, repository, pushUrl, baseRef, frozenBase, reviewedSnapshot) {
  let pushFailure = null;
  let pushRejected = false;
  try {
    const pushed = await runGit(run, repository.repoRoot, [
      'push',
      '--porcelain',
      `--force-with-lease=${baseRef}:${frozenBase}`,
      pushUrl,
      `${reviewedSnapshot}:${baseRef}`,
    ], { allowExitCodes: [1] });
    if (pushed.exitCode !== 0) {
      pushFailure = pushed;
      // A non-zero exit can follow remote acceptance (for example a lost
      // connection). Only a porcelain rejection for this exact destination
      // proves that Git rejected the write; stderr/exit status alone cannot.
      pushRejected = String(pushed.stdout || '').split('\n').some(line => {
        const [flag, refspec, summary] = line.split('\t');
        return flag === '!'
          && refspec === `${reviewedSnapshot}:${baseRef}`
          && /^\[(?:rejected|remote rejected)\](?: |$)/.test(summary || '');
      });
    }
  } catch (error) {
    pushFailure = error;
  }

  let actual;
  try {
    actual = await resolveRemoteRefSha(run, repository, baseRef, pushUrl);
  } catch (error) {
    throw new RepoWorkflowError('BASE_UPDATE_OUTCOME_UNKNOWN', 'Could not verify the remote base after the atomic update attempt', {
      ref: baseRef,
      expectedOld: frozenBase,
      expectedNew: reviewedSnapshot,
      cause: error?.message || String(error),
    });
  }
  if (actual === reviewedSnapshot) return;
  if (pushFailure) {
    if (pushRejected && actual === frozenBase) {
      throw new RepoWorkflowError('BASE_LEASE_REJECTED', 'Remote base did not accept the exact reviewed snapshot with the frozen-base lease', {
        ref: baseRef,
        expectedOld: frozenBase,
        expectedNew: reviewedSnapshot,
        actual,
      });
    }
    throw new RepoWorkflowError('BASE_UPDATE_OUTCOME_UNKNOWN', 'Remote base outcome is unknown after the atomic update attempt failed', {
      ref: baseRef,
      expectedOld: frozenBase,
      expectedNew: reviewedSnapshot,
      actual,
      pushError: formatRepoWorkflowError(pushFailure),
    });
  }
  throw new RepoWorkflowError('BASE_UPDATE_VERIFY_FAILED', 'Remote base does not point at the exact reviewed snapshot after push', {
    ref: baseRef,
    expected: reviewedSnapshot,
    actual,
  });
}

export async function landRepoWorkflow(options = {}, dependencies = {}) {
  const run = dependencies.run || createRepoCommandRunner({ signal: dependencies.signal });
  const pr = assertPositiveInteger(options.pr, 'pr');
  if (!isRepoApprovalCapability(dependencies.approvalCapability)) {
    throw new RepoWorkflowError('APPROVAL_REQUIRED', 'Landing requires a host-issued repository approval capability');
  }
  if (typeof options.baseBranch !== 'string' || !options.baseBranch.trim()) {
    throw new RepoWorkflowError('INVALID_INPUT', 'baseBranch must be the exact reviewed destination branch');
  }
  if (!/^[0-9a-f]{40}$/i.test(options.baseSha || '')) {
    throw new RepoWorkflowError('INVALID_INPUT', 'baseSha must be the exact 40-character reviewed base commit SHA');
  }
  if (!/^[0-9a-f]{40}$/i.test(options.reviewedHead || '')) {
    throw new RepoWorkflowError('INVALID_INPUT', 'reviewedHead must be the exact 40-character reviewed commit SHA');
  }
  if (!/^[0-9a-f]{40}$/i.test(options.reviewedSnapshot || '')) {
    throw new RepoWorkflowError('INVALID_INPUT', 'reviewedSnapshot must be the exact 40-character reviewed merge snapshot SHA');
  }
  rejectLegacyLandingOptions(options);
  const approvedBaseBranch = options.baseBranch.trim();
  const approvedBaseSha = options.baseSha.toLowerCase();
  if (options.tagPrefix !== undefined) validateTagPrefix(options.tagPrefix);

  const repository = await resolveRepository(run, options.cwd || process.cwd(), options);
  const github = githubRepository(repository);
  const approval = consumeRepoApprovalCapability(dependencies.approvalCapability, {
    ...dependencies.approvalContext,
    repository: `${github.host}/${github.nameWithOwner}`,
    pr,
    baseBranch: approvedBaseBranch,
    baseSha: approvedBaseSha,
    reviewedHead: options.reviewedHead,
    reviewedSnapshot: options.reviewedSnapshot,
  }, { now: dependencies.now || Date.now });
  if (!approval) {
    throw new RepoWorkflowError('APPROVAL_REQUIRED', 'Repository approval capability is missing, invalid, stale, or already consumed');
  }

  // The push URL and workflow identity are frozen before the first write. The
  // base update itself is one receive-pack ref transaction guarded by the exact
  // base observed together with the reviewed PR head and merge snapshot.
  const pushUrl = await assertPushTarget(run, repository);
  const workflowIdentity = options.workflow
    ? await captureWorkflowIdentity(run, repository, options.workflow)
    : null;
  const now = dependencies.now || (() => Date.now());
  let workflowFence = null;
  let workflowNotBeforeMs = null;
  const info = await loadPullRequest(run, repository, pr);
  if (info.baseRefName !== approvedBaseBranch) {
    throw new RepoWorkflowError('REVIEW_STALE', 'PR destination branch changed after review', {
      reviewed: { baseBranch: approvedBaseBranch, baseSha: approvedBaseSha },
      current: { baseBranch: info.baseRefName },
    });
  }
  let checks = null;
  let frozenBase = null;
  let alreadyMerged = false;
  let tag = null;

  if (info.state === 'OPEN') {
    checks = validateOpenPullRequest(info, { requireChecksComplete: true });
    const frozen = await fetchPullRequestSnapshot(run, repository, info);
    if (frozen.headSha !== options.reviewedHead || frozen.snapshotSha !== options.reviewedSnapshot) {
      throw new RepoWorkflowError('REVIEW_STALE', 'PR head or merge snapshot changed after review', {
        reviewed: { headSha: options.reviewedHead, snapshotSha: options.reviewedSnapshot },
        current: { headSha: frozen.headSha, snapshotSha: frozen.snapshotSha, baseSha: frozen.baseSha },
      });
    }
    if (frozen.baseSha !== approvedBaseSha) {
      throw new RepoWorkflowError('REVIEW_STALE', 'PR base changed after review', {
        reviewed: { baseBranch: approvedBaseBranch, baseSha: approvedBaseSha },
        current: { baseBranch: info.baseRefName, baseSha: frozen.baseSha },
      });
    }
    frozenBase = approvedBaseSha;
  } else if (info.state === 'MERGED') {
    const mergeSha = info.mergeCommit?.oid || null;
    if (info.headRefOid !== options.reviewedHead || mergeSha !== options.reviewedSnapshot) {
      throw new RepoWorkflowError('REVIEW_STALE', 'Merged pull request does not match the exact reviewed head and snapshot', {
        reviewed: { headSha: options.reviewedHead, snapshotSha: options.reviewedSnapshot },
        current: { headSha: info.headRefOid, mergeSha },
      });
    }
    const parentLine = await gitOutput(run, repository.repoRoot, ['rev-list', '--parents', '-n', '1', options.reviewedSnapshot]);
    const [, ...parents] = parentLine.split(/\s+/);
    if (parents.length !== 2 || parents[0] !== approvedBaseSha || parents[1] !== options.reviewedHead) {
      throw new RepoWorkflowError('SNAPSHOT_INCONSISTENT', 'Reviewed snapshot does not have the approved base and reviewed head as its parents', {
        baseSha: approvedBaseSha,
        headSha: options.reviewedHead,
        snapshotSha: options.reviewedSnapshot,
        parents,
      });
    }
    const currentBase = await fetchBase(run, repository, approvedBaseBranch);
    if (currentBase !== options.reviewedSnapshot) {
      throw new RepoWorkflowError('BASE_NOT_EXACT_REVIEWED_SNAPSHOT', 'Remote base no longer points at the exact reviewed snapshot', {
        expected: options.reviewedSnapshot,
        actual: currentBase,
      });
    }
    frozenBase = parents[0];
    alreadyMerged = true;
  } else {
    throw new RepoWorkflowError('PR_NOT_LANDABLE', `PR #${pr} is ${String(info.state).toLowerCase()}`);
  }

  if (workflowIdentity && !options.tagPrefix) {
    if (alreadyMerged) {
      throw new RepoWorkflowError('WORKFLOW_NOT_TRIGGERED', 'The exact reviewed snapshot is already landed, so this call cannot fence a new branch workflow run');
    }
    workflowFence = await captureWorkflowBaseline(run, repository, workflowIdentity);
    workflowNotBeforeMs = now();
  }

  const baseRef = `refs/heads/${approvedBaseBranch}`;
  const remoteEffects = {
    base: {
      status: alreadyMerged ? 'preexisting' : 'not-attempted',
      ref: baseRef,
      before: frozenBase,
      sha: options.reviewedSnapshot,
    },
  };
  try {
    if (!alreadyMerged) {
      remoteEffects.base.status = 'unknown';
      try {
        await pushReviewedSnapshot(
          run,
          repository,
          pushUrl,
          baseRef,
          frozenBase,
          options.reviewedSnapshot,
        );
      } catch (error) {
        if (error instanceof RepoWorkflowError && error.code === 'BASE_LEASE_REJECTED') {
          remoteEffects.base.status = 'rejected';
        }
        throw error;
      }
      remoteEffects.base.status = 'created';
    }

    if (options.tagPrefix) {
      tag = await createAndPushNextTag(
        run,
        repository,
        pushUrl,
        options.reviewedSnapshot,
        options.tagPrefix,
        options.tagStart ?? 0,
        {
          baseGuard: { ref: baseRef, sha: options.reviewedSnapshot },
          onStage: effect => { remoteEffects.tag = effect; },
          beforePush: async () => {
            if (!workflowIdentity) return;
            workflowFence = await captureWorkflowBaseline(run, repository, workflowIdentity);
            workflowNotBeforeMs = now();
          },
        },
      );
      if (workflowIdentity && !workflowFence) {
        throw new RepoWorkflowError('WORKFLOW_NOT_TRIGGERED', 'The target tag already existed, so this landing did not trigger a new workflow run', {
          tag,
        });
      }
    }
    const workflow = workflowFence
      ? await waitForWorkflow(run, repository, {
        workflowFence,
        targetSha: options.reviewedSnapshot,
        ref: tag?.name || approvedBaseBranch,
        notBeforeMs: workflowNotBeforeMs,
        waitTimeoutMs: options.waitTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
      }, dependencies)
      : null;

    return {
      ok: true,
      phase: 'land',
      repository: compactRepository(repository),
      approval: {
        by: approval.issuerVpId,
        baseBranch: approvedBaseBranch,
        baseSha: approvedBaseSha,
        headSha: options.reviewedHead,
        snapshotSha: options.reviewedSnapshot,
      },
      pullRequest: { number: info.number, url: info.url, baseBranch: approvedBaseBranch, checks },
      merge: { sha: options.reviewedSnapshot, alreadyMerged },
      tag,
      workflow,
    };
  } catch (error) {
    throw attachRemoteEffects(error, remoteEffects);
  }
}

export function formatRepoWorkflowError(error) {
  const payload = error instanceof RepoWorkflowError
    ? (() => {
      const remoteEffects = error.details?.remoteEffects;
      const hasPossibleRemoteEffect = remoteEffects
        && Object.values(remoteEffects).some(effect => ['created', 'unknown'].includes(effect?.status));
      return {
        ok: false,
        errorEffect: hasPossibleRemoteEffect ? 'unknown' : 'none',
        error: error.message,
        code: error.code,
        details: error.details,
      };
    })()
    : {
      ok: false,
      errorEffect: 'unknown',
      error: error?.message || String(error),
      code: 'UNEXPECTED_ERROR',
      details: {},
    };
  return redactStructured(payload);
}
