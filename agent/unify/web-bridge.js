/**
 * web-bridge.js — Bridge between Yeaft Unify Engine and the Web UI
 *
 * Translates Unify Engine streaming events into the sendOutput wire format
 * that the existing web client already understands. This means the UI needs
 * zero rendering changes — Unify conversations look identical to Claude ones.
 *
 * Architecture: Agent-side only. UI and Server are transparent relays.
 *
 * Lifecycle per conversation:
 *   1. First user message → lazy-load a Unify Session (loadSession)
 *   2. Each user message → engine.query({ prompt }) → stream events → sendOutput
 *   3. On turn complete → send turn_completed so UI exits processing state
 */

import ctx from '../context.js';
import { sendOutput, sendConversationList } from '../conversation.js';
import { loadSession } from './session.js';

/**
 * Handle a user message for a Unify-mode conversation.
 *
 * Called from conversation.js handleUserInput() when state.mode === 'unify'.
 * Reuses the same sendOutput() wire format as Claude conversations so the
 * web client renders messages identically.
 *
 * @param {{ conversationId: string, prompt: string }} msg
 */
export async function handleUnifyInput(msg) {
  const { conversationId, prompt } = msg;
  const state = ctx.conversations.get(conversationId);

  if (!state) {
    console.error(`[Unify] No conversation state for ${conversationId}`);
    return;
  }

  // ─── Lazy-init Unify Session ──────────────────────────────
  if (!state._unifySession) {
    try {
      console.log(`[Unify] Loading session for ${conversationId}...`);
      state._unifySession = await loadSession({
        skipMCP: true,
        skipSkills: true,
      });
      state._unifyMessages = [];
      console.log(`[Unify] Session loaded for ${conversationId} (model: ${state._unifySession.config.model})`);
    } catch (err) {
      console.error(`[Unify] Failed to load session for ${conversationId}:`, err);
      sendOutput(conversationId, {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: `Unify session initialization failed: ${err.message}`
          }]
        }
      });
      ctx.sendToServer({
        type: 'turn_completed',
        conversationId,
        workDir: state.workDir
      });
      return;
    }
  }

  const session = state._unifySession;

  // ─── Send user message to UI ──────────────────────────────
  sendOutput(conversationId, {
    type: 'user',
    message: {
      role: 'user',
      content: prompt
    }
  });

  // Track messages for multi-turn context
  state._unifyMessages.push({ role: 'user', content: prompt });

  // ─── Run Engine query and stream back ─────────────────────
  let fullText = '';
  let hasError = false;

  try {
    for await (const event of session.engine.query({
      prompt,
      messages: state._unifyMessages.slice(0, -1), // pass history (excluding current prompt which engine adds)
    })) {
      switch (event.type) {
        case 'text_delta':
          fullText += event.text;
          sendOutput(conversationId, {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: event.text
              }]
            },
            subtype: 'text_delta'
          });
          break;

        case 'tool_call':
          sendOutput(conversationId, {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: event.id,
                name: event.name,
                input: event.input
              }]
            }
          });
          break;

        case 'tool_result':
          sendOutput(conversationId, {
            type: 'assistant',
            message: {
              role: 'tool',
              tool_use_id: event.toolCallId,
              content: typeof event.result === 'string'
                ? event.result
                : JSON.stringify(event.result)
            }
          });
          break;

        case 'usage':
          // Update conversation usage tracking
          if (state.usage) {
            state.usage.inputTokens += event.inputTokens || 0;
            state.usage.outputTokens += event.outputTokens || 0;
          }
          break;

        case 'error':
          hasError = true;
          sendOutput(conversationId, {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: `Error: ${event.error?.message || 'Unknown error'}`
              }]
            }
          });
          break;

        case 'stop':
        case 'turn_start':
        case 'turn_end':
        case 'recall':
        case 'consolidate':
        case 'fallback':
        case 'thinking_delta':
          // These are engine-internal events; no UI action needed
          break;
      }
    }
  } catch (err) {
    hasError = true;
    console.error(`[Unify] Query error for ${conversationId}:`, err);
    sendOutput(conversationId, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `Unify query error: ${err.message}`
        }]
      }
    });
  }

  // ─── Track assistant response for multi-turn ──────────────
  if (fullText) {
    state._unifyMessages.push({ role: 'assistant', content: fullText });
  }

  // ─── Send result + turn_completed ─────────────────────────
  // Emit a result message to match Claude's wire format (UI uses this for state management)
  sendOutput(conversationId, {
    type: 'result',
    subtype: hasError ? 'error' : 'success',
    result_text: fullText
  });

  ctx.sendToServer({
    type: 'turn_completed',
    conversationId,
    workDir: state.workDir
  });

  sendConversationList();
}
