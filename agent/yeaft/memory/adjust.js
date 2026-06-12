/**
 * memory/adjust.js — DESIGN-H2-AMS §7. Post-turn LLM AMS adjustment.
 *
 * Pre-flow uses FTS keyword recall — fast but coarse. Some semantically
 * relevant segments will be missed; some FTS hits won't be relevant to
 * THIS turn. adjustMemory is the LLM-grade correction step:
 *
 *   - Sees the full visible memory (all reachable scopes, privacy-filtered).
 *   - Outputs `add` (segments to pull into AMS.onDemand that pre-flow missed)
 *     and `evict` (segments currently in AMS that this turn didn't need).
 *   - Does NOT modify segment bodies. Does NOT create new segments. Only
 *     manipulates AMS membership.
 *
 * Triggered conditionally — typical session shape is "hot turn skips,
 * adjust runs once per session or under budget pressure":
 *
 *   shouldRunAdjust =
 *        (!session.adjustRanThisSession)        // first-turn guarantee
 *     || (turnTokenUsage > totalBudget * 0.9)   // budget pressure
 *
 * The trigger lives at the call site (engine post-turn hook); this
 * module just exposes the policy + the LLM round-trip.
 *
 * task-710: the legacy `newMemoryWritten + onDemand >= 5` trigger was
 * dropped — dream writes happen async on a background timer, so the
 * caller had no good signal to pass and was hard-coding `false`. Adjust
 * now relies on first-turn-guarantee + budget-pressure only.
 */

import { approxTokens } from './budget.js';
import { isVpForeign } from './store.js';

/**
 * @typedef {object} AdjustTriggerInput
 * @property {number}  turnTokenUsage
 * @property {number}  totalBudget
 * @property {boolean} adjustRanThisSession
 */

/**
 * Pure decision function: should adjustMemory run this turn?
 *
 * @param {AdjustTriggerInput} input
 * @returns {{ run: boolean, reason: string }}
 */
export function shouldRunAdjust(input) {
  if (!input) return { run: false, reason: 'no input' };
  if (!input.adjustRanThisSession) {
    return { run: true, reason: 'first-turn-guarantee' };
  }
  if (input.turnTokenUsage > input.totalBudget * 0.9) {
    return { run: true, reason: 'budget-pressure' };
  }
  return { run: false, reason: 'no-trigger' };
}

/**
 * Build the candidate visible-segments list for the LLM, applying
 * privacy and a per-scope summarisation cap so prompts stay bounded.
 *
 * If a scope holds more than `bodyCap` segments, we replace each
 * segment body with its first sentence + tags (cheap summary). This
 * keeps the adjust prompt < ~10k tokens even when the user has
 * thousands of segments.
 *
 * @param {{
 *   index: import('./index-db.js').SegmentIndex,
 *   scopes: string[],
 *   ownVpId: string|null,
 *   currentAmsIds: Set<string>,
 *   bodyCap?: number,
 * }} args
 * @returns {Array<{
 *   id: string, scope: string, kind: string, tags: string[],
 *   body: string, inAMS: boolean, summarised: boolean,
 * }>}
 */
export function buildVisibleSegments(args) {
  const bodyCap = Number.isFinite(args.bodyCap) && args.bodyCap > 0
    ? args.bodyCap : 200;
  const visibleScopes = args.scopes.filter(s => isOwnOrNonVp(s, args.ownVpId));
  const out = [];
  for (const scope of visibleScopes) {
    const segs = args.index.listByScope(scope);
    const summarise = segs.length > bodyCap;
    for (const s of segs) {
      out.push({
        id: s.id,
        scope: s.scope,
        kind: s.kind,
        tags: s.tags || [],
        body: summarise ? firstSentence(s.body) : s.body,
        inAMS: args.currentAmsIds.has(s.id),
        summarised: summarise,
      });
    }
  }
  return out;
}

function firstSentence(body) {
  if (!body) return '';
  const m = /^([^.!?。！？\n]+[.!?。！？]?)/.exec(body.trim());
  return m ? m[1].trim() : body.slice(0, 200);
}

function isOwnOrNonVp(scope, ownVpId) {
  return !isVpForeign(scope, ownVpId);
}

/**
 * Build the prompt the LLM sees. Bilingual-friendly — the engine's
 * regular system prompt provides language; this is just the user-turn
 * payload.
 *
 * @param {object} args
 * @returns {string}
 */
export function buildAdjustPrompt(args) {
  const {
    userMsg, assistantReply, residentScopes, recentIds, onDemandIds,
    visibleSegments,
  } = args;

  const lines = [];
  lines.push('# AMS Adjustment Task');
  lines.push('');
  lines.push('You are managing the Active Memory Set (AMS) for the current session.');
  lines.push('Decide which memory segments should be ADDED to AMS.onDemand and which');
  lines.push('should be EVICTED, based on what this turn actually needed.');
  lines.push('');
  lines.push('## Current turn');
  lines.push('### user');
  lines.push(truncate(userMsg, 4000));
  lines.push('### assistant');
  lines.push(truncate(assistantReply, 4000));
  lines.push('');
  lines.push('## Current AMS state');
  lines.push(`resident scopes: ${residentScopes.join(', ') || '(none)'}`);
  lines.push(`recent ids: ${recentIds.slice(0, 50).join(', ') || '(none)'}`);
  lines.push(`onDemand ids: ${onDemandIds.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('## Visible memory segments');
  lines.push('Each row: [inAMS] id | scope | kind | tags | body');
  for (const seg of visibleSegments) {
    lines.push(
      `[${seg.inAMS ? 'X' : ' '}] ${seg.id} | ${seg.scope} | ${seg.kind} | ` +
      `${(seg.tags || []).join(',')} | ${truncate(seg.body, 240)}`,
    );
  }
  lines.push('');
  lines.push('## Output format');
  lines.push('Reply with a single JSON object on its own line:');
  lines.push('```json');
  lines.push('{ "add": ["seg_..."], "evict": ["seg_..."], "reason": "<one line>" }');
  lines.push('```');
  lines.push('Rules: use only ids from the visible list; never repeat an id in both');
  lines.push('arrays; keep evict ⊆ current onDemand; keep add ∩ current onDemand = ∅.');
  return lines.join('\n');
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Parse the LLM's reply. Tolerant: extracts the first JSON object,
 * coerces missing arrays to []. Returns null on hard parse failure.
 *
 * @param {string} replyText
 * @returns {{ add: string[], evict: string[], reason: string } | null}
 */
export function parseAdjustReply(replyText) {
  if (!replyText) return null;
  // Strip markdown fences
  const cleaned = replyText.replace(/^```(?:json)?\s*|\s*```$/gm, '').trim();
  // Find first { ... } JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const json = cleaned.slice(start, end + 1);
  let obj;
  try { obj = JSON.parse(json); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const add = Array.isArray(obj.add) ? obj.add.filter(s => typeof s === 'string') : [];
  const evict = Array.isArray(obj.evict) ? obj.evict.filter(s => typeof s === 'string') : [];
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { add, evict, reason };
}

/**
 * Apply an adjustment to AMS membership, with safety guards:
 *  - Drop add ids that aren't in the visible segment set.
 *  - Drop evict ids that aren't currently in onDemand.
 *  - Reject pathological replies (huge add / huge evict).
 *
 * @param {object} args
 * @param {import('./ams.js').ActiveMemorySet} args.ams
 * @param {import('./index-db.js').SegmentIndex} args.index
 * @param {{ add: string[], evict: string[] }} args.decision
 * @param {Set<string>} args.visibleIds
 * @param {number} [args.maxAdd]
 * @param {number} [args.maxEvict]
 * @returns {{ added: number, evicted: number, skipped: number }}
 */
export function applyAdjustment(args) {
  const maxAdd = args.maxAdd ?? 32;
  const maxEvict = args.maxEvict ?? 32;
  const currentOnDemand = new Set(args.ams.onDemandIds());
  const addIds = (args.decision.add || [])
    .filter(id => args.visibleIds.has(id) && !currentOnDemand.has(id))
    .slice(0, maxAdd);
  const evictIds = (args.decision.evict || [])
    .filter(id => currentOnDemand.has(id))
    .slice(0, maxEvict);
  const skipped =
    (args.decision.add?.length || 0) - addIds.length +
    (args.decision.evict?.length || 0) - evictIds.length;

  // Resolve add segments via the index
  const addSegs = [];
  for (const id of addIds) {
    const s = args.index.get(id);
    if (s) addSegs.push(s);
  }
  if (addSegs.length > 0) args.ams.addOnDemand(addSegs);
  if (evictIds.length > 0) args.ams.removeOnDemand(evictIds);

  return {
    added: addSegs.length,
    evicted: evictIds.length,
    skipped: Math.max(0, skipped),
  };
}

/**
 * Full round-trip: decide whether to run, build prompt, call LLM,
 * parse, apply. Returns telemetry counts.
 *
 * The caller supplies the LLM via `runLLM(prompt) → text` so this
 * module stays adapter-agnostic.
 *
 * @param {object} args
 * @param {AdjustTriggerInput} args.trigger
 * @param {import('./ams.js').ActiveMemorySet} args.ams
 * @param {import('./index-db.js').SegmentIndex} args.index
 * @param {string[]} args.scopes
 * @param {string|null} args.ownVpId
 * @param {string} args.userMsg
 * @param {string} args.assistantReply
 * @param {(prompt: string) => Promise<string>} args.runLLM
 * @returns {Promise<{
 *   ran: boolean, reason: string,
 *   added: number, evicted: number, skipped: number,
 *   promptTokens: number,
 * }>}
 */
export async function runAdjust(args) {
  const decision = shouldRunAdjust(args.trigger);
  if (!decision.run) {
    return { ran: false, reason: decision.reason, added: 0, evicted: 0, skipped: 0, promptTokens: 0 };
  }
  const currentAmsIds = new Set([
    ...args.ams.onDemandIds(),
    ...args.ams.recentIds(),
  ]);
  const visibleSegments = buildVisibleSegments({
    index: args.index, scopes: args.scopes, ownVpId: args.ownVpId,
    currentAmsIds,
  });
  const prompt = buildAdjustPrompt({
    userMsg: args.userMsg,
    assistantReply: args.assistantReply,
    residentScopes: args.ams.residentScopes(),
    recentIds: args.ams.recentIds(),
    onDemandIds: args.ams.onDemandIds(),
    visibleSegments,
  });
  const reply = await args.runLLM(prompt);
  const parsed = parseAdjustReply(reply);
  if (!parsed) {
    return {
      ran: true, reason: decision.reason + '+parse-fail',
      added: 0, evicted: 0, skipped: 0,
      promptTokens: approxTokens(prompt),
    };
  }
  const visibleIds = new Set(visibleSegments.map(s => s.id));
  const apply = applyAdjustment({
    ams: args.ams, index: args.index,
    decision: parsed, visibleIds,
  });
  return {
    ran: true, reason: decision.reason,
    ...apply,
    promptTokens: approxTokens(prompt),
  };
}
