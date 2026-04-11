/**
 * stop-hooks.js — Post-query lifecycle hooks
 *
 * Runs after each query loop completes:
 *   1. Persist messages to conversation/messages/
 *   2. Consolidate check (compact + extract) — only when budget exceeded
 *   3. Dream gate check (background)
 *   4. Increment dream query counter
 *
 * Reference: yeaft-unify-core-systems.md §4.4
 */

import { shouldConsolidate, consolidate } from './memory/consolidate.js';
import { checkDreamGate, incrementQueryCount, dream } from './memory/dream.js';

/**
 * Run all stop hooks after a query completes.
 *
 * @param {{
 *   yeaftDir: string,
 *   mode: string,
 *   conversationStore: import('./conversation/persist.js').ConversationStore,
 *   memoryStore: import('./memory/store.js').MemoryStore,
 *   adapter: object,
 *   config: object,
 *   messages?: object[],
 *   taskId?: string,
 *   workerId?: string,
 *   trace?: object,
 * }} context
 * @returns {Promise<StopHookResult>}
 */
export async function runStopHooks(context) {
  const {
    yeaftDir,
    mode,
    conversationStore,
    memoryStore,
    adapter,
    config,
    messages = [],
    taskId,
    trace,
  } = context;

  const result = {
    messagesPersisted: 0,
    consolidated: false,
    dreamTriggered: false,
    errors: [],
  };

  // Workers don't run stop hooks (they persist to task workers/ dir)
  if (mode === 'worker') {
    return result;
  }

  // 1. Persist latest messages
  try {
    if (conversationStore && messages.length > 0) {
      const recentMessages = messages.slice(-2); // last user + assistant pair
      for (const msg of recentMessages) {
        if (msg.role && msg.content) {
          conversationStore.append({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            mode,
            model: config.model,
          });
          result.messagesPersisted++;
        }
      }
    }
  } catch (err) {
    result.errors.push(`Persist failed: ${err.message}`);
  }

  // 2. Consolidate check (non-blocking, but awaited for correctness)
  try {
    if (conversationStore && memoryStore && adapter) {
      if (shouldConsolidate(conversationStore, config.messageTokenBudget)) {
        const consolidated = await consolidate({
          conversationStore,
          memoryStore,
          adapter,
          config,
          budget: config.messageTokenBudget,
        });
        result.consolidated = true;
        trace?.logEvent({
          eventType: 'consolidate',
          eventData: {
            archivedCount: consolidated.archivedCount,
            extractedEntries: consolidated.extractedEntries.length,
          },
        });
      }
    }
  } catch (err) {
    result.errors.push(`Consolidate failed: ${err.message}`);
  }

  // 3. Increment dream query counter
  try {
    if (yeaftDir) {
      incrementQueryCount(yeaftDir);
    }
  } catch (err) {
    result.errors.push(`Dream counter failed: ${err.message}`);
  }

  // 4. Dream gate check (fire-and-forget, background)
  try {
    if (yeaftDir && memoryStore && adapter) {
      const gate = checkDreamGate(yeaftDir);
      if (gate.shouldDream) {
        result.dreamTriggered = true;
        // Fire and forget — dream runs in background
        dream({
          yeaftDir,
          memoryStore,
          conversationStore,
          adapter,
          config,
        }).catch(err => {
          trace?.logEvent({
            eventType: 'dream_error',
            eventData: { error: err.message },
          });
        });
      }
    }
  } catch (err) {
    result.errors.push(`Dream gate check failed: ${err.message}`);
  }

  return result;
}

/**
 * @typedef {Object} StopHookResult
 * @property {number} messagesPersisted — how many messages were persisted
 * @property {boolean} consolidated — whether consolidation ran
 * @property {boolean} dreamTriggered — whether dream was triggered
 * @property {string[]} errors — any non-fatal errors
 */
