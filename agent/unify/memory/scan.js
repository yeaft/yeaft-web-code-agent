/**
 * scan.js — Memory header scanning and scope/tag matching
 *
 * Fast in-memory scanning of entry frontmatter for:
 * - Scope tree traversal
 * - Tag overlap scoring
 * - Kind-based filtering
 * - Stale entry detection (for Dream)
 *
 * Reference: yeaft-unify-core-systems.md §3.3, yeaft-unify-design.md §5.1
 */

import { KINDS, KIND_PRIORITY, IMPORTANCE_WEIGHT, getAncestorScopes } from './types.js';

// ─── Scan Results ──────────────────────────────────────────

/**
 * @typedef {Object} ScanResult
 * @property {object[]} entries — all parsed entries
 * @property {Map<string, number>} scopeCount — scope → entry count
 * @property {Map<string, number>} kindCount — kind → entry count
 * @property {Map<string, Set<string>>} tagIndex — tag → set of entry names
 * @property {number} totalEntries — total count
 */

/**
 * Scan all entries from a MemoryStore and build indexes.
 *
 * @param {import('./store.js').MemoryStore} memoryStore
 * @returns {ScanResult}
 */
export function scanEntries(memoryStore) {
  const entries = memoryStore.listEntries();

  const scopeCount = new Map();
  const kindCount = new Map();
  const tagIndex = new Map();

  for (const entry of entries) {
    // Scope count
    const scope = entry.scope || 'global';
    scopeCount.set(scope, (scopeCount.get(scope) || 0) + 1);

    // Kind count
    const kind = entry.kind || 'fact';
    kindCount.set(kind, (kindCount.get(kind) || 0) + 1);

    // Tag index
    const tags = entry.tags || [];
    for (const tag of tags) {
      const lowerTag = tag.toLowerCase();
      if (!tagIndex.has(lowerTag)) tagIndex.set(lowerTag, new Set());
      tagIndex.get(lowerTag).add(entry.name);
    }
  }

  return {
    entries,
    scopeCount,
    kindCount,
    tagIndex,
    totalEntries: entries.length,
  };
}

// ─── Scoring Functions ─────────────────────────────────────

/**
 * Score an entry for relevance to a query context.
 *
 * Scoring factors:
 *   - Scope match: exact=5, parent/child=3, global=1
 *   - Tag overlap: 2 per matching tag
 *   - Kind priority: see KIND_PRIORITY
 *   - Importance weight: see IMPORTANCE_WEIGHT
 *   - Frequency bonus: log2(frequency)
 *   - Recency bonus: entries updated in last 7 days get +2
 *
 * @param {object} entry — memory entry
 * @param {{ scope?: string, tags?: string[], preferKinds?: string[] }} context
 * @returns {number} — relevance score
 */
export function scoreEntry(entry, context = {}) {
  let score = 0;

  // Scope match
  if (context.scope && entry.scope) {
    if (entry.scope === context.scope) {
      score += 5; // exact match
    } else {
      const ancestors = getAncestorScopes(context.scope);
      if (ancestors.includes(entry.scope)) {
        score += 3; // ancestor match
      } else if (entry.scope.startsWith(context.scope + '/')) {
        score += 3; // descendant match
      } else if (entry.scope === 'global') {
        score += 1; // global fallback
      }
    }
  }

  // Tag overlap
  if (context.tags && context.tags.length > 0 && entry.tags) {
    const entryTags = new Set(entry.tags.map(t => t.toLowerCase()));
    for (const tag of context.tags) {
      if (entryTags.has(tag.toLowerCase())) {
        score += 2;
      }
    }
  }

  // Kind priority
  const kindPriority = KIND_PRIORITY[entry.kind] || 0;
  score += kindPriority * 0.5;

  // Preferred kinds bonus
  if (context.preferKinds && context.preferKinds.includes(entry.kind)) {
    score += 2;
  }

  // Importance weight
  const impWeight = IMPORTANCE_WEIGHT[entry.importance] || IMPORTANCE_WEIGHT.normal;
  score += impWeight * 0.5;

  // Frequency bonus (logarithmic)
  const freq = entry.frequency || 1;
  score += Math.log2(Math.max(freq, 1));

  // Recency bonus
  if (entry.updated_at) {
    const daysSince = (Date.now() - new Date(entry.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 7) score += 2;
    else if (daysSince <= 30) score += 1;
  }

  return score;
}

// ─── Stale Detection (for Dream) ────────────────────────────

/**
 * Find entries that are potentially stale.
 *
 * Stale criteria:
 * - context entries older than 30 days
 * - entries never recalled (frequency = 1) and older than 60 days
 * - relation entries older than 90 days
 *
 * @param {object[]} entries
 * @returns {object[]} — stale entries
 */
export function findStaleEntries(entries) {
  const now = Date.now();
  const stale = [];

  for (const entry of entries) {
    const updatedAt = entry.updated_at ? new Date(entry.updated_at).getTime() : 0;
    const daysSince = (now - updatedAt) / (1000 * 60 * 60 * 24);

    let isStale = false;

    // Context entries become stale fast
    if (entry.kind === 'context' && daysSince > 30) {
      isStale = true;
    }

    // Entries never recalled and old
    if ((entry.frequency || 1) <= 1 && daysSince > 60) {
      isStale = true;
    }

    // Relations are volatile
    if (entry.kind === 'relation' && daysSince > 90) {
      isStale = true;
    }

    if (isStale) {
      stale.push({ ...entry, _daysSinceUpdate: Math.round(daysSince) });
    }
  }

  return stale;
}

// ─── Duplicate Detection (for Dream Merge) ──────────────────

/**
 * Find groups of entries that are potentially duplicates.
 * Entries are grouped if they share ≥2 tags AND the same kind.
 *
 * @param {object[]} entries
 * @returns {object[][]} — groups of potentially duplicate entries
 */
export function findDuplicateGroups(entries) {
  const groups = [];
  const visited = new Set();

  for (let i = 0; i < entries.length; i++) {
    if (visited.has(i)) continue;

    const group = [entries[i]];
    const eTags = new Set((entries[i].tags || []).map(t => t.toLowerCase()));

    for (let j = i + 1; j < entries.length; j++) {
      if (visited.has(j)) continue;
      if (entries[i].kind !== entries[j].kind) continue;

      const jTags = new Set((entries[j].tags || []).map(t => t.toLowerCase()));
      let overlap = 0;
      for (const tag of eTags) {
        if (jTags.has(tag)) overlap++;
      }

      if (overlap >= 2) {
        group.push(entries[j]);
        visited.add(j);
      }
    }

    if (group.length > 1) {
      visited.add(i);
      groups.push(group);
    }
  }

  return groups;
}

// ─── Stats Summary ──────────────────────────────────────────

/**
 * Generate a text summary of memory state (for Dream prompts).
 *
 * @param {ScanResult} scan
 * @returns {string}
 */
export function summarizeScan(scan) {
  const lines = [];

  lines.push(`Total entries: ${scan.totalEntries}`);

  // Kind breakdown
  const kindLines = [];
  for (const kind of KINDS) {
    const count = scan.kindCount.get(kind) || 0;
    if (count > 0) kindLines.push(`${kind}: ${count}`);
  }
  if (kindLines.length > 0) {
    lines.push(`Kinds: ${kindLines.join(', ')}`);
  }

  // Scope breakdown (top 10)
  const scopeEntries = [...scan.scopeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (scopeEntries.length > 0) {
    lines.push('Top scopes:');
    for (const [scope, count] of scopeEntries) {
      lines.push(`  ${scope}: ${count}`);
    }
  }

  // Tag cloud (top 20)
  const tagEntries = [...scan.tagIndex.entries()]
    .map(([tag, names]) => [tag, names.size])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (tagEntries.length > 0) {
    lines.push(`Top tags: ${tagEntries.map(([t, c]) => `${t}(${c})`).join(', ')}`);
  }

  return lines.join('\n');
}
