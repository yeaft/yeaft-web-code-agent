import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFile = promisify(execFileCallback);
const DEFAULT_REMOTE = 'origin';
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
