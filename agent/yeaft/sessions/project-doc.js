/**
 * project-doc.js — Read and select CLAUDE.md / AGENTS.md from a Session workDir.
 *
 * Per Session, the user may park a project-level instructions file in the
 * configured `workDir`. This module owns the stateless reader and scoped
 * selector; the Engine owns the per-Session/per-VP cache so mtime-driven
 * invalidation does not require a singleton.
 *
 * File-selection rule (matches user spec):
 *   • If both `CLAUDE.md` and `AGENTS.md` exist, the one with the newer
 *     mtime wins. Tie → CLAUDE.md (deterministic; this is the project's
 *     own convention).
 *   • If only one exists, pick it.
 *   • If neither exists, return null. Caller skips the prompt block.
 *
 * Why two filenames? CLAUDE.md is this project's convention; AGENTS.md
 * is the cross-tool convention adopted by Codex / OpenAI Codex CLI. Both
 * carry the same kind of payload — long-form project instructions — and
 * we want users coming from either ecosystem to "just work".
 *
 * Size cap. We read up to `maxBytes` and truncate larger files with a
 * console warning. Default cap is 32 KB (`DEFAULT_PROJECT_DOC_MAX_BYTES`),
 * mirroring Codex's `project_doc_max_bytes`. Setting the cap to 0 in the
 * engine config disables the feature entirely (the caller short-circuits
 * before reaching this module).
 *
 * NO module-level cache. The engine holds the cache so a mtime change
 * between sessions doesn't ride along into a fresh engine instance, and
 * tests can construct two engines without interfering with each other.
 */

import { statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { readWorkspaceFile, statWorkspaceFile } from '../workspace-file.js';

/** Filenames probed in `workDir`, in tie-break order (first wins on tie). */
export const PROJECT_DOC_FILENAMES = ['CLAUDE.md', 'AGENTS.md'];

/** Default max bytes pulled into the prompt block. Matches Codex. */
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;

const PROJECT_DOC_SPLIT_MIN_BYTES = 8 * 1024;

const SCOPE_PATTERNS = Object.freeze({
  agent: /(?:agent(?:\/|\b)|yeaft|engine|provider|llm|session|project|memory|dream|compact|skill|mcp|tool|后台任务|子 ?agent|原生引擎|模型|会话|项目|记忆|工具)/iu,
  web: /(?:web(?:\/|\b)|server(?:\/|\b)|browser|frontend|websocket|wire|pinia|vue|前端|浏览器|服务端|数据流|协议)/iu,
  workCenter: /(?:work[ -]?center|work ?item|action|runner|scheduler|工作中心|工作项)/iu,
  development: /(?:test\/|scripts\/|development|validation|testing|coding|language|开发|验证|测试|编码|运行环境)/iu,
  ui: /(?:ui|design|style|css|component|界面|设计|样式|组件)/iu,
  release: /(?:git|worktree|pull request|\bpr\b|review|merge|tag|release|发布|评审|合并)/iu,
});

const CORE_SECTION_RE = /(?:overview|general|core|product model|terminolog|compatib|runtime topology|repository structure|ownership|naming|operations|security|概述|通用|核心|产品模型|术语|兼容|运行时拓扑|仓库结构|所有权|命名|运维|安全)/iu;
const CODE_CHANGE_INTENT_RE = /(?:\b(?:add|change|edit|fix|implement|refactor|remove|write|test|build|release)\b|修改|修复|实现|重构|删除|编写|测试|构建|发布)/iu;

function promptText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.slice(-6).map(message => {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }).filter(Boolean).join('\n');
}

/**
 * Infer project-document scopes from the current task and concrete workspace
 * paths. The values are prompt-selection labels, not authorization scopes.
 */
export function inferProjectDocScopes({ prompt = '', messages = [], pathHints = [] } = {}) {
  const text = [promptText(messages), prompt, ...(Array.isArray(pathHints) ? pathHints : [])]
    .filter(Boolean)
    .join('\n');
  const scopes = new Set();
  for (const [scope, pattern] of Object.entries(SCOPE_PATTERNS)) {
    if (pattern.test(text)) scopes.add(scope);
  }
  if (CODE_CHANGE_INTENT_RE.test(text)) scopes.add('development');
  return scopes;
}

function splitProjectDoc(text) {
  const lines = String(text || '').split(/\r?\n/);
  const preamble = [];
  const sections = [];
  let current = null;
  let parentHeading = '';

  for (const line of lines) {
    const match = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      if (current) current.lines.push(line);
      else preamble.push(line);
      continue;
    }
    if (current) sections.push(current);
    const level = match[1].length;
    if (level === 2) parentHeading = match[2].trim();
    current = {
      level,
      heading: match[2].trim(),
      parentHeading: level > 2 ? parentHeading : '',
      lines: [line],
    };
  }
  if (current) sections.push(current);
  return { preamble: preamble.join('\n').trim(), sections };
}

function scopesForLabel(label) {
  const scopes = new Set();
  for (const [scope, pattern] of Object.entries(SCOPE_PATTERNS)) {
    if (pattern.test(label)) scopes.add(scope);
  }
  return scopes;
}

function sectionScopes(section) {
  const direct = scopesForLabel(section.heading);
  if (direct.size > 0 || !section.parentHeading) return direct;
  return scopesForLabel(section.parentHeading);
}

function isCoreSection(section) {
  return CORE_SECTION_RE.test(section.heading)
    || (section.parentHeading && CORE_SECTION_RE.test(section.parentHeading));
}

function renderProjectDocDirectory(omitted, language) {
  if (omitted.length === 0) return '';
  const zh = String(language || '').toLowerCase().startsWith('zh');
  const lines = [zh ? '## 可按需加载的项目规则' : '## Project Rules Available On Demand'];
  lines.push(zh
    ? '以下章节当前只列目录。运行时会在任务或文件路径涉及对应范围时自动载入正文；写入工具在相关规则尚未载入时必须先返回模型复核。'
    : 'Only the directory is shown for these sections. The runtime loads their bodies when the task or a concrete file path enters that scope; write tools must return for model review when applicable rules were not loaded yet.');
  for (const section of omitted) {
    const label = section.parentHeading
      ? `${section.parentHeading} / ${section.heading}`
      : section.heading;
    lines.push(`- ${label}`);
  }
  return lines.join('\n');
}

/**
 * Select the stable project core plus task/path-scoped sections. Small or
 * unstructured documents stay whole so progressive disclosure never drops
 * instructions from projects that have not adopted section headings.
 *
 * @returns {{ text: string, selectedScopes: Set<string>, availableScopes: Set<string>, scoped: boolean, hasUnscopedOmitted: boolean }}
 */
export function selectProjectDocContext(text, {
  prompt = '',
  messages = [],
  pathHints = [],
  forcedScopes = [],
  language = 'en',
} = {}) {
  const source = typeof text === 'string' ? text.trim() : '';
  const selectedScopes = inferProjectDocScopes({ prompt, messages, pathHints });
  for (const scope of forcedScopes || []) selectedScopes.add(scope);
  if (!source) return {
    text: '', selectedScopes, availableScopes: new Set(), scoped: false, hasUnscopedOmitted: false,
  };

  const parsed = splitProjectDoc(source);
  if (Buffer.byteLength(source, 'utf8') < PROJECT_DOC_SPLIT_MIN_BYTES || parsed.sections.length < 4) {
    return {
      text: source, selectedScopes, availableScopes: new Set(), scoped: false, hasUnscopedOmitted: false,
    };
  }

  const availableScopes = new Set();
  for (const section of parsed.sections) {
    for (const scope of sectionScopes(section)) availableScopes.add(scope);
  }

  const included = [];
  const omitted = [];
  for (const section of parsed.sections) {
    const scopes = sectionScopes(section);
    const selected = selectedScopes.has('*')
      || isCoreSection(section)
      || [...scopes].some(scope => selectedScopes.has(scope));
    (selected ? included : omitted).push(section);
  }

  const parts = [];
  if (parsed.preamble) parts.push(parsed.preamble);
  for (const section of included) parts.push(section.lines.join('\n').trim());
  const directory = renderProjectDocDirectory(omitted, language);
  if (directory) parts.push(directory);
  return {
    text: parts.filter(Boolean).join('\n\n'),
    selectedScopes,
    availableScopes,
    scoped: omitted.length > 0,
    hasUnscopedOmitted: omitted.some(section => sectionScopes(section).size === 0),
  };
}

// These tools manage runtime state, not project files. Do not confuse their
// side effects (or an Agent's target cwd) with a write in this workspace.
const PROJECT_DOC_LIFECYCLE_TOOLS = new Set([
  'Skill', 'EnterWorktree', 'ExitWorktree', 'AskUser', 'PresentResponse',
  'DiscoverTools', 'HistorySearch', 'ListTasks', 'ReadTaskLog', 'WaitTask',
  'CancelTask', 'SpawnAgent', 'Agent', 'UpdateAgent', 'PromptAgent', 'SendMessage',
  'WaitAgent', 'CloseAgent', 'ListAgents', 'RouteForward', 'CreateWorkItem', 'JsReplReset',
]);

/** Project-rule review is separate from tool caching/concurrency metadata. */
export function projectDocToolCallNeedsWriteReview(toolName, input = {}, readOnly = false) {
  if (readOnly || PROJECT_DOC_LIFECYCLE_TOOLS.has(toolName)) return false;
  if (toolName === 'NotebookEdit') return input?.action !== 'read';
  if (toolName === 'ImageGeneration') return Boolean(input?.output_path);
  if (toolName === 'Bash') {
    // Deliberately exact: no compound commands, substitutions, redirects or
    // arbitrary options. Everything else remains a potential write.
    const command = typeof input?.command === 'string' ? input.command.trim() : '';
    return !/^(?:pwd(?:[ \t]+-[LP])?|git[ \t]+status(?:[ \t]+--short)?)$/.test(command);
  }
  // FileWrite/FileEdit/ApplyPatch and unknown extension tools fail closed.
  return true;
}

/** Extract concrete workspace path hints, never shell code or lifecycle inputs. */
export function projectDocPathHintsFromToolCall(toolName, input = {}) {
  if (PROJECT_DOC_LIFECYCLE_TOOLS.has(toolName)) return [];
  const hints = [];
  for (const key of ['file_path', 'path', 'cwd', 'workDir', 'notebook_path', 'output_path']) {
    if (typeof input?.[key] === 'string' && input[key].trim()) hints.push(input[key].trim());
  }
  if (toolName === 'ApplyPatch' && typeof input?.patch === 'string') {
    // Include deletion targets too; +++ /dev/null has no destination path.
    for (const match of input.patch.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/gm)) {
      const path = match[1]?.trim();
      if (path && path !== '/dev/null') hints.push(path);
    }
  }
  return [...new Set(hints)];
}

export function projectDocWriteScopesNeedingReload(projectDocContext, pathHints) {
  const missing = new Set();
  if (!projectDocContext?.scoped) return missing;
  const required = inferProjectDocScopes({ pathHints });
  for (const scope of required) {
    if (projectDocContext.availableScopes.has(scope) && !projectDocContext.selectedScopes.has(scope)) {
      missing.add(scope);
    }
  }
  if (projectDocContext.hasUnscopedOmitted === true) missing.add('*');
  if (required.size > 0 || missing.size > 0) return missing;
  // Arbitrary shell commands cannot be classified by the bounded scope
  // vocabulary. Fail closed for writes by loading every omitted section.
  missing.add('*');
  return missing;
}

/**
 * Stat both candidate filenames in `workDir` and return whichever has the
 * newer mtime, or null when neither exists / workDir is unusable.
 *
 * Pure stat — does NOT read file contents. Returns a lightweight stat
 * record so the caller can compare against a cached `mtimeMs` before
 * deciding to re-read.
 *
 * @param {string} workDir
 * @param {{ secureWorkspace?: boolean }} [opts]
 * @returns {{ path: string, mtimeMs: number } | null}
 */
export function pickProjectDocFile(workDir, opts = {}) {
  if (typeof workDir !== 'string' || !workDir.trim()) return null;
  try {
    const dirStat = statSync(workDir);
    if (!dirStat.isDirectory()) return null;
  } catch {
    // Non-existent / permission-denied / not a path we can stat.
    return null;
  }

  let best = null;
  for (const name of PROJECT_DOC_FILENAMES) {
    let candidate;
    if (opts.secureWorkspace === true) {
      candidate = statWorkspaceFile(workDir, name);
    } else {
      const path = join(workDir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      candidate = { path, mtimeMs: stat.mtimeMs };
    }
    if (!candidate) continue;
    // Strict-greater so ties favor the order in PROJECT_DOC_FILENAMES.
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best;
}

/**
 * Read the picked project-doc file. Returns null when nothing is
 * eligible (no workDir, no file, empty contents after trim).
 *
 * Bounded I/O. We allocate `maxBytes + 1` bytes and `readSync` once —
 * never letting a runaway file balloon the agent's heap. The extra
 * byte tells us whether the file was actually larger (so we know to
 * warn about truncation).
 *
 * Codepoint-safe truncation. When we cut mid-byte inside a multi-byte
 * UTF-8 sequence (very likely for `zh-CN` docs), we walk back to the
 * last codepoint boundary before decoding, so the model sees clean
 * text instead of a trailing `U+FFFD` replacement character.
 *
 * @param {string} workDir
 * @param {{ maxBytes?: number, secureWorkspace?: boolean }} [opts]
 * @returns {{ path: string, mtimeMs: number, text: string } | null}
 */
export function readProjectDoc(workDir, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0
    ? opts.maxBytes
    : DEFAULT_PROJECT_DOC_MAX_BYTES;
  if (maxBytes === 0) return null;

  const picked = pickProjectDocFile(workDir, opts);
  if (!picked) return null;

  // Allocate one extra byte so a `bytesRead === maxBytes + 1` tells us
  // there's more content beyond the cap — i.e. the file was truncated.
  const cap = maxBytes + 1;
  let buffer;
  let bytesRead;
  if (opts.secureWorkspace === true) {
    const read = readWorkspaceFile(workDir, picked.path.slice(workDir.length + 1), { maxBytes });
    if (!read || read.mtimeMs !== picked.mtimeMs) return null;
    buffer = read.buffer;
    bytesRead = buffer.length;
  } else {
    buffer = Buffer.allocUnsafe(cap);
    let fd;
    bytesRead = 0;
    try {
      fd = openSync(picked.path, 'r');
      bytesRead = readSync(fd, buffer, 0, cap, 0);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  let useBytes = bytesRead;
  const truncated = bytesRead > maxBytes;
  if (truncated) {
    useBytes = maxBytes;
    // Walk back into the buffer until the cut isn't sitting in the
    // middle of a multi-byte UTF-8 sequence. Each continuation byte
    // matches the pattern `10xxxxxx` (0x80–0xBF). We scan back at most
    // 3 bytes — UTF-8 codepoints are ≤ 4 bytes total.
    let scan = 0;
    while (scan < 3 && useBytes > 0 && (buffer[useBytes] & 0xC0) === 0x80) {
      useBytes -= 1;
      scan += 1;
    }
  }

  const text = buffer.toString('utf8', 0, useBytes).trim();
  if (truncated) {
    console.warn(
      `[yeaft/project-doc] ${picked.path} exceeds ${maxBytes} bytes — truncated.`,
    );
  }
  if (!text) return null;
  return { path: picked.path, mtimeMs: picked.mtimeMs, text };
}
