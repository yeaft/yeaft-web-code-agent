/**
 * types.js — Memory type definitions and constants
 *
 * Defines the 3D memory model:
 *   Kind  = WHAT — 6 types: fact, preference, skill, lesson, context, relation
 *   Scope = WHERE — dynamic tree path: global / work/project / tech/typescript
 *   Tags  = HOW — free keywords for retrieval
 *
 * Reference: yeaft-unify-core-systems.md §2.2, yeaft-unify-brainstorm-v3.md
 */

// ─── Kind ────────────────────────────────────────────────────

/** All valid memory kinds. */
export const KINDS = ['fact', 'preference', 'skill', 'lesson', 'context', 'relation'];

/** Kind descriptions for prompt context. */
export const KIND_DESCRIPTIONS = {
  fact: 'Objective facts (project structure, tech stack, verified information)',
  preference: 'User preferences (coding style, tools, communication style)',
  skill: 'How to do something (patterns, techniques, workflows, commands)',
  lesson: 'Lessons learned (bugs, pitfalls, effective alternatives)',
  context: 'Temporal context (current OKR, project progress, deadlines)',
  relation: 'People and relationships (teammates, roles, responsibilities)',
};

/** Kind priority for dream consolidation (higher = more important). */
export const KIND_PRIORITY = {
  fact: 6,
  preference: 5,
  skill: 4,
  lesson: 3,
  context: 2,
  relation: 1,
};

// ─── Scope ──────────────────────────────────────────────────

/**
 * Parse a scope path into segments.
 * @param {string} scope — e.g. "work/claude-web-chat/auth"
 * @returns {string[]} — e.g. ["work", "claude-web-chat", "auth"]
 */
export function parseScopePath(scope) {
  if (!scope) return ['global'];
  return scope.split('/').filter(Boolean);
}

/**
 * Get all ancestor scopes (including the scope itself and 'global').
 * @param {string} scope — e.g. "work/claude-web-chat/auth"
 * @returns {string[]} — e.g. ["global", "work", "work/claude-web-chat", "work/claude-web-chat/auth"]
 */
export function getAncestorScopes(scope) {
  if (!scope || scope === 'global') return ['global'];

  const segments = parseScopePath(scope);
  const ancestors = ['global'];

  for (let i = 0; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'));
  }

  return ancestors;
}

/**
 * Check if two scopes are related (one is ancestor/descendant of the other).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function areScopesRelated(a, b) {
  if (!a || !b || a === 'global' || b === 'global') return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/') || a === b;
}

// ─── Importance ─────────────────────────────────────────────

/** Valid importance levels. */
export const IMPORTANCE_LEVELS = ['high', 'normal', 'low'];

/** Importance weight for scoring. */
export const IMPORTANCE_WEIGHT = {
  high: 3,
  normal: 2,
  low: 1,
};

// ─── Entry Schema ──────────────────────────────────────────

/**
 * @typedef {Object} MemoryEntry
 * @property {string} name — unique slug name
 * @property {string} kind — one of KINDS
 * @property {string} scope — tree path (e.g. "global", "tech/typescript")
 * @property {string[]} tags — free keywords
 * @property {string} importance — "high" | "normal" | "low"
 * @property {number} frequency — how often this entry is recalled
 * @property {string} content — the actual memory content
 * @property {string[]} [related] — related entry names
 * @property {string} [created_at] — ISO timestamp
 * @property {string} [updated_at] — ISO timestamp
 */

/**
 * Validate a memory entry object.
 * @param {object} entry
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEntry(entry) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }

  if (!entry.name || typeof entry.name !== 'string') {
    errors.push('Entry must have a string "name"');
  }

  if (entry.kind && !KINDS.includes(entry.kind)) {
    errors.push(`Invalid kind "${entry.kind}". Must be one of: ${KINDS.join(', ')}`);
  }

  if (entry.importance && !IMPORTANCE_LEVELS.includes(entry.importance)) {
    errors.push(`Invalid importance "${entry.importance}". Must be one of: ${IMPORTANCE_LEVELS.join(', ')}`);
  }

  if (!entry.content || typeof entry.content !== 'string') {
    errors.push('Entry must have string "content"');
  }

  if (entry.tags && !Array.isArray(entry.tags)) {
    errors.push('"tags" must be an array');
  }

  return { valid: errors.length === 0, errors };
}
