/**
 * parseMentions.js — client-side `@vpId` token extraction for task-334j.
 *
 * Pure function; no DOM, no store, no i18n. Mirrors the vpId shape rules
 * from `agent/unify/groups/ids.js#validateVpId` (strict whitelist: letters,
 * digits, `-`, `_`; max 40 chars; must NOT start with `_`; must NOT be all
 * digits; must NOT be a reserved id: all/user/system/everyone).
 *
 * The agent re-validates server-side (see `agent/unify/task-message.js`);
 * this client-side pass is a UX affordance — strip obvious non-mentions so
 * the `mentions` field sent on the wire is clean.
 *
 * Boundary rule (from task-334j spec §3): a candidate `@vpId` matches when
 * it is preceded by start-of-string, whitespace, or Unicode punctuation,
 * AND followed by end-of-string, whitespace, or Unicode punctuation. This
 * naturally rejects emails (`foo@bar.com` — no boundary before `@`) and
 * mid-word `@` (`a@b`).
 *
 * Dedup: `new Set(...)` preserves insertion order. Cap: 32 entries,
 * aligning with `MAX_TEXT_LENGTH`/§Δ26.3 envelope and the agent
 * validator's own slice(0, 32) post-filter.
 */
/** Reserved vpIds (must match agent/unify/groups/ids.js#RESERVED_VP_IDS). */
const RESERVED_VP_IDS = new Set(['all', 'user', 'system', 'everyone']);

const MENTION_RE = /(^|[\s\p{P}])@([A-Za-z0-9_-]{1,40})(?=$|[\s\p{P}])/gu;
const PURE_DIGITS_RE = /^[0-9]+$/;

/** Max number of mentions kept per message (R6 §Δ26.3 + agent §task-message). */
export const MAX_MENTIONS = 32;

/**
 * Decide whether a raw capture from MENTION_RE is a valid vpId per the
 * strict agent-side rules. Kept local so we don't pull the whole
 * validator module + its side-effect imports into hot input code.
 */
function isAcceptableMentionId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.length < 1 || id.length > 40) return false;
  if (id.startsWith('_')) return false;         // `_` prefix reserved
  if (PURE_DIGITS_RE.test(id)) return false;     // all-digit reserved
  if (RESERVED_VP_IDS.has(id.toLowerCase())) return false;  // all/user/system/everyone
  return true;
}

/**
 * Extract `@vpId` mentions from a block of text.
 *
 * @param {string} text
 * @returns {{ text: string, mentions: string[] }} Original text passthrough
 *   (no rewriting at this layer) + deduped mentions array (max 32).
 */
export function parseMentions(text) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', mentions: [] };
  }
  const seen = new Set();
  // Reset lastIndex just in case the regex has global state leakage
  // across calls (paranoia — `new` each call would be safer but we opt
  // for the hot-path perf and reset here).
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const id = m[2];
    if (!isAcceptableMentionId(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= MAX_MENTIONS) break;
  }
  return { text, mentions: Array.from(seen) };
}

export default parseMentions;
