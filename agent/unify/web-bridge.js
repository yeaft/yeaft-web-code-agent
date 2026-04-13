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

/** Virtual conversationId for the Unify session */
let unifyConversationId = null;

/** Current query mode: 'chat' or 'work' */
let currentMode = 'chat';

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

      // Notify UI: session is ready with model info + conversationId
      sendUnifyEvent({
        type: 'session_ready',
        conversationId: unifyConversationId,
        model: session.config.model,
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

    // ─── Stream Engine events → claude_output format ──
    for await (const event of session.engine.query({
      prompt,
      mode: currentMode,
      signal: currentAbort.signal,
    })) {
      switch (event.type) {
        // ── Text streaming ──
        case 'text_delta':
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

        // ── Errors ──
        case 'error':
          sendUnifyOutput({
            type: 'assistant',
            message: {
              content: [{
                type: 'text',
                text: `⚠️ Error: ${event.error?.message || 'Unknown error'}`,
              }],
            },
          });
          break;

        default:
          // Silently consume unknown events
          break;
      }
    }

    // ─── Query complete — signal turn end ──
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

  } catch (err) {
    // Don't report abort errors
    if (err.name === 'AbortError') return;

    console.error('[Unify] query error:', err.message);
    sendUnifyOutput({
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: `⚠️ Session error: ${err.message}`,
        }],
      },
    });
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
 * Reset Unify session (for clear messages).
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
}
