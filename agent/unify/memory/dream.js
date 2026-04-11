/**
 * dream.js — Auto Dream system (memory maintenance)
 *
 * Dream is a background process that maintains memory quality.
 * 5 phases: Orient → Gather → Merge → Prune → Promote
 *
 * Gate conditions (all must be true):
 *   1. Time gate: ≥24h since last dream
 *   2. Activity gate: ≥5 queries since last dream
 *   3. Mutex: dream.lock not held
 *
 * Reference: yeaft-unify-core-systems.md §3.3
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { scanEntries, findStaleEntries, findDuplicateGroups, summarizeScan } from './scan.js';
import { MAX_ENTRIES } from './store.js';
import {
  buildOrientPrompt,
  buildGatherPrompt,
  buildMergePrompt,
  buildPrunePrompt,
  buildPromotePrompt,
} from './dream-prompt.js';

// ─── Constants ──────────────────────────────────────────────

/** Minimum hours between dreams. */
const DREAM_INTERVAL_HOURS = 24;

/** Minimum queries before a dream can trigger. */
const DREAM_MIN_QUERIES = 5;

/** Maximum LLM calls per dream (budget control). */
const MAX_DREAM_LLM_CALLS = 5;

// ─── Dream State Management ─────────────────────────────────

/**
 * Read dream state from dream/state.md.
 *
 * @param {string} yeaftDir — e.g. ~/.yeaft
 * @returns {{ lastDreamAt: string|null, queriesSinceDream: number, dreamCount: number }}
 */
export function readDreamState(yeaftDir) {
  const statePath = join(yeaftDir, 'dream', 'state.md');

  if (!existsSync(statePath)) {
    return { lastDreamAt: null, queriesSinceDream: 0, dreamCount: 0 };
  }

  const raw = readFileSync(statePath, 'utf8');
  const state = { lastDreamAt: null, queriesSinceDream: 0, dreamCount: 0 };

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'last_dream_at': state.lastDreamAt = value || null; break;
      case 'queries_since_dream': state.queriesSinceDream = parseInt(value, 10) || 0; break;
      case 'dream_count': state.dreamCount = parseInt(value, 10) || 0; break;
    }
  }

  return state;
}

/**
 * Write dream state to dream/state.md.
 *
 * @param {string} yeaftDir
 * @param {object} state
 */
export function writeDreamState(yeaftDir, state) {
  const dreamDir = join(yeaftDir, 'dream');
  if (!existsSync(dreamDir)) mkdirSync(dreamDir, { recursive: true });

  const content = [
    '---',
    `last_dream_at: ${state.lastDreamAt || ''}`,
    `queries_since_dream: ${state.queriesSinceDream || 0}`,
    `dream_count: ${state.dreamCount || 0}`,
    '---',
    '',
    '# Dream State',
    '',
    'This file tracks the dream system state. Do not edit manually.',
  ].join('\n');

  writeFileSync(join(dreamDir, 'state.md'), content, 'utf8');
}

/**
 * Increment the query counter (called after each query).
 *
 * @param {string} yeaftDir
 */
export function incrementQueryCount(yeaftDir) {
  const state = readDreamState(yeaftDir);
  state.queriesSinceDream++;
  writeDreamState(yeaftDir, state);
}

// ─── Gate Check ─────────────────────────────────────────────

/**
 * Check if dream should run.
 *
 * @param {string} yeaftDir
 * @returns {{ shouldDream: boolean, reason: string }}
 */
export function checkDreamGate(yeaftDir) {
  const state = readDreamState(yeaftDir);

  // Activity gate
  if (state.queriesSinceDream < DREAM_MIN_QUERIES) {
    return {
      shouldDream: false,
      reason: `Only ${state.queriesSinceDream}/${DREAM_MIN_QUERIES} queries since last dream`,
    };
  }

  // Time gate
  if (state.lastDreamAt) {
    const lastDream = new Date(state.lastDreamAt).getTime();
    const hoursSince = (Date.now() - lastDream) / (1000 * 60 * 60);
    if (hoursSince < DREAM_INTERVAL_HOURS) {
      return {
        shouldDream: false,
        reason: `Only ${Math.round(hoursSince)}h/${DREAM_INTERVAL_HOURS}h since last dream`,
      };
    }
  }

  // Mutex check
  const lockPath = join(yeaftDir, 'dream', 'dream.lock');
  if (existsSync(lockPath)) {
    // Check if lock is stale (> 30 min)
    try {
      const lockContent = readFileSync(lockPath, 'utf8');
      const lockTime = new Date(lockContent.trim()).getTime();
      if (Date.now() - lockTime < 30 * 60 * 1000) {
        return { shouldDream: false, reason: 'Dream is already running (lock held)' };
      }
      // Stale lock — proceed
    } catch {
      // Can't read lock — proceed
    }
  }

  return { shouldDream: true, reason: 'All gates passed' };
}

// ─── Dream Execution ────────────────────────────────────────

/**
 * Run the full Dream pipeline.
 *
 * @param {{
 *   yeaftDir: string,
 *   memoryStore: import('./store.js').MemoryStore,
 *   conversationStore?: import('../conversation/persist.js').ConversationStore,
 *   adapter: object,
 *   config: object,
 *   onPhase?: (phase: string, result: any) => void,
 * }} params
 * @returns {Promise<DreamResult>}
 */
export async function dream({ yeaftDir, memoryStore, conversationStore, adapter, config, onPhase }) {
  const lockPath = join(yeaftDir, 'dream', 'dream.lock');
  const dreamDir = join(yeaftDir, 'dream');

  // Acquire lock
  if (!existsSync(dreamDir)) mkdirSync(dreamDir, { recursive: true });
  writeFileSync(lockPath, new Date().toISOString(), 'utf8');

  const result = {
    phases: {},
    entriesCreated: 0,
    entriesDeleted: 0,
    entriesMerged: 0,
    profileUpdated: false,
    errors: [],
  };

  try {
    // ── Phase 1: Orient ──────────────────────────────────
    onPhase?.('orient', 'starting');
    const scan = scanEntries(memoryStore);
    const memorySummary = summarizeScan(scan);
    const profileContent = memoryStore.readProfile();

    const orientResult = await llmCall(adapter, config,
      'You are a memory maintenance assistant. Analyze memory state and return assessment as JSON.',
      buildOrientPrompt({ memorySummary, profileContent, entryCount: scan.totalEntries }),
    );
    result.phases.orient = orientResult;
    onPhase?.('orient', orientResult);

    // ── Phase 2: Gather ──────────────────────────────────
    onPhase?.('gather', 'starting');
    const recentCompact = conversationStore?.readCompactSummary() || '';

    // Load completed tasks (simplified — read from tasks/ if available)
    const completedTasks = loadCompletedTasks(yeaftDir);

    const gatherResult = await llmCall(adapter, config,
      'You are a memory gathering assistant. Identify new information to remember. Return JSON.',
      buildGatherPrompt({ recentCompact, completedTasks, orientResult }),
    );
    result.phases.gather = gatherResult;
    onPhase?.('gather', gatherResult);

    // ── Phase 3: Merge ───────────────────────────────────
    onPhase?.('merge', 'starting');
    const duplicateGroups = findDuplicateGroups(scan.entries);

    const mergeResult = await llmCall(adapter, config,
      'You are a memory merge assistant. Combine duplicate entries. Return JSON.',
      buildMergePrompt({ duplicateGroups, gatherResult }),
    );
    result.phases.merge = mergeResult;

    // Apply merges
    if (mergeResult?.merges) {
      for (const merge of mergeResult.merges) {
        if (merge.merged) {
          memoryStore.writeEntry(merge.merged);
          result.entriesCreated++;
        }
        if (merge.deleteOriginals) {
          for (const name of merge.deleteOriginals) {
            memoryStore.deleteEntry(name);
            result.entriesDeleted++;
          }
          result.entriesMerged += (merge.deleteOriginals?.length || 0);
        }
      }
    }

    // Write new entries from gather/merge
    if (mergeResult?.newEntries) {
      for (const entry of mergeResult.newEntries) {
        memoryStore.writeEntry(entry);
        result.entriesCreated++;
      }
    }

    // Apply updates
    if (mergeResult?.updates) {
      for (const update of mergeResult.updates) {
        const existing = memoryStore.readEntry(update.entryName);
        if (existing) {
          memoryStore.writeEntry({ ...existing, ...update.updates });
        }
      }
    }
    onPhase?.('merge', mergeResult);

    // ── Phase 4: Prune ───────────────────────────────────
    onPhase?.('prune', 'starting');
    const staleEntries = findStaleEntries(scan.entries);
    const currentCount = memoryStore.listEntries().length;

    const pruneResult = await llmCall(adapter, config,
      'You are a memory pruning assistant. Remove stale/low-value entries. Return JSON.',
      buildPrunePrompt({ staleEntries, entryCount: currentCount, maxEntries: MAX_ENTRIES }),
    );
    result.phases.prune = pruneResult;

    if (pruneResult?.toDelete) {
      for (const name of pruneResult.toDelete) {
        if (memoryStore.deleteEntry(name)) {
          result.entriesDeleted++;
        }
      }
    }
    onPhase?.('prune', pruneResult);

    // ── Phase 5: Promote ─────────────────────────────────
    onPhase?.('promote', 'starting');
    const updatedEntries = memoryStore.listEntries();
    const scopesSummary = summarizeScan(scanEntries(memoryStore));

    const promoteResult = await llmCall(adapter, config,
      'You are a memory promotion assistant. Find patterns and update profile. Return JSON.',
      buildPromotePrompt({ entries: updatedEntries, profileContent, scopesSummary }),
    );
    result.phases.promote = promoteResult;

    // Apply profile updates
    if (promoteResult?.profileUpdates) {
      for (const [section, lines] of Object.entries(promoteResult.profileUpdates)) {
        if (Array.isArray(lines)) {
          for (const line of lines) {
            memoryStore.addToSection(section, line);
          }
        }
      }
      result.profileUpdated = true;
    }

    // Write promoted entries
    if (promoteResult?.promotedEntries) {
      for (const entry of promoteResult.promotedEntries) {
        memoryStore.writeEntry(entry);
        result.entriesCreated++;
      }
    }

    // Delete entries that were promoted to profile
    if (promoteResult?.entriesToDelete) {
      for (const name of promoteResult.entriesToDelete) {
        if (memoryStore.deleteEntry(name)) {
          result.entriesDeleted++;
        }
      }
    }
    onPhase?.('promote', promoteResult);

    // Rebuild scopes after all changes
    memoryStore.rebuildScopes();

    // Update dream state
    const state = readDreamState(yeaftDir);
    state.lastDreamAt = new Date().toISOString();
    state.queriesSinceDream = 0;
    state.dreamCount = (state.dreamCount || 0) + 1;
    writeDreamState(yeaftDir, state);

    // Write dream log
    writeDreamLog(yeaftDir, result);

  } catch (err) {
    result.errors.push(err.message);
  } finally {
    // Release lock
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Make an LLM call and parse the JSON response.
 *
 * @param {object} adapter
 * @param {object} config
 * @param {string} system
 * @param {string} prompt
 * @returns {Promise<object|null>}
 */
async function llmCall(adapter, config, system, prompt) {
  try {
    const result = await adapter.call({
      model: config.model,
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4096,
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load completed tasks without summaries (for Dream Phase 2).
 *
 * @param {string} yeaftDir
 * @returns {object[]}
 */
function loadCompletedTasks(yeaftDir) {
  const tasksDir = join(yeaftDir, 'tasks');
  if (!existsSync(tasksDir)) return [];

  const tasks = [];
  try {
    const dirs = readdirSync(tasksDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const metaPath = join(tasksDir, dir.name, 'meta.md');
      if (!existsSync(metaPath)) continue;

      const raw = readFileSync(metaPath, 'utf8');
      // Quick parse for status and description
      if (raw.includes('status: completed')) {
        const descMatch = raw.match(/description:\s*(.+)/);
        const summaryPath = join(tasksDir, dir.name, 'summary.md');
        const hasSummary = existsSync(summaryPath);

        tasks.push({
          id: dir.name,
          description: descMatch ? descMatch[1].trim() : dir.name,
          hasSummary,
          summary: hasSummary ? readFileSync(summaryPath, 'utf8').slice(0, 500) : null,
        });
      }
    }
  } catch {
    // Tasks directory may not exist yet
  }

  return tasks;
}

/**
 * Write a dream log entry for debugging.
 *
 * @param {string} yeaftDir
 * @param {object} result
 */
function writeDreamLog(yeaftDir, result) {
  const logPath = join(yeaftDir, 'dream', 'last-dream.md');
  const content = [
    '---',
    `timestamp: ${new Date().toISOString()}`,
    `entries_created: ${result.entriesCreated}`,
    `entries_deleted: ${result.entriesDeleted}`,
    `entries_merged: ${result.entriesMerged}`,
    `profile_updated: ${result.profileUpdated}`,
    `errors: ${result.errors.length}`,
    '---',
    '',
    '# Last Dream Log',
    '',
    `Ran at ${new Date().toISOString()}`,
    '',
    '## Results',
    '',
    `- Created: ${result.entriesCreated} entries`,
    `- Deleted: ${result.entriesDeleted} entries`,
    `- Merged: ${result.entriesMerged} entries`,
    `- Profile updated: ${result.profileUpdated}`,
    '',
    result.errors.length > 0 ? `## Errors\n\n${result.errors.map(e => `- ${e}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  writeFileSync(logPath, content, 'utf8');
}

/**
 * @typedef {Object} DreamResult
 * @property {object} phases — results of each phase
 * @property {number} entriesCreated
 * @property {number} entriesDeleted
 * @property {number} entriesMerged
 * @property {boolean} profileUpdated
 * @property {string[]} errors
 */
