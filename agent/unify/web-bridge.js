/**
 * web-bridge.js — Bridge between web UI and Yeaft Unify Engine.
 *
 * Translates Engine events into claude_output-format messages so the
 * frontend can fully reuse the standard Chat rendering pipeline
 * (MessageList, AssistantTurn, ToolLine, AskCard, waiting cat, etc.).
 *
 * Architecture:
 *   1. On first use, loadSession() initialises Engine with skills + MCP enabled.
 *   2. A virtual conversationId ('unify-<ts>') is assigned per session.
 *   3. Engine.query() yields events → translated into unify_output messages
 *      that carry { conversationId, data } in claude_output format.
 *   4. The frontend's handleUnifyOutput dispatches them through handleClaudeOutput.
 */

import { loadSession } from './session.js';
import { sendToServer } from '../connection/buffer.js';
import ctx from '../context.js';
import { getThreadStore, MAIN_THREAD_ID } from './threads/store.js';

/** @type {import('./session.js').Session | null} */
let session = null;

/**
 * task-320: per-thread in-flight AbortController registry.
 *
 * A new message only cancels the prior round on the SAME thread; a message
 * routed to a different thread runs concurrently without aliasing. Keyed by
 * the resolved `targetThreadId` from the dispatcher's `routing_decision`
 * event (we don't know the thread until the router has classified).
 *
 * @type {Map<string, AbortController>}
 */
const abortByThread = new Map();

/** Query timeout in ms — abort if LLM doesn't respond within this window */
const QUERY_TIMEOUT_MS = 120_000;

/** Virtual conversationId for the Unify session */
let unifyConversationId = null;

/**
 * task-320: per-thread accumulated conversation messages for context
 * continuity. Previously a single flat array — which cross-contaminated
 * history across threads. Keyed by threadId. Cleared on session reset or
 * by a `consolidate` event for that thread only.
 *
 * @type {Map<string, Array<{role: 'user'|'assistant', content: string|Array}>>}
 */
const messagesByThread = new Map();

function getThreadMessages(threadId) {
  if (!threadId) return [];
  let arr = messagesByThread.get(threadId);
  if (!arr) { arr = []; messagesByThread.set(threadId, arr); }
  return arr;
}

/** Whether we've already sent a permission warning to the UI */
let _permissionDiagnosticSent = false;

/**
 * Check if an error message is a permission error.
 * @param {string} msg
 * @returns {boolean}
 */
function isPermissionErrorMsg(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied');
}

/**
 * Send a unify_output message carrying claude_output-format data.
 * The server forwards this as-is to the web client.
 * The frontend's handleUnifyOutput will dispatch via handleClaudeOutput.
 */
function sendUnifyOutput(data) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    data,
  });
}

/**
 * Send a unify_output event (non-claude_output metadata).
 */
function sendUnifyEvent(event) {
  sendToServer({
    type: 'unify_output',
    conversationId: unifyConversationId,
    event,
  });
}

/**
 * task-318 rev-1 fix: install live-setter bridge between the session's
 * runtime handles (engineRegistry + threadStore) and `ctx.unifyRuntimeSettings`,
 * which message-router's `update_unify_settings` branch reads. Previously
 * that object was null and the setters were dead code. Now every
 * `update_unify_settings` mutation pushes the new caps into the live
 * session within the same tick — no reload required.
 *
 * Exported so tests can drive the same wiring with a mock session.
 *
 * @param {import('./session.js').Session} s
 */
export function installUnifyRuntimeBridge(s) {
  if (!s) return;
  const initialMax = s.engineRegistry?.maxConcurrent ?? null;
  const initialIdle = s.threadStore?.idleArchiveDays ?? 0;
  ctx.unifyRuntimeSettings = {
    get maxConcurrentThreads() { return s.engineRegistry?.maxConcurrent ?? initialMax; },
    set maxConcurrentThreads(v) {
      if (typeof s.engineRegistry?.setMaxConcurrent === 'function') {
        s.engineRegistry.setMaxConcurrent(v);
      }
    },
    get autoArchiveIdleDays() { return s.threadStore?.idleArchiveDays ?? initialIdle; },
    set autoArchiveIdleDays(v) {
      if (typeof s.threadStore?.setIdleArchiveDays === 'function') {
        s.threadStore.setIdleArchiveDays(v);
      }
      // task-317: re-sweep right after the cap changes so a user who
      // lowers the threshold sees stale threads disappear immediately
      // rather than having to wait for the hourly tick.
      runAutoArchiveSweep(s);
    },
  };
}

/**
 * task-317: idle thread auto-archive.
 *
 * A single sweep = ask the ThreadStore to archive every non-main,
 * non-archived thread whose last activity predates the configured idle
 * window. When any thread is archived we push a fresh `thread_list_updated`
 * so the sidebar reflects reality within the same tick.
 *
 * Safe on stores with `idleArchiveDays === 0` (returns no-op) and on
 * sessions missing a threadStore handle (defensive; should never happen
 * once `installUnifyRuntimeBridge` has run).
 *
 * @param {import('./session.js').Session|null} s
 * @returns {string[]} archived thread ids (empty when nothing changed)
 */
export function runAutoArchiveSweep(s) {
  try {
    const store = s?.threadStore ?? (typeof getThreadStore === 'function' ? getThreadStore() : null);
    if (!store || typeof store.runArchivePass !== 'function') return [];
    const { archived } = store.runArchivePass();
    if (archived && archived.length > 0) {
      sendThreadListUpdate();
    }
    return archived || [];
  } catch (err) {
    console.warn('[Unify] runAutoArchiveSweep failed:', err?.message || err);
    return [];
  }
}

/**
 * task-317: schedule the hourly auto-archive tick bound to the given
 * session. Returns the `Timeout` handle so tests can assert / clear it.
 * Re-calling replaces any prior timer (idempotent per-session).
 *
 * The timer is `unref()`'d so a pending tick never keeps the Node loop
 * alive during shutdown; an explicit `clearAutoArchiveSchedule()` is
 * provided for tests.
 */
let autoArchiveTimer = null;
const AUTO_ARCHIVE_TICK_MS = 60 * 60 * 1000; // 1h

export function scheduleAutoArchive(s, { intervalMs = AUTO_ARCHIVE_TICK_MS } = {}) {
  if (autoArchiveTimer) {
    clearInterval(autoArchiveTimer);
    autoArchiveTimer = null;
  }
  if (!s) return null;
  autoArchiveTimer = setInterval(() => {
    runAutoArchiveSweep(s);
  }, intervalMs);
  if (autoArchiveTimer && typeof autoArchiveTimer.unref === 'function') {
    autoArchiveTimer.unref();
  }
  return autoArchiveTimer;
}

export function clearAutoArchiveSchedule() {
  if (autoArchiveTimer) {
    clearInterval(autoArchiveTimer);
    autoArchiveTimer = null;
  }
}

/**
 * task-301 Part 2: push the full thread list snapshot to the web client.
 * Called after any ThreadStore-mutating tool completes and at turn_end so
 * the sidebar V2 always shows a fresh picture. Cheap — ThreadStore keeps
 * cached counters so list() is O(n) over a small n.
 */
function sendThreadListUpdate() {
  try {
    const store = getThreadStore();
    const threads = store.list().map(t => ({
      id: t.id,
      name: t.name,
      goal: t.goal || '',
      parentThreadId: t.parentThreadId || null,
      status: t.status,
      archived: !!t.archived,
      messageCount: t.messageCount || 0,
      lastMessageAt: t.lastMessageAt || null,
      lastActivityAt: t.lastActivityAt || t.lastMessageAt || t.updatedAt || null,
      unread: t.unread || 0,
      preview: t.preview || '',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      // task-315: attached taskId (if any) so the UI can aggregate all
      // messages belonging to a task across multiple threads. null when
      // the thread has no attached task.
      taskId: (typeof store.attachedTask === 'function')
        ? (store.attachedTask(t.id) || null)
        : null,
      // `running` — the thread whose id equals the store's currentId is
      // considered the active/running track. The UI uses this for the
      // green halo in the Active group.
      running: t.id === store.currentId,
    }));
    sendUnifyEvent({ type: 'thread_list_updated', threads, currentThreadId: store.currentId });
  } catch (err) {
    // Best-effort; sidebar update must never block the main query path.
    console.warn('[Unify] sendThreadListUpdate failed:', err?.message || err);
  }
}

/** Tool names that mutate ThreadStore. After any of these we push an update. */
const THREAD_MUTATING_TOOLS = new Set([
  'SpawnThread',
  'SwitchThread',
  'ArchiveThread',
  'AttachThreadToTask',
]);

/**
 * task-310: parse a leading `@thread-<id>` or `@thread-<name>` marker on
 * the user's input and return it as a dispatcher override. The marker
 * itself is STRIPPED from the prompt before it reaches the engine —
 * users don't want to see `@thread-foo` echoed back into their
 * conversation.
 *
 * Thread IDs are `main` or `thr-<8 hex>`, so the match captures the id
 * name AFTER the literal `@thread-`. The returned `override.threadId`
 * is the fully-qualified thread id (e.g. `thread-main`, `thread-thr-abcd1234`).
 *
 * Returns { prompt, override? } where override = { threadId } if matched.
 */
export function parseThreadPrefix(text) {
  if (!text || typeof text !== 'string') return { prompt: text || '', override: null };
  // Capture the id portion after the literal `@thread-` prefix.
  const m = text.match(/^\s*@thread-([A-Za-z0-9_-]+)\b\s*/);
  if (!m) return { prompt: text, override: null };
  const rest = text.slice(m[0].length);
  // The captured id may already include a `thr-` sub-prefix (for non-main
  // threads). For the canonical `main` thread, the override is the bare
  // string `main`; for `thr-xxxxxxxx` threads, pass through verbatim.
  const threadId = m[1];
  return { prompt: rest || text, override: { threadId } };
}

/**
 * Translate a pipeline event (from Dispatcher) into web-bridge outputs.
 * Pipeline events are distinct from engine events — they carry queue /
 * routing state for the UI. Engine events are unwrapped and forwarded
 * through the existing sendUnifyOutput / sendUnifyEvent path.
 *
 * Returns whether the pipeline is complete (terminal error / no more).
 */
function forwardPipelineEvent(ev, ctx) {
  if (!ev || typeof ev !== 'object') return false;
  switch (ev.type) {
    case 'input_queue_updated':
      sendUnifyEvent({
        type: 'input_queue_updated',
        total: ev.total,
        pending: ev.pending,
        routing: ev.routing,
        dispatched: ev.dispatched,
        head: ev.head,
      });
      return false;
    case 'routing_decision':
      sendUnifyEvent({
        type: 'routing_decision',
        entryId: ev.entryId,
        action: ev.action,
        targetThreadId: ev.targetThreadId,
        source: ev.source,
        reason: ev.reason,
      });
      return false;
    case 'thread_list_updated':
      // Dispatcher built it already; just forward.
      sendUnifyEvent({
        type: 'thread_list_updated',
        threads: ev.threads,
        currentThreadId: ev.currentThreadId,
      });
      return false;
    case 'engine_event':
      ctx.onEngineEvent(ev.event, ev.threadId);
      return false;
    case 'error':
      ctx.onError(ev.error);
      return true;
    default:
      return false;
  }
}

/**
 * Handle a single engine event unwrapped from an `engine_event` pipeline
 * envelope. Contains the event-type switch previously inlined in the
 * streaming loop. `threadId` is propagated onto tool_use / tool_result
 * blocks so the UI can render per-thread bubbles.
 *
 * @param {object} event — engine event (text_delta / tool_call / …)
 * @param {string} threadId — owning thread id (from envelope)
 * @param {{assistantTextParts:string[], resetQueryTimer:Function}} hctx
 */
function handleEngineEvent(event, threadId, hctx) {
  hctx.resetQueryTimer();
  switch (event.type) {
    case 'text_delta':
      hctx.assistantTextParts.push(event.text);
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: event.text }] },
        threadId,
      });
      break;

    case 'thinking_delta':
      sendUnifyEvent({ type: 'thinking_delta', text: event.text, threadId });
      break;

    case 'tool_call':
      // Finish any in-progress text streaming so UI shows typing dots
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [] },
        threadId,
      });
      sendUnifyOutput({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          }],
        },
        threadId: event.threadId || threadId,
      });
      break;

    case 'tool_start':
      sendUnifyEvent({
        type: 'tool_start',
        id: event.id,
        name: event.name,
        threadId: event.threadId || threadId,
      });
      break;

    case 'tool_end':
      sendUnifyOutput({
        type: 'user',
        tool_use_result: [{
          type: 'tool_result',
          tool_use_id: event.id,
          content: event.output || '',
          is_error: event.isError || false,
        }],
        threadId: event.threadId || threadId,
      });
      if (THREAD_MUTATING_TOOLS.has(event.name)) {
        sendThreadListUpdate();
      }
      break;

    case 'turn_start':
    case 'turn_end':
    case 'stop':
      // No UI action needed; outer loop sends the final result.
      break;

    case 'usage':
      sendUnifyEvent({
        type: 'context_usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        threadId,
      });
      break;

    case 'recall':
      sendUnifyEvent({
        type: 'recall',
        entryCount: event.entryCount,
        cached: event.cached,
        threadId,
      });
      break;

    case 'consolidate':
      // Engine compressed the context — clear our accumulated history for
      // THIS thread only (task-320: per-thread history map).
      if (threadId) {
        messagesByThread.set(threadId, []);
      } else {
        messagesByThread.clear();
      }
      sendUnifyEvent({
        type: 'consolidate',
        archivedCount: event.archivedCount,
        extractedCount: event.extractedCount,
        threadId,
      });
      break;

    case 'fallback':
      sendUnifyEvent({
        type: 'fallback',
        from: event.from,
        to: event.to,
        reason: event.reason,
        threadId,
      });
      break;

    case 'debug_turn':
      sendUnifyEvent({
        type: 'debug_turn',
        turnNumber: event.turnNumber,
        model: event.model,
        systemPrompt: event.systemPrompt,
        messages: event.messages,
        response: event.response,
        toolCalls: event.toolCalls,
        usage: event.usage,
        latencyMs: event.latencyMs,
        ttfbMs: event.ttfbMs,
        stopReason: event.stopReason,
        threadId,
      });
      break;

    case 'error': {
      const errMsg = event.error?.message || 'Unknown error';
      // Filter permission errors: show friendly one-time diagnostic
      // instead of raw error. Subsequent permission errors are suppressed
      // — the user already saw the actionable message once.
      if (isPermissionErrorMsg(errMsg)) {
        if (!_permissionDiagnosticSent) {
          _permissionDiagnosticSent = true;
          sendUnifyOutput({
            type: 'assistant',
            message: {
              content: [{
                type: 'text',
                text: '⚠️ Cannot write to ~/.yeaft/ directory — some features (memory, history) are unavailable. Please check directory permissions: `chmod -R u+rw ~/.yeaft/`',
              }],
            },
            threadId,
          });
        }
        // Don't show subsequent permission errors.
      } else {
        sendUnifyOutput({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `⚠️ Error: ${errMsg}` }],
          },
          threadId,
        });
      }
      break;
    }

    default:
      // Silently consume unknown events.
      break;
  }
}

/**
 * Handle a unify_chat message from the web UI.
 *
 * @param {{ prompt: string, mode?: string, userId?: string, username?: string }} msg
 *   NOTE: `mode` is deprecated (task-297) — Unify now runs in a single unified mode.
 *   If present, a warning is logged and the field is ignored.
 */
export async function handleUnifyChat(msg) {
  const { prompt, mode } = msg;
  if (!prompt?.trim()) return;

  // Deprecation warning — task-297 removed chat/work mode distinction
  if (mode !== undefined && mode !== null) {
    console.warn('[Unify] unify_chat.mode is deprecated and ignored — Unify now runs in a single unified mode.');
  }

  try {
    // ─── Lazy-init session (reuse across queries — Engine manages history) ──
    if (!session) {
      const yeaftDir = ctx.CONFIG?.yeaftDir;
      session = await loadSession({
        ...(yeaftDir && { dir: yeaftDir }),
        // Enable all features — no lazy shortcuts
        skipMCP: false,
        skipSkills: false,
      });

      // task-318 rev-1 fix: expose live setters on ctx so message-router's
      // update_unify_settings branch can push the new caps into the
      // registry + thread store without a session reload. Previously this
      // object was null and setMaxConcurrent/setIdleArchiveDays were dead
      // code — the config file was updated on disk but the running
      // session continued with the old caps until next restart.
      installUnifyRuntimeBridge(session);
      // task-317: run one idle-archive sweep at bootstrap, then schedule
      // the hourly tick bound to this session.
      runAutoArchiveSweep(session);
      scheduleAutoArchive(session);

      // Create a stable conversationId for the Unify session
      unifyConversationId = `unify-${Date.now()}`;

      // Restore per-thread history from persisted conversation store.
      // task-320: bucket by threadId so each thread keeps its own context.
      messagesByThread.clear();
      const recent = session.conversationStore.loadRecent(50);
      for (const m of recent) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const tid = m.threadId || MAIN_THREAD_ID;
        const bucket = getThreadMessages(tid);
        bucket.push({ role: m.role, content: m.content });
      }

      // Notify UI: session is ready with model info + conversationId
      sendUnifyEvent({
        type: 'session_ready',
        conversationId: unifyConversationId,
        model: session.config.model,
        availableModels: session.config.availableModels || [],
        skills: session.status.skills,
        mcpServers: session.status.mcpServers,
        tools: session.status.tools,
      });
      // task-301 Part 2: initial thread snapshot so sidebar V2 renders
      // the real 'main' thread (and any restored threads) right away.
      sendThreadListUpdate();
    }

    // ─── Per-call AbortController (task-320) ──
    // Each call owns its own controller. Only once the router resolves the
    // target thread do we register it into `abortByThread` and abort any
    // prior controller on THAT same thread. Messages routed to different
    // threads never alias each other's signals.
    const abortCtrl = new AbortController();
    /** @type {string | null} — set on routing_decision */
    let resolvedThreadId = null;

    // ─── Timeout guard: abort query if LLM hangs beyond threshold ──
    // Resets on every event — fires only after prolonged silence.
    let queryTimer = null;
    const resetQueryTimer = () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        if (!abortCtrl.signal.aborted) {
          console.error(`[Unify] query timeout after ${QUERY_TIMEOUT_MS / 1000}s of silence — aborting`);
          abortCtrl.abort();
        }
      }, QUERY_TIMEOUT_MS);
    };
    resetQueryTimer();

    try {
    // ─── Collect assistant response for conversation history ──
    let assistantTextParts = [];

    // task-310: route via Dispatcher pipeline (queue → router → registry →
    // EngineInstance). The input is enqueued first so the UI observes the
    // `input_queue_updated` snapshot before the router runs. An explicit
    // `@thread-xxx` prefix on the message or an `override` field on the
    // `unify_chat` payload becomes a dispatcher override — skipping the LLM.
    const { prompt: cleanedPrompt, override: prefixOverride } = parseThreadPrefix(prompt);
    const override = msg.override && typeof msg.override === 'object' && msg.override.threadId
      ? msg.override
      : prefixOverride;

    const { entry } = session.dispatcher.submit(cleanedPrompt, {
      messageId: msg.messageId,
      override: override || undefined,
    });
    sendUnifyEvent({
      type: 'input_queue_updated',
      total: 1,
      pending: 1,
      routing: 0,
      dispatched: 0,
      head: { id: entry.id, status: entry.status, text: entry.text.slice(0, 80) },
    });

    const pipelineCtx = {
      onEngineEvent: (event, threadId) => handleEngineEvent(event, threadId, {
        assistantTextParts,
        resetQueryTimer,
      }),
      onError: (err) => { throw err; },
    };

    for await (const pev of session.dispatcher.drain({ signal: abortCtrl.signal })) {
      resetQueryTimer();
      // task-320: on routing_decision, bind this abort controller to the
      // resolved target thread and abort any prior in-flight controller
      // owned by that thread. Different threads don't alias.
      if (pev && pev.type === 'routing_decision' && pev.targetThreadId && !resolvedThreadId) {
        resolvedThreadId = pev.targetThreadId;
        const prior = abortByThread.get(resolvedThreadId);
        if (prior && prior !== abortCtrl) {
          prior.abort();
        }
        abortByThread.set(resolvedThreadId, abortCtrl);
      }
      forwardPipelineEvent(pev, pipelineCtx);
    }

    // ─── Query complete — accumulate messages for context continuity ──
    // task-320: per-thread history (no cross-thread contamination).
    const historyThread = resolvedThreadId || MAIN_THREAD_ID;
    const threadMessages = getThreadMessages(historyThread);
    threadMessages.push({ role: 'user', content: cleanedPrompt });

    const fullText = assistantTextParts.join('');
    if (fullText) {
      threadMessages.push({ role: 'assistant', content: fullText });
    }

    // ─── Signal turn end to UI ──
    // Finish any streaming text
    sendUnifyOutput({
      type: 'assistant',
      message: { content: [] },
    });
    // Send result to clear processing state
    sendUnifyOutput({
      type: 'result',
      result_text: '',
    });

    } finally {
      // Always clear the timeout guard
      if (queryTimer) clearTimeout(queryTimer);
    }

  } catch (err) {
    // task-320: classify both DOM AbortError and LLMAbortError as
    // "aborted" — LLMAbortError is thrown by the LLM adapters when the
    // signal trips and must NOT render as a session error bubble.
    const isAbort = err && (err.name === 'AbortError' || err.name === 'LLMAbortError');
    if (isAbort) {
      // Silent abort — the new in-flight round (on the same thread) will
      // produce its own output. Still send `result` so the frontend's
      // processing spinner for this exact send clears.
      sendUnifyOutput({
        type: 'result',
        result_text: '',
      });
      return;
    }

    console.error('[Unify] query error:', err.message);

    // Filter permission errors at the session level too
    if (isPermissionErrorMsg(err.message)) {
      if (!_permissionDiagnosticSent) {
        _permissionDiagnosticSent = true;
        sendUnifyOutput({
          type: 'assistant',
          message: {
            content: [{
              type: 'text',
              text: '⚠️ Cannot write to ~/.yeaft/ directory — some features (memory, history) are unavailable. Please check directory permissions: `chmod -R u+rw ~/.yeaft/`',
            }],
          },
        });
      }
    } else {
      sendUnifyOutput({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: `⚠️ Session error: ${err.message}`,
          }],
        },
      });
    }
    // Still send result to clear processing state
    sendUnifyOutput({
      type: 'result',
      result_text: '',
    });
  } finally {
    // task-320: only clear the per-thread slot if THIS controller is still
    // the registered one. If a newer message already overwrote it, leaving
    // the newer controller in the map is the correct state.
    if (resolvedThreadId && abortByThread.get(resolvedThreadId) === abortCtrl) {
      abortByThread.delete(resolvedThreadId);
    }
  }
}

/**
 * Handle mode switch from the web UI.
 * DEPRECATED (task-297): Unify no longer has chat/work mode distinction.
 * Retained as a no-op with warning for backward compatibility.
 * @param {{ mode?: string }} _msg
 */
export function handleUnifyModeSwitch(_msg) {
  console.warn('[Unify] unify_mode_switch is deprecated and ignored — Unify now runs in a single unified mode.');
}

/**
 * task-313: merge a source thread into a target thread.
 * Reassigns messages, archives source with `mergedInto`, terminates source
 * engine instance, broadcasts `thread_merged` + `thread_list_updated`.
 *
 * @param {{ sourceId: string, targetId: string }} msg
 */
export function handleUnifyMergeThread(msg) {
  if (!session) {
    console.warn('[Unify] unify_merge_thread received before session init — ignored');
    return;
  }
  const { sourceId, targetId } = msg || {};
  if (!sourceId || !targetId) {
    sendUnifyEvent({ type: 'thread_merge_failed', sourceId, targetId, error: 'sourceId and targetId required' });
    return;
  }

  let reassigned = 0;
  try {
    // 1. Reassign messages (ConversationStore) — preserves sourceThreadId pill.
    if (session.conversationStore && typeof session.conversationStore.reassignThread === 'function') {
      reassigned = session.conversationStore.reassignThread(sourceId, targetId);
    }
    // 2. Mutate ThreadStore (mergedInto + archived + counter rollup).
    const store = session.threadStore || getThreadStore();
    store.mergeThread(sourceId, targetId);
    // 3. Terminate + forget the source engine instance — releases its slot.
    if (session.engineRegistry) {
      session.engineRegistry.delete(sourceId);
      // If the registry was tracking source as current, move to target.
      if (typeof session.engineRegistry.setCurrent === 'function'
          && session.engineRegistry.currentThreadId === sourceId) {
        session.engineRegistry.setCurrent(targetId);
      }
    }
    // 4. Flush ThreadStore so the merge is durable before the UI refreshes.
    if (typeof store.flush === 'function') store.flush();
  } catch (err) {
    sendUnifyEvent({
      type: 'thread_merge_failed',
      sourceId,
      targetId,
      error: err?.message || String(err),
    });
    return;
  }

  // 5. Broadcast the merge + refreshed thread list.
  sendUnifyEvent({
    type: 'thread_merged',
    sourceId,
    targetId,
    reassignedMessages: reassigned,
  });
  sendThreadListUpdate();
}

/**
 * task-314: fork a new thread from an existing one at a specific message.
 * Copies every message up to (and including) `atMessageId` from the source
 * thread onto a fresh thread, stamps `forkedFrom` on the new thread record,
 * and broadcasts `thread_forked` + refreshed thread list. The source is not
 * modified.
 *
 * @param {{ sourceThreadId: string, atMessageId: string, name?: string }} msg
 */
export function handleUnifyForkThread(msg) {
  if (!session) {
    console.warn('[Unify] unify_fork_thread received before session init — ignored');
    return;
  }
  const { sourceThreadId, atMessageId, name } = msg || {};
  if (!sourceThreadId || !atMessageId) {
    sendUnifyEvent({
      type: 'thread_fork_failed',
      sourceThreadId,
      atMessageId,
      error: 'sourceThreadId and atMessageId required',
    });
    return;
  }

  let copied = 0;
  let newThread;
  try {
    // 1. Create the fork record on ThreadStore (sets forkedFrom pointer).
    const store = session.threadStore || getThreadStore();
    newThread = store.forkThread(sourceThreadId, atMessageId, { name });
    // 2. Copy messages up to the cursor (inclusive) into the new thread.
    if (session.conversationStore && typeof session.conversationStore.copyThreadUpTo === 'function') {
      copied = session.conversationStore.copyThreadUpTo(
        sourceThreadId,
        newThread.id,
        atMessageId,
      );
    }
    // 3. Roll cached counters on the new thread so the sidebar shows the
    // copied messages without needing a rebuild pass.
    if (copied > 0) {
      newThread.messageCount = copied;
      newThread.lastMessageAt = Date.now();
      newThread.lastActivityAt = newThread.lastMessageAt;
    }
    // 4. Flush so the new thread is durable before the UI refreshes.
    if (typeof store.flush === 'function') store.flush();
  } catch (err) {
    sendUnifyEvent({
      type: 'thread_fork_failed',
      sourceThreadId,
      atMessageId,
      error: err?.message || String(err),
    });
    return;
  }

  // 5. Broadcast the fork + refreshed thread list.
  sendUnifyEvent({
    type: 'thread_forked',
    sourceThreadId,
    targetThreadId: newThread.id,
    forkedAtMessageId: atMessageId,
    copiedMessages: copied,
  });
  sendThreadListUpdate();
}

/**
 * Handle model switch from the web UI.
 * Updates Engine's config so the next query uses the new model.
 * @param {{ model: string }} msg
 */
export function handleUnifyModelSwitch(msg) {
  if (!session || !msg.model) return;

  // Validate: model must be in availableModels list
  const available = session.config.availableModels || [];
  const found = available.some(m => m.id === msg.model);
  if (!found) {
    console.warn(`[Unify] model switch rejected — "${msg.model}" not in availableModels`);
    return;
  }

  // Update Engine's model for subsequent queries
  session.config.model = msg.model;

  // Confirm switch to frontend
  sendUnifyEvent({
    type: 'model_switched',
    model: msg.model,
  });
}

/**
 * Handle history load request from the web UI.
 * Loads recent messages from ConversationStore and sends them through
 * the standard claude_output rendering pipeline (sendUnifyOutput).
 *
 * @param {{ limit?: number }} msg
 */
export async function handleUnifyLoadHistory(msg) {
  // Lazy-init session if needed (same logic as handleUnifyChat)
  if (!session) {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });
    // task-318 rev-1 fix: wire live setters; see handleUnifyChat.
    installUnifyRuntimeBridge(session);
    // task-317: sweep + schedule auto-archive on history-load path too.
    runAutoArchiveSweep(session);
    scheduleAutoArchive(session);

    unifyConversationId = `unify-${Date.now()}`;

    // Restore per-thread history from persisted conversation store.
    // task-320: bucket by threadId so each thread keeps its own context.
    messagesByThread.clear();
    const recent = session.conversationStore.loadRecent(50);
    for (const m of recent) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const tid = m.threadId || MAIN_THREAD_ID;
      const bucket = getThreadMessages(tid);
      bucket.push({ role: m.role, content: m.content });
    }
  }

  // task-322: replay `session_ready` + `thread_list_updated` UNCONDITIONALLY
  // on every load-history call. The module-level `session` is a process-wide
  // singleton — on page refresh the agent reuses it, so the lazy-init block
  // above is skipped. The frontend's `enterUnify()` resets
  // `unifyModel=null`, `unifyThreads=[]`, `unifySessionReady=false` every
  // time, so without this replay the UI is left with the model selector
  // stuck on the placeholder, sidebar empty, and the local→agent
  // conversationId migration never triggers (leaving the main pane blank).
  //
  // Frontend is idempotent: the `session_ready` handler either migrates
  // local→agent convId (first time) or just updates model/status fields
  // (repeat) — receiving it twice is a no-op on state invariants.
  sendUnifyEvent({
    type: 'session_ready',
    conversationId: unifyConversationId,
    model: session.config.model,
    availableModels: session.config.availableModels || [],
    skills: session.status.skills,
    mcpServers: session.status.mcpServers,
    tools: session.status.tools,
  });
  sendThreadListUpdate();

  const limit = msg.limit || 50;
  const messages = session.conversationStore.loadRecent(limit);
  const compactSummary = session.conversationStore.readCompactSummary();

  // Send each message through standard claude_output rendering pipeline
  for (const m of messages) {
    if (m.role === 'user') {
      sendUnifyOutput({ type: 'user', message: { content: m.content } });
    } else if (m.role === 'assistant') {
      sendUnifyOutput({
        type: 'assistant',
        message: { content: [{ type: 'text', text: m.content }] },
      });
      sendUnifyOutput({ type: 'result', result_text: '' });
    }
  }

  // Signal history loading complete
  sendUnifyEvent({
    type: 'history_loaded',
    count: messages.length,
    hasCompactSummary: !!compactSummary,
    totalHot: session.conversationStore.countHot(),
    totalCold: session.conversationStore.countCold(),
  });
}

/**
 * Reset Unify session (for clear messages or config change).
 * After shutdown, immediately re-initializes the session and sends
 * session_ready so the frontend picks up updated models/config.
 */
export async function resetUnifySession() {
  // task-320: abort ALL in-flight controllers (every thread) before
  // tearing down the session. Leaves no dangling round still writing
  // to stdout after shutdown.
  for (const ctrl of abortByThread.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  abortByThread.clear();
  if (session) {
    await session.shutdown();
    session = null;
  }
  unifyConversationId = null;
  messagesByThread.clear();

  // Re-initialize session immediately so frontend gets updated config
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });
    // task-318 rev-1 fix: wire live setters; see handleUnifyChat.
    installUnifyRuntimeBridge(session);
    // task-317: sweep + re-schedule auto-archive on reset too (the old
    // interval was bound to the previous session; reschedule against the
    // fresh one so timer references don't dangle).
    runAutoArchiveSweep(session);
    scheduleAutoArchive(session);

    unifyConversationId = `unify-${Date.now()}`;

    // Restore per-thread history for LLM context (task-320).
    const recent = session.conversationStore.loadRecent(50);
    for (const m of recent) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const tid = m.threadId || MAIN_THREAD_ID;
      getThreadMessages(tid).push({ role: m.role, content: m.content });
    }

    sendUnifyEvent({
      type: 'session_ready',
      conversationId: unifyConversationId,
      model: session.config.model,
      availableModels: session.config.availableModels || [],
      skills: session.status.skills,
      mcpServers: session.status.mcpServers,
      tools: session.status.tools,
    });
    // task-301 Part 2: re-push thread snapshot after session reset.
    sendThreadListUpdate();
  } catch (err) {
    console.error('[Unify] Failed to re-initialize session after reset:', err.message);
  }
}
