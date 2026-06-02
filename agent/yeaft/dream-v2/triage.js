/**
 * dream-v2/triage.js.
 *
 * Decide, for one group's diff, which scopes should be touched by Apply.
 * The decision is two-staged on purpose:
 *
 *   1. **Hard rules** (this module, no LLM): everything we can determine
 *      from message metadata. Always include the active group, every VP
 *      that spoke as an assistant in the diff, and `user` (so painted-over
 *      user-profile signals can't be missed). (Feature scope was dropped
 *      2026-05-13 along with the rest of the Feature system.)
 *
 *   2. **Soft classification** (LLM, two passes):
 *        Pass-1: high-recall — does the diff carry user-profile signal?
 *                              what topics (category-level) does it touch?
 *        Pass-2: high-precision — for each topic Pass-1 surfaced, bind
 *                              it to an exact existing path or propose
 *                              a new ≤2-level path.
 *
 *      VP / group are deliberately NOT asked of the LLM — Hard Rules
 *      already cover them, and giving the LLM a chance to drop a
 *      structurally-required scope would weaken the contract.
 *
 *      `user_profile_signals === true` does not need Pass-2 either: the
 *      Hard Rule already added `user` and Apply itself decides whether
 *      to actually rewrite anything (an UPDATE with no relevant content
 *      reads as a no-op rewrite of the existing memory).
 *
 * The LLM is injected as a callable: `llm({ pass, prompt, system })` →
 * Promise<string>. Tests pass a stub; runner injects the real adapter.
 *
 * The triage actions are unioned across segments when one group's diff
 * is split in segment.js — segment-level triage runs N times and the
 * caller dedupes. (Implemented as a thin wrapper `triageGroupSegments`
 * below.)
 */

import { isValidTopic } from '../memory/store-v2.js';
import { truncateMessage } from './segment.js';
import { render } from './prompts/index.js';

function triageSystem(language) {
  return String(language || '').toLowerCase().startsWith('zh')
    ? '你是梦境流水线的 Triage 阶段，负责判断最近的群组对话会影响哪些 scope。请只回复严格 JSON，不要输出说明文字或 markdown fence。自然语言内容使用中文；JSON key、scope 和枚举值保持英文。'
    : 'You are the Triage stage of a dream pipeline that decides which scopes a recent group conversation should affect. Reply with strict JSON only — no prose, no markdown fences.';
}

/**
 * Hard rules: deterministically derive must-include scopes from the
 * structure of the diff.
 *
 * Inputs:
 *   - groupId: the active group ('_no-group' is allowed and skips the
 *     `group/<id>` entry — by convention the virtual group has no scope
 *     of its own).
 *   - messages: the diff (already overlap-prefixed if applicable).
 *
 * @param {{ groupId: string, messages: Array<object> }} args
 * @returns {Array<{ kind: 'update', scope: string }>}
 */
export function applyHardRules({ groupId, messages }) {
  const out = new Map();
  const add = (scope) => { if (!out.has(scope)) out.set(scope, { kind: 'update', scope }); };

  // user is always in.
  add('user');

  // active group, except the virtual _no-group bucket.
  if (groupId && groupId !== '_no-group') add(`group/${groupId}`);

  for (const m of (messages || [])) {
    if (!m || typeof m !== 'object') continue;
    // Active VP: any assistant message's vpId.
    if (m.role === 'assistant') {
      const vp = m.vpId || (m.author && /^vp:(.+)$/.exec(m.author)?.[1]);
      if (vp && /^[A-Za-z0-9_\-.一-鿿]+$/.test(vp)) add(`vp/${vp}`);
    }
    // (Active feature scope was dropped 2026-05-13 with the Feature system.)
  }

  return Array.from(out.values());
}

// ─── soft classification ──────────────────────────────────────

/**
 * Build the prompt used for Pass-1.
 *
 * @param {{ groupId: string, messages: Array<object>, topicSummaries: Array<{ path: string, summary: string }> }} ctx
 */
export function buildPass1Prompt(ctx) {
  const topicSummaries = (!ctx.topicSummaries || ctx.topicSummaries.length === 0)
    ? (String(ctx.language || '').toLowerCase().startsWith('zh') ? '  （无）' : '  (none)')
    : ctx.topicSummaries.map(t => `  - ${t.path} — ${oneLine(t.summary)}`).join('\n');
  const conv = [];
  for (const m of (ctx.messages || [])) {
    const head = `[${m.role || 'message'}${m.kind === 'overlap' ? (String(ctx.language || '').toLowerCase().startsWith('zh') ? '（已处理）' : ' (already processed)') : ''}]`;
    conv.push(head);
    conv.push(truncateMessage(m.body || ''));
    conv.push('');
  }
  return render('triagePass1', {
    groupId: ctx.groupId,
    topicSummaries,
    conversation: conv.join('\n').trimEnd(),
  }, { language: ctx.language });
}

/**
 * Build the Pass-2 prompt for a single topic description.
 *
 * @param {{ description: string, existingTopics: Array<{ path: string, summary: string }> }} ctx
 */
export function buildPass2Prompt(ctx) {
  const existingTopics = (!ctx.existingTopics || ctx.existingTopics.length === 0)
    ? (String(ctx.language || '').toLowerCase().startsWith('zh') ? '  （无）' : '  (none)')
    : ctx.existingTopics.map(t => `  - ${t.path} — ${oneLine(t.summary)}`).join('\n');
  return render('triagePass2', {
    description: ctx.description,
    existingTopics,
  }, { language: ctx.language });
}

/**
 * Run soft classification for one segment of one group's diff.
 *
 * @param {{
 *   groupId: string,
 *   messages: Array<object>,
 *   topicSummaries: Array<{ path: string, summary: string }>,
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 * }} args
 * @returns {Promise<Array<{ kind: 'update'|'create', scope: string }>>}
 */
export async function classifySoft({ groupId, messages, topicSummaries, llm, language }) {
  if (!llm) throw new Error('triage.classifySoft: llm callable required');
  const pass1Prompt = buildPass1Prompt({ groupId, messages, topicSummaries, language });
  const pass1Raw = await llm({ pass: 'triage-pass1', prompt: pass1Prompt, system: triageSystem(language) });
  const pass1 = parseJsonSafe(pass1Raw);
  const out = [];

  // user_profile_signals: covered by hard rules; we only emit explicit
  // user action here when Pass-1 says yes (idempotent if hard rules
  // already added it).
  if (pass1 && pass1.user_profile_signals === true) {
    out.push({ kind: 'update', scope: 'user' });
  }

  const topicDescriptions = (pass1 && Array.isArray(pass1.topics)) ? pass1.topics : [];
  for (const description of topicDescriptions) {
    if (typeof description !== 'string' || !description.trim()) continue;
    const pass2Prompt = buildPass2Prompt({
      description: description.trim(),
      existingTopics: topicSummaries || [],
      language,
    });
    const pass2Raw = await llm({ pass: 'triage-pass2', prompt: pass2Prompt, system: triageSystem(language) });
    const pass2 = parseJsonSafe(pass2Raw);
    if (!pass2 || !pass2.decision) continue;
    if (pass2.decision === 'none') continue;
    const path = String(pass2.path || '').trim();
    if (!path) continue;
    const segs = path.split('/').filter(Boolean);
    if (!isValidTopic({ kind: 'topic', path: segs })) continue;
    const scope = `topic/${segs.join('/')}`;
    if (pass2.decision === 'match') {
      out.push({ kind: 'update', scope });
    } else if (pass2.decision === 'new') {
      out.push({ kind: 'create', scope });
    }
  }
  return out;
}

/**
 * Combine hard-rule and soft-classification results for one segment.
 * Dedupes by scope — `update` wins if any source said update.
 *
 * @param {{
 *   groupId: string,
 *   messages: Array<object>,
 *   topicSummaries: Array<{ path: string, summary: string }>,
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 * }} args
 * @returns {Promise<Array<{ kind: 'update'|'create', scope: string }>>}
 */
export async function triageOneSegment(args) {
  const hard = applyHardRules({ groupId: args.groupId, messages: args.messages });
  const soft = await classifySoft(args);
  return dedupeActions([...hard, ...soft]);
}

/**
 * Triage a group's diff that has already been split into N segments.
 * Runs each segment serially, accumulates and dedupes actions.
 *
 * @param {{
 *   groupId: string,
 *   segments: Array<{ messages: Array<object> }>,
 *   topicSummaries: Array<{ path: string, summary: string }>,
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 *   onProgress?: (event: object) => void,
 * }} args
 * @returns {Promise<Array<{ kind: 'update'|'create', scope: string }>>}
 */
export async function triageGroupSegments({ groupId, segments, topicSummaries, llm, onProgress, language }) {
  let acc = [];
  let i = 0;
  for (const seg of (segments || [])) {
    i += 1;
    if (onProgress) onProgress({ phase: 'triage', groupId, segment: i, total: segments.length });
    const segActions = await triageOneSegment({
      groupId,
      messages: seg.messages,
      topicSummaries,
      llm,
      language,
    });
    acc = dedupeActions([...acc, ...segActions]);
  }
  return acc;
}

// ─── helpers ──────────────────────────────────────────────────

function dedupeActions(list) {
  const map = new Map();
  for (const a of list) {
    if (!a || !a.scope) continue;
    const cur = map.get(a.scope);
    if (!cur) { map.set(a.scope, { ...a }); continue; }
    if (a.kind === 'update') cur.kind = 'update';
  }
  return Array.from(map.values());
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Lenient JSON parse: tolerate fenced ```json blocks. Returns null on failure. */
export function parseJsonSafe(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip markdown fences if present.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fenced) s = fenced[1].trim();
  try { return JSON.parse(s); }
  catch { /* try to recover the first {...} block */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); }
    catch { return null; }
  }
  return null;
}
