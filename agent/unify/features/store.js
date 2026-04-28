/**
 * store.js — File-system backed FeatureStore for Yeaft Unify.
 *
 * Persists features to ~/.yeaft/features/ with one folder per feature.
 * Layout:
 *   ~/.yeaft/features/
 *     index.md              — Feature index (auto-generated overview)
 *     plan.md               — Global plan text
 *     feat-abc12345/        — One folder per feature
 *       feature.md          — Feature metadata (YAML frontmatter + description)
 *       progress.md         — Progress log (append-only)
 *       memory.md           — Feature-specific context/notes
 *
 * NOTE (PR-1a refactor): renamed from TaskStore. Per project policy
 * (no aliases, no ambiguity), object field names were unified:
 *   parentTaskId    → parentFeatureId   (canonical parent ref)
 *   relatedTaskIds  → relatedFeatureIds
 *   primaryThreadId → primaryThreadId   (unchanged — thread system uses its own naming)
 *   members / initiator / groupId       (unchanged — group concept survives)
 *
 * Legacy `parentId` mirror field (Q3 backfill from task-299) was dropped
 * because no production data carried only the legacy field — the rework
 * landed before any users adopted Unify features at scale. Same reason:
 * the one-shot `#migrateParentTaskId` boot migration is removed.
 *
 * Member/event names: `task_member_added` → `feature_member_added`,
 * `task_member_removed` → `feature_member_removed`.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ─── YAML Frontmatter helpers ────────────────────────────────

/**
 * Serialize a feature object to YAML frontmatter + body for feature.md.
 * @param {object} feature
 * @returns {string}
 */
function serializeFeature(feature) {
  const fm = [
    '---',
    `id: ${feature.id}`,
    `title: ${feature.title}`,
    `status: ${feature.status}`,
    `priority: ${feature.priority || 'medium'}`,
  ];

  // Canonical parent ref. Single field — no legacy mirror.
  if (feature.parentFeatureId) fm.push(`parentFeatureId: ${feature.parentFeatureId}`);
  if (feature.primaryThreadId) fm.push(`primaryThreadId: ${feature.primaryThreadId}`);
  // Multi-VP collaboration protocol (R6, formerly task-334n):
  //   initiator — VP id that created the feature (fallback target for ACL).
  //   members   — explicit VP roster for the feature.
  //   groupId   — the group this feature belongs to (null for standalone).
  if (feature.initiator) fm.push(`initiator: ${feature.initiator}`);
  if (Array.isArray(feature.members) && feature.members.length) {
    fm.push(`members: [${feature.members.join(', ')}]`);
  }
  if (feature.groupId) fm.push(`groupId: ${feature.groupId}`);
  if (Array.isArray(feature.relatedFeatureIds) && feature.relatedFeatureIds.length) {
    fm.push(`relatedFeatureIds: [${feature.relatedFeatureIds.join(', ')}]`);
  }
  if (feature.createdAt) fm.push(`createdAt: ${feature.createdAt}`);
  if (feature.updatedAt) fm.push(`updatedAt: ${feature.updatedAt}`);

  fm.push('---');
  fm.push('');

  // Body: description + result
  const parts = [];
  if (feature.description) parts.push(feature.description);
  if (feature.result) {
    parts.push('');
    parts.push('## Result');
    parts.push(feature.result);
  }
  fm.push(parts.join('\n'));

  return fm.join('\n');
}

/**
 * Parse a feature.md file (YAML frontmatter + body) into a feature object.
 * @param {string} raw — File contents
 * @returns {object|null}
 */
function parseFeature(raw) {
  if (!raw || !raw.startsWith('---')) return null;

  const endIdx = raw.indexOf('---', 3);
  if (endIdx === -1) return null;

  const frontmatter = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 3).trim();

  const feature = {};

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (key === 'createdAt' || key === 'updatedAt') {
      feature[key] = parseInt(val, 10) || 0;
    } else if (key === 'members' || key === 'relatedFeatureIds') {
      feature[key] = val
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      feature[key] = val;
    }
  }

  if (!feature.id) return null;

  // Parse body: description and result
  const resultIdx = body.indexOf('## Result');
  if (resultIdx !== -1) {
    feature.description = body.slice(0, resultIdx).trim();
    feature.result = body.slice(resultIdx + '## Result'.length).trim();
  } else {
    feature.description = body;
  }

  // Normalize parentFeatureId. Null/"null" strings become real null.
  if (!feature.parentFeatureId || feature.parentFeatureId === 'null') {
    feature.parentFeatureId = null;
  }

  // primaryThreadId: null means "unbound / orphan" — do NOT default to 'main'.
  if (!feature.primaryThreadId || feature.primaryThreadId === 'null') {
    feature.primaryThreadId = null;
  }

  return feature;
}

// ─── Index generation ────────────────────────────────────────

/**
 * Generate index.md content from all features.
 * @param {Map<string, object>} features
 * @returns {string}
 */
function generateIndex(features) {
  const now = new Date().toISOString();
  const lines = [
    '---',
    `totalFeatures: ${features.size}`,
    `lastUpdated: ${now}`,
    '---',
    '# Feature Index',
    '',
    '| ID | Title | Status | Priority | Updated |',
    '|----|-------|--------|----------|---------|',
  ];

  // Sort: in_progress first, then pending, then others
  const ORDER = { in_progress: 0, pending: 1, blocked: 2, completed: 3, cancelled: 4 };
  const sorted = [...features.values()].sort(
    (a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5)
  );

  for (const f of sorted) {
    const date = f.updatedAt ? new Date(f.updatedAt).toISOString().slice(0, 10) : '-';
    lines.push(`| ${f.id} | ${f.title} | ${f.status} | ${f.priority || 'medium'} | ${date} |`);
  }

  return lines.join('\n') + '\n';
}

// ─── Progress log helpers ────────────────────────────────────

/**
 * Format a progress entry for appending to progress.md.
 * @param {string} note
 * @param {object} [meta]
 * @returns {string}
 */
function formatProgressEntry(note, meta = {}) {
  const now = new Date();
  const ts = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const lines = [`## ${ts}`];
  lines.push(`- ${note}`);
  if (meta.status) lines.push(`- Status: ${meta.status}`);
  if (meta.result) lines.push(`- Result: ${meta.result}`);
  lines.push('');
  return lines.join('\n');
}

// ─── FeatureStore ────────────────────────────────────────────

export class FeatureStore {
  /** @type {string} */
  #dir;
  /** @type {string} */
  #indexPath;
  /** @type {string} */
  #planPath;
  /** @type {Map<string, object>} */
  #features;
  /** @type {boolean} */
  #readOnly;
  /** @type {Array<(evt:any)=>void>} */
  #listeners;

  /**
   * @param {string} yeaftDir — Base ~/.yeaft directory
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(yeaftDir, opts = {}) {
    this.#dir = join(yeaftDir, 'features');
    this.#indexPath = join(this.#dir, 'index.md');
    this.#planPath = join(this.#dir, 'plan.md');
    this.#features = new Map();
    this.#readOnly = opts.readOnly || false;
    this.#listeners = [];

    // Ensure base directory exists
    if (!this.#readOnly) {
      if (!existsSync(this.#dir)) {
        try {
          mkdirSync(this.#dir, { recursive: true });
        } catch {
          this.#readOnly = true;
        }
      }
    }

    // Load existing features from disk
    this.#loadAll();
  }

  /** Number of features in the store. */
  get size() {
    return this.#features.size;
  }

  /**
   * Create a new feature. Creates its folder with feature.md, progress.md, memory.md.
   * @param {object} feature — Must have .id, .title, .status
   * @returns {object} The created feature
   */
  create(feature) {
    this.#features.set(feature.id, feature);

    if (!this.#readOnly) {
      const featureDir = join(this.#dir, feature.id);
      try {
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(join(featureDir, 'feature.md'), serializeFeature(feature), 'utf8');
        writeFileSync(join(featureDir, 'progress.md'), '# Progress Log\n\n', 'utf8');
        writeFileSync(join(featureDir, 'memory.md'), '# Feature Memory\n', 'utf8');
        this.#appendProgressInternal(feature.id, `Created feature: ${feature.title}`, { status: 'pending' });
        this.#updateIndex();
      } catch {
        // Best-effort write
      }
    }

    return feature;
  }

  /**
   * Update an existing feature.
   * @param {string} id
   * @param {object} updates
   * @returns {object|null} Updated feature, or null if not found
   */
  update(id, updates) {
    const feature = this.#features.get(id);
    if (!feature) return null;

    const oldStatus = feature.status;
    Object.assign(feature, updates, { updatedAt: Date.now() });

    if (!this.#readOnly) {
      try {
        const featureDir = join(this.#dir, id);
        writeFileSync(join(featureDir, 'feature.md'), serializeFeature(feature), 'utf8');

        // Log progress on status change
        if (updates.status && updates.status !== oldStatus) {
          this.#appendProgressInternal(id, `Status changed: ${oldStatus} → ${updates.status}`, updates);
        }
        this.#updateIndex();
      } catch {
        // Best-effort
      }
    }

    return feature;
  }

  /**
   * Add a VP member to a feature's collaboration roster.
   * Idempotent: adding an existing member is a no-op (no event emitted).
   * Returns `{ feature, added: boolean }`.
   *
   * If an `onEvent` callback was registered, emits a `feature_member_added`
   * event synchronously after the write:
   *   { type: 'feature_member_added', featureId, vpId, addedBy, members, ts }
   *
   * @param {string} id     — feature id
   * @param {string} vpId   — VP being added
   * @param {{ addedBy?: string }} [opts] — provenance: who triggered the add
   */
  addMember(id, vpId, opts) {
    const feature = this.#features.get(id);
    if (!feature) return { feature: null, added: false };
    if (!vpId || typeof vpId !== 'string') {
      throw new Error('addMember: vpId required (string)');
    }
    const members = Array.isArray(feature.members) ? feature.members.slice() : [];
    if (members.includes(vpId)) {
      return { feature, added: false };
    }
    members.push(vpId);
    this.update(id, { members });
    const addedBy = opts?.addedBy || null;
    this.#emit({
      type: 'feature_member_added',
      featureId: id,
      vpId,
      addedBy,
      members: members.slice(),
      ts: Date.now(),
    });
    return { feature: this.#features.get(id), added: true };
  }

  /**
   * Remove a VP member from a feature.
   * Idempotent: removing a non-member is a no-op (no event emitted).
   * Returns `{ feature, removed: boolean }`.
   * Emits `feature_member_removed` on successful removal.
   */
  removeMember(id, vpId) {
    const feature = this.#features.get(id);
    if (!feature) return { feature: null, removed: false };
    if (!vpId || typeof vpId !== 'string') {
      throw new Error('removeMember: vpId required (string)');
    }
    const members = Array.isArray(feature.members) ? feature.members.slice() : [];
    const idx = members.indexOf(vpId);
    if (idx === -1) return { feature, removed: false };
    members.splice(idx, 1);
    this.update(id, { members });
    this.#emit({
      type: 'feature_member_removed',
      featureId: id,
      vpId,
      members: members.slice(),
      ts: Date.now(),
    });
    return { feature: this.#features.get(id), removed: true };
  }

  /**
   * ACL — true iff `vpId` may read `otherFeatureId`'s memory/summary.
   * Pass grants when:
   *   - both features share the same non-null groupId, OR
   *   - members sets intersect on at least one vpId
   * Fail-closed: missing feature, missing groupId match, no intersection → false.
   *
   * @param {string} currentFeatureId — feature the caller is running in
   * @param {string} otherFeatureId   — feature whose data the caller wants to read
   * @param {string} [vpId]           — caller's vp id; if set, must also be
   *   a member of currentFeatureId (prevents stranger elevating via URL probe)
   * @returns {boolean}
   */
  canAccessRelated(currentFeatureId, otherFeatureId, vpId) {
    if (!currentFeatureId || !otherFeatureId || currentFeatureId === otherFeatureId) {
      return false;
    }
    const cur = this.#features.get(currentFeatureId);
    const other = this.#features.get(otherFeatureId);
    if (!cur || !other) return false;

    // If caller claims a vpId, they must be a member of the current feature
    // or its initiator. Otherwise this is a cross-context read — fail-closed.
    if (vpId) {
      const curMembers = Array.isArray(cur.members) ? cur.members : [];
      const isInsider = curMembers.includes(vpId) || cur.initiator === vpId;
      if (!isInsider) return false;
    }

    // Same-group rule.
    if (cur.groupId && other.groupId && cur.groupId === other.groupId) {
      return true;
    }

    // Members-intersection rule.
    const a = Array.isArray(cur.members) ? cur.members : [];
    const b = Array.isArray(other.members) ? other.members : [];
    if (a.length === 0 || b.length === 0) return false;
    const bSet = new Set(b);
    for (const v of a) if (bSet.has(v)) return true;
    return false;
  }

  /** Register an event listener (member events). */
  onEvent(fn) {
    if (typeof fn === 'function') this.#listeners.push(fn);
    return () => {
      const i = this.#listeners.indexOf(fn);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  #emit(evt) {
    for (const fn of this.#listeners) {
      try { fn(evt); } catch { /* listener failures must not corrupt store */ }
    }
  }

  /**
   * Get a feature by ID.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    return this.#features.get(id) || null;
  }

  /**
   * List features with optional filters.
   * @param {{ status?: string, priority?: string }} [filter]
   * @returns {object[]}
   */
  list(filter) {
    let results = [...this.#features.values()];
    if (filter?.status) results = results.filter(f => f.status === filter.status);
    if (filter?.priority) results = results.filter(f => f.priority === filter.priority);
    return results;
  }

  /**
   * Return features grouped as a tree. Features with no parent
   * (parentFeatureId == null) are "roots"; each non-root becomes a child
   * of its parent.
   *
   * @returns {{ roots: object[], orphans: object[] }}
   *   - roots   : features whose parentFeatureId is null
   *   - orphans : features whose parentFeatureId points to a missing id
   */
  tree() {
    const all = [...this.#features.values()];
    const byId = new Map(all.map(f => [f.id, f]));
    const roots = [];
    const orphans = [];
    for (const f of all) {
      if (!f.parentFeatureId) roots.push(f);
      else if (!byId.has(f.parentFeatureId)) orphans.push(f);
    }
    return { roots, orphans };
  }

  /**
   * Get progress log for a feature.
   * @param {string} id
   * @returns {string}
   */
  getProgress(id) {
    const path = join(this.#dir, id, 'progress.md');
    try {
      if (existsSync(path)) return readFileSync(path, 'utf8');
    } catch { /* */ }
    return '';
  }

  /**
   * Append a progress note to a feature's progress log.
   * @param {string} id
   * @param {string} note
   * @param {object} [meta]
   */
  appendProgress(id, note, meta = {}) {
    if (!this.#features.has(id)) return;
    this.#appendProgressInternal(id, note, meta);
  }

  /**
   * Get memory content for a feature.
   * @param {string} id
   * @returns {string}
   */
  getMemory(id) {
    const path = join(this.#dir, id, 'memory.md');
    try {
      if (existsSync(path)) return readFileSync(path, 'utf8');
    } catch { /* */ }
    return '';
  }

  /**
   * Update memory content for a feature.
   * @param {string} id
   * @param {string} content
   */
  updateMemory(id, content) {
    if (this.#readOnly || !this.#features.has(id)) return;
    try {
      writeFileSync(join(this.#dir, id, 'memory.md'), content, 'utf8');
    } catch { /* */ }
  }

  /**
   * Get current plan text.
   * @returns {string}
   */
  getPlan() {
    try {
      if (existsSync(this.#planPath)) return readFileSync(this.#planPath, 'utf8');
    } catch { /* */ }
    return '';
  }

  /**
   * Set plan text.
   * @param {string} text
   */
  setPlan(text) {
    if (this.#readOnly) return;
    try {
      writeFileSync(this.#planPath, text, 'utf8');
    } catch { /* */ }
  }

  // ─── Internal methods ──────────────────────────────────────

  /** Load all feature folders from disk. */
  #loadAll() {
    if (!existsSync(this.#dir)) return;
    let entries;
    try {
      entries = readdirSync(this.#dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('feat-')) continue;
      const featureMdPath = join(this.#dir, entry.name, 'feature.md');
      try {
        if (!existsSync(featureMdPath)) continue;
        const raw = readFileSync(featureMdPath, 'utf8');
        const feature = parseFeature(raw);
        if (feature && feature.id) {
          this.#features.set(feature.id, feature);
        }
      } catch {
        // Skip corrupt feature folders
      }
    }
  }

  /** Append to a feature's progress.md. */
  #appendProgressInternal(id, note, meta) {
    if (this.#readOnly) return;
    const path = join(this.#dir, id, 'progress.md');
    try {
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# Progress Log\n\n';
      writeFileSync(path, existing + formatProgressEntry(note, meta), 'utf8');
    } catch { /* */ }
  }

  /** Regenerate index.md from all features. */
  #updateIndex() {
    if (this.#readOnly) return;
    try {
      writeFileSync(this.#indexPath, generateIndex(this.#features), 'utf8');
    } catch { /* */ }
  }
}

// Exported for testing
export { serializeFeature as _serializeFeature, parseFeature as _parseFeature };
