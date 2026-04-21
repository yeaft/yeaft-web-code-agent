/**
 * migrate-r5-to-r6.js — task-334f §Δ23 migration stub.
 *
 * Legacy (R5): `~/.yeaft/memory/entries/<slug>.md` plus numeric shard files
 *              `memory-001.md`, `memory-002.md`, ...
 *
 * R6:          `~/.yeaft/memory/vp/<vpId>/memory-<semantic>.md`
 *              Semantic shards: skill / relations / lessons / preferences /
 *                               project-<slug>
 *
 * This slice (334f) only DEFINES the API surface and a dry-run classifier.
 * The actual batch migration runs in 334i; 334f does not mutate disk.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseEntry } from './store.js';
import { classifyLegacyEntryToShard } from './shard-store.js';

/**
 * Produce a migration plan without applying it.
 *
 * @param {string} legacyEntriesDir  e.g. ~/.yeaft/memory/entries
 * @returns {{
 *   totalEntries: number,
 *   plan: Array<{ slug: string, shard: string, kind: string, tags: string[] }>,
 *   byShard: Record<string, number>
 * }}
 */
export function planR5ToR6Migration(legacyEntriesDir) {
  if (!legacyEntriesDir || !existsSync(legacyEntriesDir)) {
    return { totalEntries: 0, plan: [], byShard: {} };
  }
  const files = readdirSync(legacyEntriesDir).filter(f => f.endsWith('.md'));
  const plan = [];
  const byShard = {};
  for (const file of files) {
    const raw = readFileSync(join(legacyEntriesDir, file), 'utf8');
    const entry = parseEntry(raw);
    if (!entry) continue;
    const shard = classifyLegacyEntryToShard(entry);
    plan.push({
      slug: file.replace(/\.md$/, ''),
      shard,
      kind: entry.kind || 'fact',
      tags: entry.tags || [],
    });
    byShard[shard] = (byShard[shard] || 0) + 1;
  }
  return { totalEntries: plan.length, plan, byShard };
}

/**
 * Apply the migration. STUB — 334i will fill in the body writer. 334f keeps
 * this function exported so downstream tests can assert the hook exists.
 *
 * @param {object} _opts  { legacyEntriesDir, targetDir, vpId, dryRun }
 */
export async function applyR5ToR6Migration(_opts) {
  throw new Error('applyR5ToR6Migration: not yet implemented (task-334i)');
}
