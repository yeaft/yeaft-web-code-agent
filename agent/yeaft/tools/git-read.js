import { resolve } from 'node:path';
import { defineTool } from './types.js';
import { runProcess } from './process-runner.js';

const MAX_RESULT_BYTES = 30 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PATHS = 50;
const MAX_VALUE_LENGTH = 4096;
const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 50;
const TIMEOUT_MS = 30_000;
const RUN_PROCESS_OVERRIDE = Symbol('runProcessOverride');

const COMMON_ARGS = Object.freeze([
  '--no-pager',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--no-replace-objects',
  '-c', 'color.ui=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '-c', 'submodule.recurse=false',
  '-c', 'diff.submodule=short',
  '-c', 'protocol.allow=never',
]);

// Worktree status/diff may invoke clean/process filters even with textconv and
// external diff disabled. Discover their keys, never values, and override them
// for this process only. Incomplete discovery fails closed.
async function filterOverrides(run) {
  const result = await run('git', [
    ...COMMON_ARGS, 'config', '--null', '--name-only', '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process|required)$',
  ]);
  if (result.truncated || result.timedOut || result.terminationError || (result.code !== 0 && result.code !== 1)) {
    throw Object.assign(new Error('Cannot safely inspect Git content filters'), { result });
  }
  if (result.code === 1) return [];
  const keys = [...new Set(result.stdout.split('\0').filter(Boolean))];
  if (keys.length > 200) throw new Error('Too many Git content filters for a bounded read');
  return keys.flatMap(key => {
    if (!/^filter\..*\.(clean|smudge|process|required)$/.test(key) || /[=\r\n]/.test(key)) {
      throw new Error('Unsupported Git filter key; refusing an unsafe read');
    }
    return ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`];
  });
}

function errorOutput(message, operation) {
  return boundedFailure({
    error: takeUtf8(message, 1024), errorEffect: 'none', code: 'invalid_arguments',
    hint: `Use only fields for the chosen operation. Minimal example: ${JSON.stringify({ operation: ['status', 'diff', 'show', 'log'].includes(operation) ? operation : 'status' })}`,
  });
}

// Some strict-schema providers require every property. Treat their empty
// placeholders as omitted, without accepting unknown keys or non-default
// arguments belonging to another operation.
function normalizeInput(input) {
  const result = { ...input };
  for (const key of ['base', 'head', 'revision', 'paths', 'limit']) {
    if (result[key] === null || result[key] === undefined
        || (['base', 'head', 'revision'].includes(key) && result[key] === '')
        || (key === 'paths' && Array.isArray(result[key]) && result[key].length === 0)
        || (key === 'limit' && result.operation !== 'log' && result[key] === DEFAULT_LOG_LIMIT)) {
      delete result[key];
    }
  }
  return result;
}

function validateValue(value, name) {
  if (typeof value !== 'string' || !value) return `${name} must be a non-empty string`;
  if (value.length > MAX_VALUE_LENGTH) return `${name} must be at most ${MAX_VALUE_LENGTH} characters`;
  if (value.startsWith('-')) return `${name} must not start with "-"`;
  if (/\0|[\r\n]/u.test(value)) return `${name} must not contain NUL or newlines`;
  return null;
}

function validatePaths(paths) {
  if (paths === undefined) return null;
  if (!Array.isArray(paths)) return 'paths must be an array of strings';
  if (paths.length > MAX_PATHS) return `paths must contain at most ${MAX_PATHS} entries`;
  for (let index = 0; index < paths.length; index += 1) {
    const error = validateValue(paths[index], `paths[${index}]`);
    if (error) return error;
    if (paths[index].includes(':(attr:')) return `paths[${index}] must not use pathspec attributes`;
  }
  return null;
}

function unexpectedInput(input, allowed) {
  const unexpected = Object.keys(input).filter(key => !allowed.has(key));
  return unexpected.length > 0 ? `Unexpected parameter(s) for ${input.operation}: ${unexpected.join(', ')}` : null;
}

export function buildGitReadArgs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'input must be an object' };
  }

  input = normalizeInput(input);
  const { operation } = input;
  if (!['status', 'diff', 'show', 'log'].includes(operation)) {
    return { error: 'operation must be one of: status, diff, show, log' };
  }

  if (operation === 'status') {
    const error = unexpectedInput(input, new Set(['operation']));
    if (error) return { error };
    return { args: [...COMMON_ARGS, 'status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all'] };
  }

  if (operation === 'diff') {
    const error = unexpectedInput(input, new Set(['operation', 'base', 'head', 'paths']))
      || validatePaths(input.paths)
      || (input.base !== undefined ? validateValue(input.base, 'base') : null)
      || (input.head !== undefined ? validateValue(input.head, 'head') : null);
    if (error) return { error };
    if (input.head !== undefined && input.base === undefined) {
      return { error: 'head requires base' };
    }
    const revision = input.base === undefined
      ? 'HEAD'
      : `${input.base}...${input.head || 'HEAD'}`;
    return {
      args: [
        ...COMMON_ARGS,
        'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty',
        revision, '--', ...(input.paths || []),
      ],
    };
  }

  if (operation === 'show') {
    const error = unexpectedInput(input, new Set(['operation', 'revision', 'paths']))
      || validatePaths(input.paths)
      || (input.revision !== undefined ? validateValue(input.revision, 'revision') : null);
    if (error) return { error };
    return {
      args: [
        ...COMMON_ARGS,
        'show', '--no-ext-diff', '--no-textconv', '--no-color', '--format=fuller',
        input.revision || 'HEAD', '--', ...(input.paths || []),
      ],
    };
  }

  const error = unexpectedInput(input, new Set(['operation', 'revision', 'limit']))
    || (input.revision !== undefined ? validateValue(input.revision, 'revision') : null);
  if (error) return { error };
  const limit = input.limit === undefined ? DEFAULT_LOG_LIMIT : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_LOG_LIMIT}` };
  }
  return {
    args: [
      ...COMMON_ARGS,
      'log', '--no-color', `--max-count=${limit}`, '--date=iso-strict',
      '--format=%H%x09%ad%x09%an%x09%s', input.revision || 'HEAD', '--',
    ],
  };
}

function takeUtf8(text, maxBytes) {
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function formatSuccess(operation, result) {
  const sections = [];
  if (result.stdout) sections.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr) sections.push(`STDERR:\n${result.stderr}`);
  const body = sections.join('\n');
  const baseHeader = truncated => [
    `operation: ${operation}`,
    `exitCode: ${result.code}`,
    'timedOut: false',
    `truncated: ${truncated}`,
  ].join('\n');
  const initial = `${baseHeader(false)}\n\n${body || '(no output)'}`;
  if (Buffer.byteLength(initial, 'utf8') <= MAX_RESULT_BYTES) return initial;

  const marker = '\n\n[Output truncated by GitRead; narrow the revision or paths.]';
  const header = `${baseHeader(true)}\n\n`;
  const bodyBudget = Math.max(
    0,
    MAX_RESULT_BYTES - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(marker, 'utf8'),
  );
  return header + takeUtf8(body || '(no output)', bodyBudget) + marker;
}

// Keep returned errors parseable even when JSON escaping expands raw output.
// Engine uses this envelope (not text exit codes) for tool_end.isError.
function boundedFailure(fields, output = '') {
  const envelope = { ...fields, ...(output ? { output: String(output) } : {}) };
  // Metadata is not necessarily small: even an invalid cwd reaches spawn.
  // Bound each string after allowing for JSON's worst-case 6x escaping;
  // the fixed envelope fields then leave ample room for diagnostics.
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 512) {
      envelope[key] = takeUtf8(value, 512) + '[truncated]';
      envelope.truncated = true;
    }
  }
  let serialized = JSON.stringify(envelope);
  const marker = '\n[GitRead diagnostic truncated; narrow the revision or paths.]';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
    envelope.truncated = true;
    let low = 0;
    let high = Math.min(Buffer.byteLength(output, 'utf8'), MAX_RESULT_BYTES);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      envelope.output = takeUtf8(output, mid) + marker;
      if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_RESULT_BYTES) low = mid;
      else high = mid - 1;
    }
    envelope.output = takeUtf8(output, low) + marker;
    serialized = JSON.stringify(envelope);
  }
  return serialized;
}

export function formatGitReadResult(operation, result, { resolvedCwd, stage = operation } = {}) {
  if (result.code === 0 && !result.timedOut && !result.truncated && !result.terminationError) {
    return formatSuccess(operation, result);
  }
  const code = result.terminationError ? 'git_exit_unconfirmed'
    : result.timedOut ? 'git_timeout'
      : result.truncated ? 'git_output_limit'
        : !Number.isInteger(result.code) ? 'git_exit_unconfirmed' : 'git_failed';
  const error = {
    git_exit_unconfirmed: 'Git process exit was not confirmed',
    git_timeout: 'Git read timed out',
    git_output_limit: 'Git read stopped at the capture limit; output is incomplete',
    git_failed: `Git exited with code ${result.code}`,
  }[code];
  // Put stderr first so a long partial diff cannot hide Git's explanation.
  const output = [result.terminationError, result.stderr && `STDERR:\n${result.stderr}`,
    result.stdout && `STDOUT:\n${result.stdout}`].filter(Boolean).join('\n');
  return boundedFailure({
    error, errorEffect: 'none', code, operation, stage, resolvedCwd,
    exitCode: result.truncated || result.terminationError ? null : (result.code ?? null),
    timedOut: Boolean(result.timedOut), truncated: Boolean(result.truncated),
    ...(result.terminationError || code === 'git_exit_unconfirmed' ? { terminationConfirmed: false } : {}),
  }, output);
}

const gitReadTool = defineTool({
  name: 'GitRead',
  description: {
    en: `Read bounded local Git evidence without a shell or network access.

Supported operations are intentionally limited:
- status: compact branch and working-tree status.
- diff: tracked changes against HEAD by default, or an explicit base...head range; optional paths narrow the result.
- show: exactly one commit (HEAD by default; tags are peeled to commits), optionally narrowed by paths. Ranges and non-commit objects are rejected.
- log: a compact bounded commit list (20 entries by default, maximum 50).

GitRead never fetches, writes Git state, or creates worktrees. It disables pagers, external diff, textconv, content filters, optional locks, fsmonitor, and submodule traversal. Filter-normalized files (such as LFS) show raw worktree bytes; submodule status needs separate inspection. Revisions and paths beginning with "-" are rejected. Output reports truncation. Git failures, timeouts and capture-limit stops return an error with bounded diagnostics.`,
    zh: `有界读取本地 Git 证据，不使用 shell，也不访问网络。

操作范围刻意限制为：
- status：紧凑显示分支和工作区状态。
- diff：默认显示相对 HEAD 的已跟踪改动，也可指定 base...head；可用 paths 缩小范围。
- show：显示唯一提交（默认 HEAD；tag 解析到 commit），可用 paths 缩小范围。拒绝范围及非 commit 对象。
- log：紧凑且有界的提交列表（默认 20 条，最多 50 条）。

GitRead 不 fetch、不写 Git 状态、不创建 worktree。它禁用 pager、external diff、textconv、内容 filter、optional locks、fsmonitor 和子模块遍历。LFS 等 filter 文件显示原始工作区字节，子模块状态需单独检查。拒绝以 "-" 开头的 revision 与路径；结果明确标识是否截断；Git 失败、超时及捕获上限终止返回含有界诊断的错误。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['status', 'diff', 'show', 'log'] },
      base: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'diff only; empty/omitted means working-tree changes against HEAD' },
      head: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'diff only; requires base, empty/omitted defaults to HEAD' },
      revision: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'show/log only; empty/omitted defaults to HEAD. show requires a single commit, not a range/tree/blob' },
      paths: {
        type: 'array',
        maxItems: MAX_PATHS,
        items: { type: 'string', minLength: 1, maxLength: MAX_VALUE_LENGTH },
        description: 'diff/show only; empty/omitted means all paths',
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LOG_LIMIT, description: 'log only; default 20. Empty optional fields are ignored; omit fields for other operations.' },
    },
    required: ['operation'],
  },
  timeoutMs: 0,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const built = buildGitReadArgs(input);
    if (built.error) return errorOutput(built.error, input?.operation);
    input = normalizeInput(input);
    const cwd = resolve(ctx?.cwd || process.cwd());
    let stage = input.operation;
    try {
      const run = ctx?.[RUN_PROCESS_OVERRIDE] || runProcess;
      const startedAt = Date.now();
      const options = {
        cwd,
        signal: ctx?.signal,
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_CAPTURE_BYTES,
        requireExitConfirmation: true,
        env: {
          ...process.env,
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          GIT_EXTERNAL_DIFF: '',
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          NO_COLOR: '1',
        },
      };
      const read = (command, args) => {
        const remaining = TIMEOUT_MS - (Date.now() - startedAt);
        if (remaining <= 0) {
          throw Object.assign(new Error('Git read timed out'), { code: 'git_timeout', timedOut: true });
        }
        return run(command, args, { ...options, timeoutMs: remaining });
      };
      // Only these operations inspect worktree bytes. Object-only reads must
      // not pay for filter discovery or fail on an unusable worktree filter.
      const readsWorktree = input.operation === 'status'
        || (input.operation === 'diff' && input.base === undefined);
      let overrides = [];
      if (readsWorktree) {
        stage = 'filter_inspection';
        overrides = await filterOverrides(read);
      }
      let args = built.args;
      if (input.operation === 'show') {
        stage = 'resolve_commit';
        const resolved = await read('git', [
          ...COMMON_ARGS, 'rev-parse', '--verify', '--end-of-options', `${input.revision || 'HEAD'}^{commit}`,
        ]);
        if (resolved.code !== 0 || resolved.truncated || resolved.timedOut || resolved.terminationError) {
          return formatGitReadResult(input.operation, resolved, { resolvedCwd: cwd, stage });
        }
        const commit = resolved.stdout.trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) {
          throw new Error('Expected exactly one resolved commit object ID');
        }
        args = buildGitReadArgs({ ...input, revision: commit }).args;
      }
      stage = input.operation;
      const result = await read('git', [...overrides, ...args]);
      return formatGitReadResult(input.operation, result, { resolvedCwd: cwd, stage });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error?.result) {
        return formatGitReadResult(input.operation, error.result, { resolvedCwd: cwd, stage });
      }
      return boundedFailure({
        error: 'GitRead failed', errorEffect: 'none',
        code: error?.name === 'ProcessTerminationError' ? 'git_exit_unconfirmed'
          : error?.code === 'git_timeout' ? 'git_timeout'
            : stage === 'filter_inspection' ? 'git_filter_inspection_failed' : 'git_execution_error',
        operation: input.operation, stage, resolvedCwd: cwd,
        ...(error?.timedOut ? { timedOut: true } : {}),
        ...(error?.name === 'ProcessTerminationError' ? { terminationConfirmed: false } : {}),
      }, error?.message || String(error));
    }
  },
});

export function createGitReadTool({ runProcessImpl = runProcess } = {}) {
  return {
    ...gitReadTool,
    execute(input, ctx) {
      return gitReadTool.execute(input, { ...ctx, [RUN_PROCESS_OVERRIDE]: runProcessImpl });
    },
  };
}

export { MAX_RESULT_BYTES };
export default gitReadTool;
