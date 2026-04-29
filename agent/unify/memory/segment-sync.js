/**
 * memory/segment-sync.js — disk → SQLite reconciliation.
 *
 * Source of truth is on-disk memory.md per scope. SQLite is a derived
 * index. This module reads disk, diffs against SQLite, and emits
 * upsert / delete operations.
 *
 * Strategy:
 *   - For each scope on disk: read all segments → upsert into index.
 *   - For ids that exist in index for that scope but no longer on
 *     disk: delete.
 *   - For scopes that exist in index but no longer on disk: deleteScope.
 *
 * Cost: O(N) read + O(N) upsert per call. Fine for boot-time and
 * post-Dream sync. For high-frequency syncs caller can pass a single
 * scope to limit work (`syncScope`).
 */

import { listScopes, readScope } from './segment-store.js';

/**
 * Full sync: walk disk, reconcile every scope into the index. Returns
 * counts for telemetry.
 *
 * @param {string} memoryRoot
 * @param {import('./index-db.js').SegmentIndex} index
 * @returns {{ scopes: number, upserted: number, deleted: number }}
 */
export function syncAll(memoryRoot, index) {
  const diskScopes = new Set(listScopes(memoryRoot));
  const indexScopes = new Set(allScopesFromIndex(index));

  let upserted = 0;
  let deleted = 0;

  for (const scope of diskScopes) {
    const r = syncScope(memoryRoot, index, scope);
    upserted += r.upserted;
    deleted += r.deleted;
  }

  // Scopes in index but not on disk → drop entirely.
  for (const scope of indexScopes) {
    if (!diskScopes.has(scope)) {
      const before = index.listByScope(scope).length;
      index.deleteScope(scope);
      deleted += before;
    }
  }

  return { scopes: diskScopes.size, upserted, deleted };
}

/**
 * Sync one scope. Reads disk, compares against index, applies upsert /
 * delete. Returns counts.
 *
 * @param {string} memoryRoot
 * @param {import('./index-db.js').SegmentIndex} index
 * @param {string} scope
 * @returns {{ upserted: number, deleted: number }}
 */
export function syncScope(memoryRoot, index, scope) {
  const onDisk = readScope(memoryRoot, scope);
  const onDiskIds = new Set(onDisk.map(s => s.id));
  const inIndex = index.listByScope(scope);
  const inIndexIds = new Set(inIndex.map(s => s.id));

  let upserted = 0;
  let deleted = 0;

  for (const seg of onDisk) {
    const existing = inIndex.find(e => e.id === seg.id);
    if (!existing
        || existing.body !== seg.body
        || existing.kind !== seg.kind
        || existing.updatedAt !== seg.updatedAt
        || !sameArr(existing.tags, seg.tags)
        || !sameArr(existing.sourceMessages, seg.sourceMessages)) {
      index.upsert(seg);
      upserted += 1;
    }
  }

  const toDelete = [];
  for (const id of inIndexIds) {
    if (!onDiskIds.has(id)) toDelete.push(id);
  }
  if (toDelete.length > 0) {
    index.deleteMany(toDelete);
    deleted = toDelete.length;
  }

  return { upserted, deleted };
}

function allScopesFromIndex(index) {
  // Cheap unique-scope query via the underlying db handle.
  const rows = index._db
    .prepare('SELECT DISTINCT scope FROM memory_segments')
    .all();
  return rows.map(r => r.scope);
}

function sameArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
