import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

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

async function removeWorktreeOwnership(paths) {
  await Promise.allSettled([unlink(paths.repository), unlink(paths.worktree)]);
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
    await persistWorktreeOwnership(
      run,
      repository,
      createWorktreeOwnership(worktreePath, 'development', baseSha, branch),
    );
  } catch (error) {
    await runGit(run, repository.repoRoot, ['worktree', 'remove', worktreePath]);
    await runGit(run, repository.repoRoot, ['branch', '-D', branch]);
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
      reviewedHead: frozen.headSha,
      reviewedSnapshot: frozen.snapshotSha,
    },
  };
}

export function nextNumericTag(tagNames, prefix, start = 0) {
  if (typeof prefix !== 'string' || !prefix) {
    throw new RepoWorkflowError('INVALID_TAG_PREFIX', 'tagPrefix must be a non-empty string');
  }
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

async function resolveRemoteTagCommit(run, repository, tag) {
  const result = await runGit(run, repository.repoRoot, [
    'ls-remote',
    '--tags',
    repository.remote,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const peeled = lines.find(line => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find(line => line.endsWith(`refs/tags/${tag}`));
  return (peeled || direct)?.split(/\s+/)[0] || null;
}

async function createAndPushNextTag(run, repository, pushUrl, targetSha, prefix, start = 0, callbacks = {}) {
  const onStage = callbacks.onStage || (() => {});
  const beforePush = callbacks.beforePush || (async () => {});
  onStage({ stage: 'validate', status: 'not-attempted', prefix, sha: targetSha });
  const refCheck = await runGit(run, repository.repoRoot, ['check-ref-format', `refs/tags/${prefix}${start}`], {
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
    onStage({ stage: 'verified-preexisting', status: 'preexisting', name: existingTarget.name, sha: targetSha });
    return { name: existingTarget.name, sha: targetSha, reused: true };
  }

  const tag = nextNumericTag(matchingTags.map(ref => ref.name), prefix, start);
  onStage({ stage: 'selected', status: 'not-attempted', name: tag, sha: targetSha });
  const remoteExisting = await resolveRemoteTagCommit(run, repository, tag);
  if (remoteExisting && remoteExisting !== targetSha) {
    throw new RepoWorkflowError('TAG_CONFLICT', `Remote tag ${tag} already points to another commit`, {
      tag,
      expected: targetSha,
      actual: remoteExisting,
    });
  }

  const localRef = `refs/tags/${tag}`;
  const local = await runGit(run, repository.repoRoot, ['rev-parse', '--verify', '--quiet', `${localRef}^{commit}`], {
    allowExitCodes: [1],
  });
  if (local.exitCode === 0 && local.stdout !== targetSha) {
    throw new RepoWorkflowError('LOCAL_TAG_CONFLICT', `Local tag ${tag} points to another commit`, {
      tag,
      expected: targetSha,
      actual: local.stdout,
    });
  }
  if (local.exitCode !== 0) {
    await runGit(run, repository.repoRoot, ['tag', tag, targetSha]);
  }
  onStage({ stage: 'local-ready', status: 'none', name: tag, sha: targetSha });

  let reused = Boolean(remoteExisting);
  if (!remoteExisting) {
    await beforePush();
    onStage({ stage: 'push-started', status: 'unknown', name: tag, sha: targetSha });
    try {
      const pushed = await runGit(run, repository.repoRoot, ['push', '--porcelain', pushUrl, `${localRef}:${localRef}`]);
      const porcelain = `${pushed.stdout}\n${pushed.stderr}`;
      if (porcelain.split(/\r?\n/).some(line => line.startsWith('='))) reused = true;
      onStage({ stage: 'push-returned', status: 'unknown', name: tag, sha: targetSha });
    } catch (error) {
      const racedCommit = await resolveRemoteTagCommit(run, repository, tag);
      if (racedCommit !== targetSha) throw error;
      reused = true;
    }
  }
  const remoteCommit = await resolveRemoteTagCommit(run, repository, tag);
  if (remoteCommit !== targetSha) {
    throw new RepoWorkflowError('TAG_VERIFY_FAILED', `Remote tag ${tag} could not be verified`, {
      tag,
      expected: targetSha,
      actual: remoteCommit,
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

async function cleanupWorktrees(run, repository, paths, reviewedHead, reviewedSnapshot) {
  const results = [];
  for (const requestedPath of paths || []) {
    const path = resolve(requestedPath);
    const worktrees = await listWorktrees(run, repository);
    const record = worktrees.find(item => resolve(item.path) === path);
    if (!record) {
      results.push({ path, status: 'not-registered' });
      continue;
    }
    const developmentShape = record.branch?.startsWith('yeaft-wt/') && record.head === reviewedHead;
    const reviewShape = record.detached && record.head === reviewedSnapshot;
    const ownership = developmentShape
      ? await verifyWorktreeOwnership(run, repository, path, { kind: 'development', branch: record.branch })
      : reviewShape
        ? await verifyWorktreeOwnership(run, repository, path, {
          kind: 'review',
          createdHead: reviewedSnapshot,
          branch: null,
        })
        : null;
    if (!ownership) {
      results.push({ path, status: 'kept-unowned', branch: record.branch, head: record.head });
      continue;
    }
    const dirty = await worktreeStatus(run, path);
    if (dirty) {
      results.push({ path, status: 'kept-dirty' });
      continue;
    }
    await runGit(run, repository.repoRoot, ['worktree', 'remove', path]);
    await removeWorktreeOwnership(ownership.paths);
    let branchDeleted = false;
    if (developmentShape) {
      const branchHead = await runGit(run, repository.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`], {
        allowExitCodes: [1],
      });
      if (branchHead.exitCode === 0 && branchHead.stdout === reviewedHead) {
        await runGit(run, repository.repoRoot, ['branch', '-D', record.branch]);
        branchDeleted = true;
      }
    }
    results.push({ path, status: 'removed', branch: record.branch, branchDeleted });
  }
  return results;
}

function attachRemoteEffects(error, remoteEffects) {
  if (error instanceof RepoWorkflowError) {
    error.details = { ...error.details, remoteEffects };
    return error;
  }
  return new RepoWorkflowError('POST_MERGE_FAILED', error?.message || String(error), {
    remoteEffects,
  });
}

export async function landRepoWorkflow(options = {}, dependencies = {}) {
  const run = dependencies.run || createRepoCommandRunner({ signal: dependencies.signal });
  const pr = assertPositiveInteger(options.pr, 'pr');
  if (!/^[0-9a-f]{40}$/i.test(options.reviewedHead || '')) {
    throw new RepoWorkflowError('INVALID_INPUT', 'reviewedHead must be the exact 40-character reviewed commit SHA');
  }
  if (!/^[0-9a-f]{40}$/i.test(options.reviewedSnapshot || '')) {
    throw new RepoWorkflowError('INVALID_INPUT', 'reviewedSnapshot must be the exact 40-character reviewed merge snapshot SHA');
  }
  if (!String(options.approvedBy || '').trim()) {
    throw new RepoWorkflowError('APPROVAL_REQUIRED', 'approvedBy is required; landing cannot infer review approval');
  }
  const mergeMethod = options.mergeMethod || 'merge';
  if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) {
    throw new RepoWorkflowError('INVALID_INPUT', 'mergeMethod must be merge, squash, or rebase');
  }

  const repository = await resolveRepository(run, options.cwd || process.cwd(), options);
  // Freeze every identity used by a later side effect before merging. Fetch URL
  // selects the GitHub repository; every configured push URL must select the
  // same repository, and tag pushes use the validated URL rather than a remote
  // name whose pushurl can drift independently.
  const pushUrl = options.tagPrefix ? await assertPushTarget(run, repository) : null;
  const workflowIdentity = options.workflow
    ? await captureWorkflowIdentity(run, repository, options.workflow)
    : null;
  const now = dependencies.now || (() => Date.now());
  let workflowFence = null;
  let workflowNotBeforeMs = null;
  const info = await loadPullRequest(run, repository, pr);
  let checks = null;
  let mergeSha = info.mergeCommit?.oid || null;
  let mergeCreated = false;
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
    if (workflowIdentity && !options.tagPrefix) {
      workflowFence = await captureWorkflowBaseline(run, repository, workflowIdentity);
      workflowNotBeforeMs = now();
    }
    const github = githubRepository(repository);
    let response;
    try {
      response = await ghJson(run, repository.repoRoot, [
        'api',
        '--hostname',
        github.host,
        '--method',
        'PUT',
        `repos/${github.nameWithOwner}/pulls/${pr}/merge`,
        '-f',
        `sha=${options.reviewedHead}`,
        '-f',
        `merge_method=${mergeMethod}`,
      ], 'MERGE_FAILED');
    } catch (error) {
      throw attachRemoteEffects(error, {
        merge: { status: 'unknown', pr, reviewedHead: options.reviewedHead },
      });
    }
    if (response.merged !== true || !response.sha) {
      throw new RepoWorkflowError('MERGE_REJECTED', response.message || `GitHub did not merge PR #${pr}`, {
        response,
        remoteEffects: { merge: { status: 'rejected', pr, reviewedHead: options.reviewedHead } },
      });
    }
    mergeSha = response.sha;
    mergeCreated = true;
  } else if (info.state === 'MERGED') {
    if (!mergeSha) {
      throw new RepoWorkflowError('MERGE_COMMIT_UNKNOWN', `PR #${pr} is merged but GitHub returned no merge commit`);
    }
    if (info.headRefOid !== options.reviewedHead) {
      throw new RepoWorkflowError('REVIEW_STALE', 'Reviewed head does not match the merged pull request head', {
        reviewed: { headSha: options.reviewedHead, snapshotSha: options.reviewedSnapshot },
        current: { headSha: info.headRefOid, mergeSha },
      });
    }
  } else {
    throw new RepoWorkflowError('PR_NOT_LANDABLE', `PR #${pr} is ${String(info.state).toLowerCase()}`);
  }

  const remoteEffects = {
    merge: { status: mergeCreated ? 'created' : 'preexisting', pr, sha: mergeSha },
  };
  try {
    const baseSha = await fetchBase(run, repository, info.baseRefName);
    if (baseSha !== mergeSha) {
      throw new RepoWorkflowError('BASE_ADVANCED_AFTER_MERGE', 'Remote base no longer points at this PR merge commit; refusing to tag a moving target', {
        mergeSha,
        baseSha,
      });
    }
    const reviewedTree = await gitOutput(run, repository.repoRoot, ['rev-parse', `${options.reviewedSnapshot}^{tree}`]);
    const landedTree = await gitOutput(run, repository.repoRoot, ['rev-parse', `${mergeSha}^{tree}`]);
    if (reviewedTree !== landedTree) {
      throw new RepoWorkflowError('LANDING_TREE_MISMATCH', 'Merged result does not match the independently approved merge snapshot tree', {
        reviewedSnapshot: options.reviewedSnapshot,
        reviewedTree,
        mergeSha,
        landedTree,
      });
    }

    if (options.tagPrefix) {
      tag = await createAndPushNextTag(
        run,
        repository,
        pushUrl,
        mergeSha,
        options.tagPrefix,
        options.tagStart ?? 0,
        {
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
        targetSha: mergeSha,
        ref: tag?.name || info.baseRefName,
        notBeforeMs: workflowNotBeforeMs,
        waitTimeoutMs: options.waitTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
      }, dependencies)
      : null;
    const cleanup = await cleanupWorktrees(
      run,
      repository,
      options.worktreePaths || [],
      options.reviewedHead,
      options.reviewedSnapshot,
    );

    return {
      ok: true,
      phase: 'land',
      repository: compactRepository(repository),
      approval: { by: String(options.approvedBy).trim(), headSha: options.reviewedHead, snapshotSha: options.reviewedSnapshot },
      pullRequest: { number: info.number, url: info.url, baseBranch: info.baseRefName, checks },
      merge: { sha: mergeSha, alreadyMerged: !mergeCreated },
      tag,
      workflow,
      cleanup,
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
        && Object.values(remoteEffects).some(effect => effect?.status !== 'rejected');
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
