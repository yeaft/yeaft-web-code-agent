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
import { pickEffort } from '../effort.js';
import {
  ensureLayout,
  renderIndex,
  readMemoryFile,
  writeMemoryFile,
  memoryDir,
} from './layout.js';
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

    // ── Phase 6: Classify (task-287) ─────────────────────
    // Maintain the new-layout classification files:
    //   - index.md                    (auto-regenerate from disk state)
    //   - user-preferences.md         (merge gather/promote preferences)
    //   - by-project/<slug>.md        (narrative summary per project)
    //   - by-topic/<slug>.md          (narrative summary per topic)
    //   - timeline/<YYYY-MM>.md       (monthly narrative digest)
    onPhase?.('classify', 'starting');
    try {
      ensureLayout(yeaftDir);
      const classifyResult = await runClassifyPhase({
        yeaftDir,
        memoryStore,
        adapter,
        config,
        gatherResult,
        promoteResult,
      });
      result.phases.classify = classifyResult;
      result.classified = classifyResult;
      onPhase?.('classify', classifyResult);
    } catch (err) {
      result.errors.push(`classify: ${err.message}`);
    }

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
      // task-327c: dream is self-reflective memory maintenance — flag 'max'
      // so supported models use the full thinking budget.
      effort: pickEffort({ scenario: 'dream' }),
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

// ─── Phase 6: Classify (task-287) ───────────────────────────

/**
 * Regenerate index.md, merge user-preferences.md, and generate narrative
 * classification files (by-project, by-topic, timeline).
 *
 * Strategy:
 *   1. Always regenerate index.md from current on-disk layout (cheap, no LLM).
 *   2. Extract preferences from gather/promote results and merge (deduped)
 *      into user-preferences.md. No LLM call — trust structured output.
 *   3. Group entries by scope (project slug), topic tag, and YYYY-MM of
 *      updated_at. For each group with ≥3 entries and no up-to-date file,
 *      call the main model once to produce a narrative summary. Caps:
 *      MAX_CLASSIFY_LLM_CALLS = 3 per dream.
 *
 * @param {{
 *   yeaftDir: string,
 *   memoryStore: import('./store.js').MemoryStore,
 *   adapter: object,
 *   config: object,
 *   gatherResult?: object,
 *   promoteResult?: object,
 * }} params
 * @returns {Promise<{ indexBytes: number, preferencesMerged: number, narrativeFiles: string[] }>}
 */
const MAX_CLASSIFY_LLM_CALLS = 3;

async function runClassifyPhase({ yeaftDir, memoryStore, adapter, config, gatherResult, promoteResult }) {
  const summary = { indexBytes: 0, preferencesMerged: 0, narrativeFiles: [] };

  // 1. Regenerate index.md
  const entryCount = memoryStore.listEntries().length;
  const indexText = renderIndex(yeaftDir, entryCount);
  writeMemoryFile(yeaftDir, 'index.md', indexText);
  summary.indexBytes = indexText.length;

  // 2. Merge preferences into user-preferences.md (deduped, no LLM call)
  const newPreferences = extractPreferences(gatherResult, promoteResult);
  if (newPreferences.length > 0) {
    const merged = mergePreferences(readMemoryFile(yeaftDir, 'user-preferences.md'), newPreferences);
    if (merged.changed) {
      writeMemoryFile(yeaftDir, 'user-preferences.md', merged.text);
      summary.preferencesMerged = merged.addedCount;
    }
  }

  // 3. Group entries for narrative generation
  const entries = memoryStore.listEntries();
  const byProject = groupByProject(entries);
  const byTopic = groupByTopic(entries);
  const byMonth = groupByMonth(entries);

  let llmCallsLeft = MAX_CLASSIFY_LLM_CALLS;

  for (const [slug, group] of Object.entries(byProject)) {
    if (llmCallsLeft <= 0) break;
    if (group.length < 3) continue;
    const relPath = `by-project/${slug}.md`;
    if (isFresh(yeaftDir, relPath, group)) continue;
    const narrative = await generateNarrative({ adapter, config, category: 'project', label: slug, entries: group });
    if (narrative) {
      writeMemoryFile(yeaftDir, relPath, narrative);
      summary.narrativeFiles.push(relPath);
      llmCallsLeft--;
    }
  }

  for (const [tag, group] of Object.entries(byTopic)) {
    if (llmCallsLeft <= 0) break;
    if (group.length < 3) continue;
    const relPath = `by-topic/${tag}.md`;
    if (isFresh(yeaftDir, relPath, group)) continue;
    const narrative = await generateNarrative({ adapter, config, category: 'topic', label: tag, entries: group });
    if (narrative) {
      writeMemoryFile(yeaftDir, relPath, narrative);
      summary.narrativeFiles.push(relPath);
      llmCallsLeft--;
    }
  }

  for (const [ym, group] of Object.entries(byMonth)) {
    if (llmCallsLeft <= 0) break;
    if (group.length < 3) continue;
    const relPath = `timeline/${ym}.md`;
    if (isFresh(yeaftDir, relPath, group)) continue;
    const narrative = await generateNarrative({ adapter, config, category: 'timeline', label: ym, entries: group });
    if (narrative) {
      writeMemoryFile(yeaftDir, relPath, narrative);
      summary.narrativeFiles.push(relPath);
      llmCallsLeft--;
    }
  }

  // Regenerate index once more so new narrative files appear in it
  const finalIndex = renderIndex(yeaftDir, entryCount);
  writeMemoryFile(yeaftDir, 'index.md', finalIndex);
  summary.indexBytes = finalIndex.length;

  return summary;
}

/**
 * Extract preference-like strings from gather/promote results.
 * @returns {string[]}
 */
function extractPreferences(gatherResult, promoteResult) {
  const out = [];
  const pushFrom = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) {
      if (!e) continue;
      if (e.kind === 'preference' && typeof e.content === 'string' && e.content.trim()) {
        out.push(e.content.trim());
      }
    }
  };
  pushFrom(gatherResult?.newEntries);
  pushFrom(promoteResult?.promotedEntries);
  // profileUpdates section `preferences`, if present
  const prefUpdates = promoteResult?.profileUpdates?.preferences;
  if (Array.isArray(prefUpdates)) {
    for (const line of prefUpdates) {
      if (typeof line === 'string' && line.trim()) out.push(line.trim());
    }
  }
  return out;
}

/**
 * Merge new preference lines into the existing user-preferences.md content.
 * Dedupes on normalized text (lowercase + collapsed whitespace).
 * @returns {{ text: string, changed: boolean, addedCount: number }}
 */
function mergePreferences(existing, newLines) {
  const header = '# User Preferences\n\n';
  const body = existing.trim().startsWith('# ')
    ? existing.replace(/^# [^\n]*\n+/, '')
    : existing;

  const existingLines = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
  const norm = (s) => s.replace(/^[-*]\s*/, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = new Set(existingLines.map(norm));

  let addedCount = 0;
  const added = [];
  for (const line of newLines) {
    const key = norm(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(`- ${line.replace(/^[-*]\s*/, '')}`);
    addedCount++;
  }

  if (addedCount === 0) return { text: existing, changed: false, addedCount: 0 };

  const allLines = [...existingLines, ...added];
  const text = header + allLines.join('\n') + '\n';
  return { text, changed: true, addedCount };
}

/**
 * Group entries by project scope (first segment, or last if starts with 'work/').
 */
function groupByProject(entries) {
  const out = {};
  for (const e of entries) {
    const scope = e.scope || '';
    if (!scope || scope === 'global') continue;
    const parts = scope.split('/').filter(Boolean);
    const slug = parts[parts.length - 1];
    if (!slug) continue;
    const safe = slug.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    if (!out[safe]) out[safe] = [];
    out[safe].push(e);
  }
  return out;
}

function groupByTopic(entries) {
  const out = {};
  for (const e of entries) {
    if (!Array.isArray(e.tags)) continue;
    for (const t of e.tags) {
      if (typeof t !== 'string' || !t.trim()) continue;
      const safe = t.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      if (!out[safe]) out[safe] = [];
      out[safe].push(e);
    }
  }
  return out;
}

function groupByMonth(entries) {
  const out = {};
  for (const e of entries) {
    const ts = e.updated_at || e.created_at;
    if (!ts) continue;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!out[ym]) out[ym] = [];
    out[ym].push(e);
  }
  return out;
}

/**
 * Returns true if the existing classification file is newer than all entries
 * in the group (within 1 hour tolerance). Avoids regenerating recently-written files.
 */
function isFresh(yeaftDir, relPath, group) {
  const fp = join(memoryDir(yeaftDir), relPath);
  if (!existsSync(fp)) return false;
  try {
    const stat = readFileSync(fp); // read to check existence, statless
    // Use latest entry updated_at as the "need" mark
    const latest = group.reduce((max, e) => {
      const t = new Date(e.updated_at || e.created_at || 0).getTime();
      return t > max ? t : max;
    }, 0);
    // Compare to file mtime via readdir; fallback to always-stale if unavailable
    // Simpler: read first line of file and see if "updated: <ts>" is after latest
    const firstLine = stat.toString('utf8').split('\n').slice(0, 5).join('\n');
    const m = firstLine.match(/updated:\s*(\S+)/);
    if (!m) return false;
    const fileTime = new Date(m[1]).getTime();
    return fileTime >= latest;
  } catch {
    return false;
  }
}

/**
 * Call the main model to produce a narrative summary of a group of entries.
 * @returns {Promise<string|null>}
 */
async function generateNarrative({ adapter, config, category, label, entries }) {
  const entryLines = entries.slice(0, 40).map(e => {
    const tags = (e.tags && e.tags.length) ? ` [${e.tags.join(', ')}]` : '';
    return `- (${e.kind}) ${e.name}${tags}: ${String(e.content || '').slice(0, 300)}`;
  }).join('\n');

  const system = `You are a memory classifier for an AI assistant. Write a concise narrative summary (Markdown, 200-600 words) of the given memory entries grouped by ${category}. Focus on patterns, user preferences, decisions, and lessons — not on listing each entry.`;

  const prompt = `Category: ${category}
Label: ${label}
Entry count: ${entries.length}

Entries:
${entryLines}

Write the narrative as Markdown with:
- A top heading (e.g. "# ${label}")
- A metadata line: \`updated: ${new Date().toISOString()}\`
- Then the narrative prose with short sub-sections as useful.`;

  try {
    const result = await adapter.call({
      model: config.model,
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
      // task-327c: dream narrative synthesis — same 'max' tier as the
      // dream phase above; both pass through dream's self-reflection loop.
      effort: pickEffort({ scenario: 'dream' }),
    });
    const text = (result?.text || '').trim();
    if (!text) return null;
    // Ensure the `updated:` marker is present so isFresh() can parse it
    if (!/updated:/.test(text.split('\n').slice(0, 5).join('\n'))) {
      return `# ${label}\n\nupdated: ${new Date().toISOString()}\n\n${text}\n`;
    }
    return text.endsWith('\n') ? text : text + '\n';
  } catch {
    return null;
  }
}

