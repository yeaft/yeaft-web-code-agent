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
async function filterOverrides(run, options) {
  const result = await run('git', [
    ...COMMON_ARGS, 'config', '--null', '--name-only', '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process|required)$',
  ], options);
  if (result.truncated || result.timedOut || (result.code !== 0 && result.code !== 1)) {
    throw new Error('Cannot safely inspect Git content filters');
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

function errorOutput(message) {
  return JSON.stringify({ error: message });
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

export function formatGitReadResult(operation, result) {
  const timedOut = Boolean(result.timedOut);
  const runnerTruncated = Boolean(result.truncated);
  const sections = [];
  if (result.stdout) sections.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr) sections.push(`STDERR:\n${result.stderr}`);
  const body = sections.join('\n');
  const baseHeader = truncated => [
    `operation: ${operation}`,
    `exitCode: ${runnerTruncated ? 'not observed (output limit reached)' : result.code}`,
    `timedOut: ${timedOut}`,
    `truncated: ${truncated}`,
  ].join('\n');
  const initial = `${baseHeader(runnerTruncated)}\n\n${body || '(no output)'}`;
  if (!runnerTruncated && Buffer.byteLength(initial, 'utf8') <= MAX_RESULT_BYTES) return initial;

  const marker = '\n\n[Output truncated by GitRead; narrow the revision or paths.]';
  const header = `${baseHeader(true)}\n\n`;
  const bodyBudget = Math.max(
    0,
    MAX_RESULT_BYTES - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(marker, 'utf8'),
  );
  return header + takeUtf8(body || '(no output)', bodyBudget) + marker;
}

const gitReadTool = defineTool({
  name: 'GitRead',
  description: {
    en: `Read bounded local Git evidence without a shell or network access.

Supported operations are intentionally limited:
- status: compact branch and working-tree status.
- diff: tracked changes against HEAD by default, or an explicit base...head range; optional paths narrow the result.
- show: one commit (HEAD by default), optionally narrowed by paths.
- log: a compact bounded commit list (20 entries by default, maximum 50).

GitRead never fetches, writes Git state, or creates worktrees. It disables pagers, external diff, textconv, content filters, optional locks, fsmonitor, and submodule traversal. Filter-normalized files (such as LFS) show raw worktree bytes; submodule status needs separate inspection. Revisions and paths beginning with "-" are rejected. Output reports whether it was truncated.`,
    zh: `有界读取本地 Git 证据，不使用 shell，也不访问网络。

操作范围刻意限制为：
- status：紧凑显示分支和工作区状态。
- diff：默认显示相对 HEAD 的已跟踪改动，也可指定 base...head；可用 paths 缩小范围。
- show：显示一个提交（默认 HEAD），可用 paths 缩小范围。
- log：紧凑且有界的提交列表（默认 20 条，最多 50 条）。

GitRead 不 fetch、不写 Git 状态、不创建 worktree。它禁用 pager、external diff、textconv、内容 filter、optional locks、fsmonitor 和子模块遍历。LFS 等 filter 文件显示原始工作区字节，子模块状态需单独检查。拒绝以 "-" 开头的 revision 与路径；结果明确标识是否截断。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['status', 'diff', 'show', 'log'] },
      base: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'Diff base revision; omitted for working-tree changes against HEAD' },
      head: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'Diff head revision; requires base and defaults to HEAD' },
      revision: { type: 'string', maxLength: MAX_VALUE_LENGTH, description: 'Revision for show or log (default: HEAD)' },
      paths: {
        type: 'array',
        maxItems: MAX_PATHS,
        items: { type: 'string', minLength: 1, maxLength: MAX_VALUE_LENGTH },
        description: 'Optional repository-relative paths for diff or show',
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LOG_LIMIT, description: 'Maximum log entries' },
    },
    required: ['operation'],
  },
  timeoutMs: 0,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const built = buildGitReadArgs(input);
    if (built.error) return errorOutput(built.error);
    const cwd = resolve(ctx?.cwd || process.cwd());
    try {
      const run = ctx?.[RUN_PROCESS_OVERRIDE] || runProcess;
      const startedAt = Date.now();
      const options = {
        cwd,
        signal: ctx?.signal,
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_CAPTURE_BYTES,
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
      const overrides = await filterOverrides(run, options);
      const result = await run('git', [...overrides, ...built.args], {
        ...options, timeoutMs: Math.max(1, TIMEOUT_MS - (Date.now() - startedAt)),
      });
      return formatGitReadResult(input.operation, result);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return errorOutput(`GitRead failed: ${error?.message || String(error)}`);
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
