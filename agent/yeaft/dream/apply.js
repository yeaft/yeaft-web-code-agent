/**
 * dream/apply.js.
 *
 * Execute one merged-target action: either UPDATE an existing scope's
 * memory.md/summary.md, or CREATE a new one (currently topic-only).
 *
 * The flow per target:
 *   1. snapshot existing files into .dream-bak/<ts>/<scope>/
 *   2. if total content fits, run UPDATE (or CREATE) once
 *   3. if it doesn't, batch the sources by group (segment.batchSourcesForApply)
 *      and chain the LLM calls — each batch's output becomes the next
 *      batch's `current memory.md`. The prompt threads "this is batch K
 *      of N" so the LLM doesn't think previous content was lost.
 *   4. write tmp + rename for memory.md and summary.md
 *   5. update the per-scope dream-state marker inside memory.md
 *
 * The LLM call is injected (`opts.llm`). Snapshots are injectable too
 * (`opts.snapshot`) to allow tests to skip the .dream-bak side-effect.
 */

import { promises as fsp } from 'fs';
import { join, dirname } from 'path';
import { inspect } from 'util';

import { writeMemory, writeSummary, readMemory, readSummary } from '../memory/store.js';
import { withDreamMarker } from './state.js';
import { batchSourcesForApply, needsBatchedApply, truncateMessage } from './segment.js';
import { snapshotScope } from './snapshot.js';
import { parseJsonSafe } from './triage.js';
import { render } from './prompts/index.js';

function malformedJsonError(message, raw) {
  const err = new Error(message);
  err.rawSnippet = rawResponseSnippet(raw);
  return err;
}

function rawResponseSnippet(raw) {
  if (typeof raw === 'string') return raw.slice(0, 1000);
  if (raw == null) return String(raw);
  return inspect(raw, { depth: 2, maxArrayLength: 10, breakLength: 120 }).slice(0, 1000);
}

function applySystem(language) {
  return String(language || '').toLowerCase().startsWith('zh')
    ? '你是梦境流水线的 Apply 阶段。你会根据最近的群组对话重写单个 scope 的 memory.md 和 summary.md。请只回复严格 JSON，不要输出说明文字或 markdown fence。memory_md 和 summary_md 的自然语言内容必须使用中文；JSON key、scope、schema 字段和代码标识符保持英文。'
    : 'You are the Apply stage of a dream pipeline. You rewrite a single scope\'s memory.md and summary.md based on recent group conversations. Reply with strict JSON only — no prose, no fences.';
}

/**
 * Build the UPDATE prompt body. Accepts the current scope state +
 * one or more `(sessionId, diff)` source blocks.
 *
 * @param {{
 *   target: string,
 *   memoryMd: string,
 *   summaryMd: string,
 *   sources: Array<{ sessionId: string, diff: Array<object> }>,
 *   batchInfo?: { index: number, total: number },
 * }} ctx
 */
export function buildUpdatePrompt(ctx) {
  const batchHeader = (ctx.batchInfo && ctx.batchInfo.total > 1)
    ? (String(ctx.language || '').toLowerCase().startsWith('zh')
      ? `这是第 ${ctx.batchInfo.index}/${ctx.batchInfo.total} 批。前面的批次已经合并进下面当前的 memory.md。\n`
      : `This is batch ${ctx.batchInfo.index} of ${ctx.batchInfo.total}.\nEarlier batches have already been folded into the current memory.md below.\n`)
    : '';
  const sources = renderSourceBlocks(ctx.sources, ctx.language);
  return render('update', {
    target: ctx.target,
    batchHeader,
    memoryMd: ctx.memoryMd || '',
    summaryMd: ctx.summaryMd || '',
    sources,
  }, { language: ctx.language });
}

/**
 * Build the CREATE prompt body. Used when a target scope does not yet
 * exist on disk (currently only topic/<...>).
 *
 * @param {{
 *   target: string,
 *   sources: Array<{ sessionId: string, diff: Array<object> }>,
 *   siblingTopics?: Array<{ path: string, summary: string }>,
 * }} ctx
 */
export function buildCreatePrompt(ctx) {
  const sources = renderSourceBlocks(ctx.sources, ctx.language);
  let siblingsBlock = '';
  if (ctx.siblingTopics && ctx.siblingTopics.length > 0) {
    const lines = [String(ctx.language || '').toLowerCase().startsWith('zh') ? '语气参考：同级/父级 topic 摘要：' : 'For tone reference, sibling/parent topic summaries:'];
    for (const t of ctx.siblingTopics) lines.push(`  - ${t.path}: ${oneLine(t.summary)}`);
    lines.push('');
    siblingsBlock = lines.join('\n');
  }
  return render('create', {
    target: ctx.target,
    sources,
    siblingsBlock,
  }, { language: ctx.language });
}

/**
 * Render a list of `(sessionId, diff)` source blocks for inclusion in the
 * update / create prompts. Single-source aware: omits leading blank line
 * if there's only one source, to keep small prompts compact.
 *
 * @param {Array<{ sessionId: string, diff: Array<object> }>} sources
 */
function renderSourceBlocks(sources, language) {
  const out = [];
  for (const src of (sources || [])) {
    out.push('');
    out.push(`[sessions/${src.sessionId}]`);
    for (const m of (src.diff || [])) {
      const head = `[${m.role || 'message'}${m.kind === 'overlap' ? (String(language || '').toLowerCase().startsWith('zh') ? '（已处理）' : ' (already processed)') : ''}]`;
      out.push(head);
      out.push(truncateMessage(m.body || ''));
    }
  }
  return out.join('\n').replace(/^\n/, '');
}

/**
 * Translate `target` like 'sessions/g-eng' to a Scope
 * understood by store. Throws if the path is malformed.
 *
 * @param {string} target
 * @returns {{ kind: string, id?: string, path?: string[] }}
 */
export function targetToScope(target) {
  if (!target || typeof target !== 'string') throw new Error('apply.targetToScope: target required');
  if (target === 'user') return { kind: 'user' };
  const segs = target.split('/').filter(Boolean);
  // Legacy scopes — explicitly rejected. Old data lives under .legacy/.
  if (segs[0] === 'group' || segs[0] === 'vp' || segs[0] === 'feature' || segs[0] === 'topic') {
    throw new Error(`apply.targetToScope: legacy root scope ${JSON.stringify(target)} rejected — use sessions/<sessionId>`);
  }
  if (segs[0] === 'sessions') {
    if (segs.length === 2) return { kind: 'session', id: segs[1] };
    if (segs.length === 3 && segs[2] === 'user') {
      return { kind: 'session-user', sessionId: segs[1] };
    }
    if (segs.length === 4 && segs[2] === 'vp') {
      return { kind: 'session-vp', sessionId: segs[1], id: segs[3] };
    }
    if (segs.length === 4 && segs[2] === 'feature') {
      return { kind: 'session-feature', sessionId: segs[1], id: segs[3] };
    }
    if (segs[2] === 'topic' && (segs.length === 4 || segs.length === 5)) {
      return { kind: 'session-topic', sessionId: segs[1], path: segs.slice(3) };
    }
  }
  if (segs[0] === 'chat') {
    if (segs.length === 2) return { kind: 'chat', id: segs[1] };
    if (segs.length === 4 && segs[2] === 'vp') {
      return { kind: 'chat-vp', chatId: segs[1], id: segs[3] };
    }
  }
  throw new Error(`apply.targetToScope: malformed target ${JSON.stringify(target)}`);
}

/**
 * Run a single merged-target apply. Returns a record of what happened
 * for the runner's debug-panel feed.
 *
 * @param {{
 *   target: string,
 *   kind: 'update'|'create',
 *   sources: Array<{ sessionId: string, diff: any }>,
 * }} merged
 * @param {{
 *   root: string,
 *   ts: string,                    // shared timestamp folder
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 *   limits?: { MAX_APPLY_TOKENS?: number },
 *   snapshot?: typeof snapshotScope,
 *   nowIso?: () => string,
 *   onProgress?: (event: object) => void,
 *   siblingTopicsFor?: (target: string) => Promise<Array<{path:string, summary:string}>>,
 * }} opts
 */
export async function applyMergedTarget(merged, opts) {
  if (!opts || !opts.root) throw new Error('apply.applyMergedTarget: opts.root required');
  if (!opts.llm) throw new Error('apply.applyMergedTarget: opts.llm required');
  const ts = opts.ts || new Date().toISOString().replace(/[:.]/g, '-');
  const snapFn = opts.snapshot || snapshotScope;
  const nowIso = opts.nowIso ? opts.nowIso() : new Date().toISOString();
  const scope = targetToScope(merged.target);
  const scopeDirRel = scopeRelDir(scope);

  if (opts.onProgress) opts.onProgress({ phase: 'apply', target: merged.target, status: 'snapshot' });
  await snapFn(opts.root, ts, scopeDirRel);

  let memoryMd = await readMemory(scope, { root: opts.root });
  let summaryMd = await readSummary(scope, { root: opts.root, language: opts.language });

  if (merged.kind === 'create' && (memoryMd || summaryMd)) {
    // Race / partial state: the scope already exists. Treat as update —
    // safer than overwriting arbitrary bytes.
    merged = { ...merged, kind: 'update' };
  }

  let batchesUsed = 0;
  const maxApply = (opts.limits && opts.limits.MAX_APPLY_TOKENS) || undefined;

  if (merged.kind === 'create') {
    const siblings = opts.siblingTopicsFor ? await opts.siblingTopicsFor(merged.target) : [];
    const prompt = buildCreatePrompt({
      target: merged.target,
      sources: merged.sources,
      siblingTopics: siblings,
      language: opts.language,
    });
    if (opts.onProgress) opts.onProgress({ phase: 'apply', target: merged.target, status: 'llm', batch: 1, of: 1 });
    const raw = await opts.llm({ pass: 'create', prompt, system: applySystem(opts.language) });
    const parsed = parseJsonSafe(raw);
    if (!parsed || typeof parsed.memory_md !== 'string') {
      throw malformedJsonError(`apply: CREATE returned malformed JSON for ${merged.target}`, raw);
    }
    memoryMd = parsed.memory_md;
    summaryMd = typeof parsed.summary_md === 'string' ? parsed.summary_md : '';
    batchesUsed = 1;
  } else {
    // UPDATE — possibly batched.
    const batches = needsBatchedApply(
      { memoryMd, summaryMd, sources: merged.sources },
      maxApply,
    )
      ? batchSourcesForApply({ memoryMd, summaryMd, sources: merged.sources }, maxApply)
      : [merged.sources];

    let i = 0;
    for (const batch of batches) {
      i += 1;
      const prompt = buildUpdatePrompt({
        target: merged.target,
        memoryMd,
        summaryMd,
        sources: batch,
        batchInfo: { index: i, total: batches.length },
        language: opts.language,
      });
      if (opts.onProgress) opts.onProgress({ phase: 'apply', target: merged.target, status: 'llm', batch: i, of: batches.length });
      const raw = await opts.llm({ pass: 'update', prompt, system: applySystem(opts.language) });
      const parsed = parseJsonSafe(raw);
      if (!parsed || typeof parsed.memory_md !== 'string') {
        throw malformedJsonError(`apply: UPDATE batch ${i} returned malformed JSON for ${merged.target}`, raw);
      }
      memoryMd = parsed.memory_md;
      if (typeof parsed.summary_md === 'string') summaryMd = parsed.summary_md;
    }
    batchesUsed = batches.length;
  }

  // Stamp the per-scope dream marker, then atomically write both files.
  const stamped = withDreamMarker(memoryMd, { lastDreamAt: nowIso });
  await writeMemory(scope, stamped, { root: opts.root });
  await writeSummary(scope, summaryMd || '', { root: opts.root, language: opts.language });

  if (opts.onProgress) {
    // feat-dream-debug-detail: surface a truncated copy of what was
    // actually written so the debug panel can show "what segments were
    // generated" instead of just "done". The full bytes are on disk
    // anyway — this preview is for at-a-glance debugging.
    opts.onProgress({
      phase: 'apply',
      target: merged.target,
      status: 'done',
      batches: batchesUsed,
      kind: merged.kind,
      memoryMdPreview: truncateForDebug(stamped),
      summaryMdPreview: truncateForDebug(summaryMd || ''),
      memoryMdLength: (stamped || '').length,
      summaryMdLength: (summaryMd || '').length,
    });
  }
  return { target: merged.target, kind: merged.kind, batches: batchesUsed };
}

// ─── helpers ──────────────────────────────────────────────────

function scopeRelDir(scope) {
  switch (scope.kind) {
    case 'user':          return 'user';
    case 'session':         return `sessions/${scope.id}`;
    case 'session-user':    return `sessions/${scope.sessionId}/user`;
    case 'session-vp':      return `sessions/${scope.sessionId}/vp/${scope.id}`;
    case 'session-feature': return `sessions/${scope.sessionId}/feature/${scope.id}`;
    case 'session-topic':   return `sessions/${scope.sessionId}/topic/${scope.path.join('/')}`;
    case 'chat':          return `chat/${scope.id}`;
    case 'chat-vp':       return `chat/${scope.chatId}/vp/${scope.id}`;
    default: throw new Error(`apply.scopeRelDir: unknown kind ${scope.kind}`);
  }
}

function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200); }

/**
 * Per-field truncation cap for debug previews emitted on `apply/done`.
 * Keep this small — the dream panel only needs a recognisable snippet.
 * Total worst-case payload is `PREVIEW_MAX * 2 * targets_per_run` per
 * dream pass; with N=50 targets that's ~200 KB. The full bytes are on
 * disk under <root>/<scope>/{memory,summary}.md anyway — these previews
 * are for at-a-glance debugging only.
 */
const PREVIEW_MAX = 2048;

/**
 * Truncate a markdown blob for inclusion in a debug-panel cell. Adds a
 * "…(+N chars)" marker so the user knows it was cut.
 */
function truncateForDebug(s, max = PREVIEW_MAX) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return str.slice(0, max) + `…(+${str.length - max} chars)`;
}
