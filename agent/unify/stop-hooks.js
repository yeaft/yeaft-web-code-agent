/**
 * stop-hooks.js — Post-query lifecycle hooks
 *
 * Runs after each query loop completes:
 *   1. Persist messages to conversation/messages/
 *
 * Consolidation (compact orchestrator) is driven by the engine itself
 * via `#maybeConsolidate`; the legacy LLM-driven `consolidate()` plus
 * entries-store extraction was retired in the H2-AMS rip.
 *
 * Dream V2 owns all background memory maintenance (scope summaries +
 * memory writes via dream-v2/session-wiring.js → createV2DreamScheduler).
 *
 * Reference: yeaft-unify-core-systems.md §4.4
 */

import { isPermissionError } from './init.js';

/** Track whether we've already warned about permission issues in stop hooks. */
let _permissionWarned = false;

/**
 * Run all stop hooks after a query completes.
 *
 * @param {{
 *   yeaftDir: string,
 *   mode: string,
 *   conversationStore: import('./conversation/persist.js').ConversationStore,
 *   adapter: object,
 *   config: object,
 *   primaryModel?: string,
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
    adapter,
    config,
    primaryModel,
    messages = [],
    taskId,
    trace,
    // Bug 6: groupId/threadId stamped on every persisted message so
    // history replay can route messages back into the originating group.
    groupId,
    threadId,
  } = context;

  // Model name for persisted messages: use primaryModel if provided, else config.model
  const persistModel = primaryModel || config?.model;

  const result = {
    messagesPersisted: 0,
    errors: [],
  };

  // Workers don't run stop hooks (they persist to task workers/ dir)
  if (mode === 'worker') {
    return result;
  }

  // 1. Persist latest messages
  //
  // task-fix: we must persist the complete new turn — including the
  // assistant's `toolCalls` and each paired `role:'tool'` result —
  // otherwise restoring history on session reload drops the pairing
  // and causes "No tool output found for function call" 400s on the
  // next chat-completions request. We walk back from the end of
  // `messages` to find the first `role:'user'` that marks the start
  // of the current turn, then persist everything from there forward.
  try {
    if (conversationStore && messages.length > 0) {
      // Find the start of the latest turn — the last `role:'user'`
      // message in the array. Everything from that index onward is
      // new this turn (user + assistant[+toolCalls] + tool results).
      let turnStart = messages.length - 1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'user') {
          turnStart = i;
          break;
        }
      }
      const recentMessages = messages.slice(turnStart);
      for (const msg of recentMessages) {
        if (!msg || !msg.role) continue;
        // Allow empty assistant content when toolCalls are present;
        // tool messages have content by construction.
        const hasContent =
          (typeof msg.content === 'string' && msg.content.length > 0) ||
          (msg.content && typeof msg.content !== 'string') ||
          (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) ||
          msg.role === 'tool';
        if (!hasContent) continue;

        const record = {
          role: msg.role,
          content: typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content ?? ''),
          mode,
          model: persistModel,
        };
        if (msg.toolCallId) record.toolCallId = msg.toolCallId;
        if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
          record.toolCalls = msg.toolCalls;
        }
        if (msg.isError) record.isError = true;
        // Bug 6: stamp groupId / threadId so replay can re-route by group.
        if (groupId) record.groupId = groupId;
        if (threadId) record.threadId = threadId;
        conversationStore.append(record);
        result.messagesPersisted++;
      }
    }
  } catch (err) {
    if (isPermissionError(err)) {
      if (!_permissionWarned) {
        result.errors.push('Cannot write to ~/.yeaft/ — check directory permissions');
        _permissionWarned = true;
      }
    } else {
      result.errors.push(`Persist failed: ${err.message}`);
    }
  }

  // 2. Consolidation is owned by the engine (#maybeConsolidate → compact
  //    orchestrator). Dream V2 owns background scope-memory maintenance
  //    via the session dream scheduler (createV2DreamScheduler).

  return result;
}

/**
 * @typedef {Object} StopHookResult
 * @property {number} messagesPersisted — how many messages were persisted
 * @property {string[]} errors — any non-fatal errors
 */
