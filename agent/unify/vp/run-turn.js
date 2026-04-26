/**
 * run-turn.js — execute one turn for a RoleInstance.
 *
 * A "turn" = consume one envelope from RoleInstance.inputQueue, build a
 * fresh system prompt (§8), call `engine.query({prompt, messages, signal})`,
 * accumulate the streamed text, and append the resulting assistant
 * message both to `ri.messages` (for next-turn context) and — if the
 * caller provides a GroupHandle — to the group's jsonl log via its
 * `appendMessage` API (§334b public surface; hard constraint c: we never
 * hand-write bytes).
 *
 * This is the canonical runner passed to `RoleInstance.drain(runner)`.
 * Tests substitute a fake engine via createEngineBinder to exercise the
 * drain loop / state machine without a live adapter.
 *
 * Streaming contract — event types handled (all optional; Engine.query is
 * the source of truth):
 *   { type: 'text',        text: string }          — accumulate
 *   { type: 'text_chunk',  text: string }          — accumulate
 *   { type: 'tool_call',   ... }                   — pass to onEvent
 *   { type: 'tool_end',    ... }                   — pass to onEvent
 *   { type: 'aborted',     reason }                — exit loop, throw AbortError
 *   { type: 'error',       error }                 — throw
 *   { type: 'turn_end',    ... }                   — exit loop
 *
 * Unknown event types are forwarded to `onEvent(evt)` if provided.
 */

import { buildSystemPrompt } from './system-prompt.js';

/**
 * Build the taskCtx opt for buildSystemPrompt. Pulls active tasks for the
 * VP's current group from the task store, plus the current task (if any).
 * Returns null if no taskStore is wired (legacy / tests).
 */
function collectTaskCtx({ taskStore, groupId, currentTaskId }) {
  if (!taskStore || !groupId) return null;
  let allTasks;
  try {
    allTasks = taskStore.list();
  } catch {
    return null;
  }
  if (!Array.isArray(allTasks)) return null;

  const inGroup = allTasks.filter(
    (t) => t && t.groupId === groupId && t.status !== 'completed' && t.status !== 'cancelled',
  );
  // Order by lastActivity / updatedAt desc so most-recent surface first.
  inGroup.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const activeTasks = inGroup.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    members: Array.isArray(t.members) ? t.members.slice() : [],
    initiator: t.initiator || null,
    lastActivityAt: t.updatedAt || t.createdAt || 0,
  }));

  let currentTask = null;
  if (currentTaskId) {
    const t = allTasks.find((x) => x && x.id === currentTaskId);
    if (t) {
      currentTask = {
        id: t.id,
        title: t.title,
        members: Array.isArray(t.members) ? t.members.slice() : [],
        initiator: t.initiator || null,
      };
    }
  }

  if (activeTasks.length === 0 && !currentTask) return null;
  return { activeTasks, currentTask };
}

/**
 * Build a runner suitable for RoleInstance.drain().
 *
 * @param {{
 *   binder: import('./engine-binding.js').createEngineBinder extends (...args:any)=>infer R ? R : never,
 *   registry?: import('./registry.js').Registry,
 *   group?: import('../groups/group-store.js').GroupHandle,  // optional persistence
 *   rosterMembers?: string[],
 *   capabilitiesLine?: string,
 *   onEvent?: (evt:any, ri:any) => void,
 *   buildPromptOverride?: typeof buildSystemPrompt,
 * }} deps
 */
export function createTurnRunner(deps = {}) {
  const {
    binder,
    registry,
    group,
    rosterMembers,
    capabilitiesLine,
    onEvent,
    buildPromptOverride,
    taskStore,             // R6 §6 trigger #6: enables task_ctx affiliation hint
  } = deps;

  if (!binder || typeof binder.bind !== 'function') {
    throw new Error('createTurnRunner: binder (from createEngineBinder) is required');
  }

  const buildPrompt = buildPromptOverride || buildSystemPrompt;

  /**
   * The actual runner. Called once per envelope by drain().
   *
   * @param {object} envelope   — { groupId, taskId, msg, trigger }
   * @param {import('./role-instance.js').RoleInstance} ri
   */
  return async function runOneTurn(envelope, ri) {
    if (!envelope || !envelope.msg) {
      throw new Error('runOneTurn: envelope.msg missing');
    }

    const engine = binder.bind(ri);

    // Fresh system prompt per turn — DYNAMIC section changes every turn.
    const taskCtx = collectTaskCtx({
      taskStore,
      groupId: ri.groupId,
      currentTaskId: envelope.taskId || null,
    });
    const systemPrompt = await buildPrompt(ri, {
      registry,
      rosterMembers,
      capabilitiesLine,
      runtimeCtx: {
        taskId: envelope.taskId || null,
        isDream: false,
      },
      taskCtx,
    });

    // Prompt text = inbound message body. Engine.query spec:
    //   { prompt, messages, signal, ... }
    // It prepends the system prompt via adapter-level wiring; we pass
    // `systemPrompt` as an explicit first message if the engine supports
    // it, else rely on the engine's own system injection. For §334c MVP
    // we pass systemPrompt as metadata on messages[0] and let the engine
    // decide — tests supply a fake engine that echoes back.
    const prompt = String(envelope.msg.text || '').trim();
    if (!prompt) {
      // No-op envelope (empty msg): record a stub and return.
      ri.messages.push({ role: 'user', text: '', ts: new Date().toISOString(), meta: envelope });
      return;
    }

    ri.messages.push({
      role: 'user',
      text: prompt,
      ts: envelope.msg.ts || new Date().toISOString(),
      from: envelope.msg.from || 'user',
      msgId: envelope.msg.id || null,
      trigger: envelope.trigger || null,
    });

    const signal = ri.abortController ? ri.abortController.signal : undefined;

    // Build prior-messages window for the engine — MVP: the last 20.
    const priorMessages = ri.messages.slice(-20);

    let accumulated = '';
    let aborted = false;
    let errored = null;

    const iterator = engine.query({
      prompt,
      messages: priorMessages,
      signal,
      systemPrompt,
      metadata: {
        vpId: ri.vpId,
        groupId: ri.groupId,
        taskId: envelope.taskId || null,
        turnId: `${ri.id}:${ri.turnCount}`,
      },
    });

    try {
      for await (const evt of iterator) {
        if (!evt || typeof evt !== 'object') continue;
        switch (evt.type) {
          case 'text':
          case 'text_chunk':
          case 'message':
            if (typeof evt.text === 'string') accumulated += evt.text;
            if (onEvent) try { onEvent(evt, ri); } catch { /* ignore */ }
            break;
          case 'aborted':
            aborted = true;
            if (onEvent) try { onEvent(evt, ri); } catch { /* ignore */ }
            break;
          case 'error':
            errored = evt.error instanceof Error ? evt.error : new Error(String(evt.error || 'engine error'));
            if (onEvent) try { onEvent(evt, ri); } catch { /* ignore */ }
            break;
          case 'turn_end':
            if (onEvent) try { onEvent(evt, ri); } catch { /* ignore */ }
            break;
          default:
            if (onEvent) try { onEvent(evt, ri); } catch { /* ignore */ }
        }
        if (aborted || errored) break;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        aborted = true;
      } else {
        errored = err;
      }
    }

    if (aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (errored) throw errored;

    // Record assistant reply (even if empty — the turn still counted).
    const assistantMsg = {
      role: 'assistant',
      text: accumulated,
      ts: new Date().toISOString(),
      from: ri.vpId,
      taskId: envelope.taskId || null,
    };
    ri.messages.push(assistantMsg);

    // Hard constraint (c): persistence goes through 334b's appendMessage.
    if (group && typeof group.appendMessage === 'function' && accumulated.trim()) {
      try {
        group.appendMessage({
          from: ri.vpId,
          role: 'assistant',
          text: accumulated,
          taskId: envelope.taskId || null,
          meta: { trigger: envelope.trigger || null, replyTo: envelope.msg.id || null },
        });
      } catch (err) {
        // Non-fatal: the in-memory message is still recorded on ri.messages.
        if (onEvent) try { onEvent({ type: 'persist_error', error: err }, ri); } catch { /* ignore */ }
      }
    }
  };
}
