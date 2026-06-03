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
 * Reference: yeaft-yeaft-core-systems.md §4.4
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
 *   turnStartIdx?: number,
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
    // Reflect-persist fix: when the engine knows the exact turn boundary
    // (it does — `turnStartIdx` is set at query() entry as
    // `conversationMessages.length - 1`), pass it in. The legacy
    // heuristic of "scan back for the last role:'user'" is wrong once
    // T1/T2 reflection has collapsed the tool arc into a synthetic
    // role:'user' message — that synthetic message would be picked as
    // the turn start, dropping the original prompt AND any earlier
    // reflection messages from the persistence window.
    //
    // When undefined, falls back to the legacy heuristic so older
    // callers (sub-agents, workers) that don't pass it continue to
    // work.
    turnStartIdx,
    taskId,
    trace,
    // Bug 6: sessionId/threadId stamped on every persisted message so
    // history replay can route messages back into the originating group.
    sessionId,
    threadId,
    // Multi-VP fan-out (history-dedup): when several engines run the
    // same user prompt in parallel, the orchestrator persists the user
    // row exactly once before fan-out. Each VP's stop-hook then skips
    // the user record but still writes its own assistant + tool rows.
    userAlreadyPersisted = false,
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
  // next chat-completions request.
  //
  // Reflect-persist fix: prefer the explicit `turnStartIdx` from the
  // engine when given. The legacy heuristic of "find the last
  // role:'user'" is broken in the presence of T1/T2 reflection
  // collapse, because the collapsed reflection is itself a
  // role:'user' message — using it as the turn start would drop the
  // real user prompt and any earlier reflections.
  try {
    if (conversationStore && messages.length > 0) {
      let turnStart;
      if (typeof turnStartIdx === 'number'
          && Number.isFinite(turnStartIdx)
          && turnStartIdx >= 0
          && turnStartIdx < messages.length) {
        // Engine-supplied exact turn boundary — preferred.
        turnStart = turnStartIdx;
      } else {
        // Legacy heuristic — find the last role:'user' message.
        // Used by sub-agent / worker callers that don't compute the
        // boundary explicitly.
        turnStart = messages.length - 1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i] && messages[i].role === 'user') {
            turnStart = i;
            break;
          }
        }
      }
      const recentMessages = messages.slice(turnStart);
      for (const msg of recentMessages) {
        if (!msg || !msg.role) continue;
        // Skip the user row if the orchestrator already wrote it once for
        // this turn (multi-VP fan-out: every VP's engine sees the same
        // user prompt at conversationMessages[turnStart] but only the
        // first writer should land on disk).
        //
        // With the engine-supplied turnStartIdx, `messages[turnStart]`
        // is the ORIGINAL user prompt (not a reflection placeholder),
        // so the first message in `recentMessages` is the one that
        // gets skipped on subsequent VPs. Reflection messages that
        // come AFTER turnStart still have role:'user' — they are NOT
        // skipped because `userAlreadyPersisted` only suppresses the
        // first user-prompt copy; reflections are per-VP outputs and
        // each VP's reflections are valid contributions to the
        // shared history (this matches today's per-VP fan-out where
        // each VP appends its own assistant + tool rows).
        if (userAlreadyPersisted && msg.role === 'user' && msg === recentMessages[0]) continue;
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
        // Bug 6: stamp sessionId / threadId so replay can re-route by group.
        if (sessionId) record.sessionId = sessionId;
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
