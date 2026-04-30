/**
 * dream-v2/apply.js.
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

import { writeMemory, writeSummary, readMemory, readSummary } from '../memory/store-v2.js';
import { withDreamMarker } from './state.js';
import { batchSourcesForApply, needsBatchedApply, truncateMessage } from './segment.js';
import { snapshotScope } from './snapshot.js';
import { parseJsonSafe } from './triage.js';
import { render } from './prompts/index.js';

const SYSTEM = `You are the Apply stage of a dream pipeline. You rewrite a single scope's memory.md and summary.md based on recent group conversations. Reply with strict JSON only — no prose, no fences.`;

/**
 * Build the UPDATE prompt body. Accepts the current scope state +
 * one or more `(groupId, diff)` source blocks.
 *
 * @param {{
 *   target: string,
 *   memoryMd: string,
 *   summaryMd: string,
 *   sources: Array<{ groupId: string, diff: Array<object> }>,
 *   batchInfo?: { index: number, total: number },
 * }} ctx
 */
export function buildUpdatePrompt(ctx) {
  const batchHeader = (ctx.batchInfo && ctx.batchInfo.total > 1)
    ? `This is batch ${ctx.batchInfo.index} of ${ctx.batchInfo.total}.\nEarlier batches have already been folded into the current memory.md below.\n`
    : '';
  const sources = renderSourceBlocks(ctx.sources);
  return render('update', {
    target: ctx.target,
    batchHeader,
    memoryMd: ctx.memoryMd || '',
    summaryMd: ctx.summaryMd || '',
    sources,
  });
}

/**
 * Build the CREATE prompt body. Used when a target scope does not yet
 * exist on disk (currently only topic/<...>).
 *
 * @param {{
 *   target: string,
 *   sources: Array<{ groupId: string, diff: Array<object> }>,
 *   siblingTopics?: Array<{ path: string, summary: string }>,
 * }} ctx
 */
export function buildCreatePrompt(ctx) {
  const sources = renderSourceBlocks(ctx.sources);
  let siblingsBlock = '';
  if (ctx.siblingTopics && ctx.siblingTopics.length > 0) {
    const lines = ['For tone reference, sibling/parent topic summaries:'];
    for (const t of ctx.siblingTopics) lines.push(`  - ${t.path}: ${oneLine(t.summary)}`);
    lines.push('');
    siblingsBlock = lines.join('\n');
  }
  return render('create', {
    target: ctx.target,
    sources,
    siblingsBlock,
  });
}

/**
 * Render a list of `(groupId, diff)` source blocks for inclusion in the
 * update / create prompts. Single-source aware: omits leading blank line
 * if there's only one source, to keep small prompts compact.
 *
 * @param {Array<{ groupId: string, diff: Array<object> }>} sources
 */
function renderSourceBlocks(sources) {
  const out = [];
  for (const src of (sources || [])) {
    out.push('');
    out.push(`[group/${src.groupId}]`);
    for (const m of (src.diff || [])) {
      const head = `[${m.role || 'message'}${m.kind === 'overlap' ? ' (already processed)' : ''}]`;
      out.push(head);
      out.push(truncateMessage(m.body || ''));
    }
  }
  return out.join('\n').replace(/^\n/, '');
}

/**
 * Translate `target` like 'group/g-eng' or 'topic/sci/phys' to a Scope
 * understood by store-v2. Throws if the path is malformed.
 *
 * @param {string} target
 * @returns {{ kind: string, id?: string, path?: string[] }}
 */
export function targetToScope(target) {
  if (!target || typeof target !== 'string') throw new Error('apply.targetToScope: target required');
  if (target === 'user') return { kind: 'user' };
  const segs = target.split('/').filter(Boolean);
  const head = segs[0];
  if (head === 'vp' && segs.length === 2) return { kind: 'vp', id: segs[1] };
  if (head === 'group' && segs.length === 2) return { kind: 'group', id: segs[1] };
  if (head === 'feature' && segs.length === 2) return { kind: 'feature', id: segs[1] };
  if (head === 'topic' && (segs.length === 2 || segs.length === 3)) {
    return { kind: 'topic', path: segs.slice(1) };
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
 *   sources: Array<{ groupId: string, diff: any }>,
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
  let summaryMd = await readSummary(scope, { root: opts.root });

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
    });
    if (opts.onProgress) opts.onProgress({ phase: 'apply', target: merged.target, status: 'llm', batch: 1, of: 1 });
    const raw = await opts.llm({ pass: 'create', prompt, system: SYSTEM });
    const parsed = parseJsonSafe(raw);
    if (!parsed || typeof parsed.memory_md !== 'string') {
      throw new Error(`apply: CREATE returned malformed JSON for ${merged.target}`);
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
      });
      if (opts.onProgress) opts.onProgress({ phase: 'apply', target: merged.target, status: 'llm', batch: i, of: batches.length });
      const raw = await opts.llm({ pass: 'update', prompt, system: SYSTEM });
      const parsed = parseJsonSafe(raw);
      if (!parsed || typeof parsed.memory_md !== 'string') {
        throw new Error(`apply: UPDATE batch ${i} returned malformed JSON for ${merged.target}`);
      }
      memoryMd = parsed.memory_md;
      if (typeof parsed.summary_md === 'string') summaryMd = parsed.summary_md;
    }
    batchesUsed = batches.length;
  }

  // Stamp the per-scope dream marker, then atomically write both files.
  const stamped = withDreamMarker(memoryMd, { lastDreamAt: nowIso });
  await writeMemory(scope, stamped, { root: opts.root });
  await writeSummary(scope, summaryMd || '', { root: opts.root });

  if (opts.onProgress) opts.onProgress({ phase: 'apply', target: merged.target, status: 'done', batches: batchesUsed });
  return { target: merged.target, kind: merged.kind, batches: batchesUsed };
}

// ─── helpers ──────────────────────────────────────────────────

function scopeRelDir(scope) {
  switch (scope.kind) {
    case 'user':    return 'user';
    case 'vp':      return `vp/${scope.id}`;
    case 'group':   return `group/${scope.id}`;
    case 'feature': return `feature/${scope.id}`;
    case 'topic':   return `topic/${scope.path.join('/')}`;
    default: throw new Error(`apply.scopeRelDir: unknown kind ${scope.kind}`);
  }
}

function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200); }
