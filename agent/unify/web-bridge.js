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

/** @type {import('./session.js').Session | null} */
let session = null;

/** @type {AbortController | null} */
let currentAbort = null;

/** Query timeout in ms — abort if LLM doesn't respond within this window */
const QUERY_TIMEOUT_MS = 120_000;

/** Virtual conversationId for the Unify session */
let unifyConversationId = null;

/** Current query mode: 'chat' or 'work' */
let currentMode = 'chat';

/** Accumulated conversation messages for context continuity across queries.
 *  Each entry is { role: 'user'|'assistant', content: string|Array }.
 *  Cleared on session reset or consolidation. */
let conversationMessages = [];

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
 * Handle a unify_chat message from the web UI.
 *
 * @param {{ prompt: string, mode?: string, userId?: string, username?: string }} msg
 */
export async function handleUnifyChat(msg) {
  const { prompt, mode } = msg;
  if (!prompt?.trim()) return;

  // Update mode if provided
  if (mode === 'chat' || mode === 'work') {
    currentMode = mode;
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

      // Create a stable conversationId for the Unify session
      unifyConversationId = `unify-${Date.now()}`;

      // Restore conversationMessages from persisted history for LLM context
      const recent = session.conversationStore.loadRecent(50);
      conversationMessages = recent
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

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
    }

    // ─── Cancel any in-flight query ──
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }

    currentAbort = new AbortController();

    // ─── Timeout guard: abort query if LLM hangs beyond threshold ──
    // Resets on every event — fires only after prolonged silence.
    let queryTimer = null;
    const resetQueryTimer = () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        if (currentAbort) {
          console.error(`[Unify] query timeout after ${QUERY_TIMEOUT_MS / 1000}s of silence — aborting`);
          currentAbort.abort();
        }
      }, QUERY_TIMEOUT_MS);
    };
    resetQueryTimer();

    try {
    // ─── Collect assistant response for conversation history ──
    let assistantTextParts = [];

    // ─── Stream Engine events → claude_output format ──
    for await (const event of session.engine.query({
      prompt,
      mode: currentMode,
      messages: conversationMessages,
      signal: currentAbort.signal,
    })) {
      // Reset timeout on every event — activity means the query is alive
      resetQueryTimer();
      switch (event.type) {
        // ── Text streaming ──
        case 'text_delta':
          assistantTextParts.push(event.text);
          sendUnifyOutput({
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: event.text }],
            },
          });
          break;

        // ── Thinking streaming (extended thinking) ──
        case 'thinking_delta':
          // Currently not rendered in UI, but forward for future use
          sendUnifyEvent({ type: 'thinking_delta', text: event.text });
          break;

        // ── Tool call announced by LLM ──
        case 'tool_call':
          // Finish any in-progress text streaming so UI shows typing dots
          sendUnifyOutput({
            type: 'assistant',
            message: { content: [] },
          });
          // Send tool_use block
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
          });
          break;

        // ── Tool execution started ──
        case 'tool_start':
          // Tool is running — the UI already shows it from tool_use block above
          break;

        // ── Tool execution completed ──
        case 'tool_end':
          // Send tool_result as a user message (matches Claude CLI format)
          sendUnifyOutput({
            type: 'user',
            tool_use_result: [{
              type: 'tool_result',
              tool_use_id: event.id,
              content: event.output || '',
              is_error: event.isError || false,
            }],
          });
          break;

        // ── Turn boundaries ──
        case 'turn_start':
          // No UI action needed
          break;

        case 'turn_end':
          // Don't send result/done here — wait for the outermost loop to finish
          break;

        // ── Token usage ──
        case 'usage':
          sendUnifyEvent({
            type: 'context_usage',
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          });
          break;

        // ── Stop reason from LLM ──
        case 'stop':
          // Intermediate signal — final done is sent after the loop
          break;

        // ── Memory recall ──
        case 'recall':
          sendUnifyEvent({
            type: 'recall',
            entryCount: event.entryCount,
            cached: event.cached,
          });
          break;

        // ── Context consolidation ──
        case 'consolidate':
          // Engine has compressed the context — clear our accumulated history.
          // The engine's compactSummary will provide context on next query.
          conversationMessages = [];
          sendUnifyEvent({
            type: 'consolidate',
            archivedCount: event.archivedCount,
            extractedCount: event.extractedCount,
          });
          break;

        // ── Model fallback ──
        case 'fallback':
          sendUnifyEvent({
            type: 'fallback',
            from: event.from,
            to: event.to,
            reason: event.reason,
          });
          break;

        // ── Debug turn data for web debug panel ──
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
          });
          break;

        // ── Errors ──
        case 'error': {
          const errMsg = event.error?.message || 'Unknown error';
          // Filter permission errors: show friendly one-time diagnostic instead of raw error
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
              });
            }
            // Don't show subsequent permission errors
          } else {
            sendUnifyOutput({
              type: 'assistant',
              message: {
                content: [{
                  type: 'text',
                  text: `⚠️ Error: ${errMsg}`,
                }],
              },
            });
          }
          break;
        }

        default:
          // Silently consume unknown events
          break;
      }
    }

    // ─── Query complete — accumulate messages for context continuity ──
    conversationMessages.push({ role: 'user', content: prompt });

    const fullText = assistantTextParts.join('');
    if (fullText) {
      conversationMessages.push({ role: 'assistant', content: fullText });
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
    // Don't report abort errors — but still send result to unblock frontend
    if (err.name === 'AbortError') {
      sendUnifyOutput({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: '⚠️ Query timed out — no response from LLM. Please try again.',
          }],
        },
      });
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
    currentAbort = null;
  }
}

/**
 * Handle mode switch from the web UI.
 * @param {{ mode: 'chat' | 'work' }} msg
 */
export function handleUnifyModeSwitch(msg) {
  if (msg.mode === 'chat' || msg.mode === 'work') {
    currentMode = msg.mode;
  }
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

    unifyConversationId = `unify-${Date.now()}`;

    // Restore conversationMessages from persisted history for LLM context
    const recent = session.conversationStore.loadRecent(50);
    conversationMessages = recent
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    sendUnifyEvent({
      type: 'session_ready',
      conversationId: unifyConversationId,
      model: session.config.model,
      availableModels: session.config.availableModels || [],
      skills: session.status.skills,
      mcpServers: session.status.mcpServers,
      tools: session.status.tools,
    });
  }

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
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  if (session) {
    await session.shutdown();
    session = null;
  }
  unifyConversationId = null;
  currentMode = 'chat';
  conversationMessages = [];

  // Re-initialize session immediately so frontend gets updated config
  try {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    session = await loadSession({
      ...(yeaftDir && { dir: yeaftDir }),
      skipMCP: false,
      skipSkills: false,
    });

    unifyConversationId = `unify-${Date.now()}`;

    // Restore conversation history for LLM context
    const recent = session.conversationStore.loadRecent(50);
    conversationMessages = recent
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    sendUnifyEvent({
      type: 'session_ready',
      conversationId: unifyConversationId,
      model: session.config.model,
      availableModels: session.config.availableModels || [],
      skills: session.status.skills,
      mcpServers: session.status.mcpServers,
      tools: session.status.tools,
    });
  } catch (err) {
    console.error('[Unify] Failed to re-initialize session after reset:', err.message);
  }
}
