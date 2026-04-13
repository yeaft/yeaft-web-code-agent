/**
 * web-bridge.js — Bridge between web UI and Yeaft Unify Engine.
 *
 * Handles `unify_chat` messages from the server, runs queries through
 * the Engine, and streams `unify_output` events back.
 *
 * The session is lazily initialized on first use and reused across queries.
 * Engine internally manages conversation history and persistence.
 */

import { loadSession } from './session.js';
import { sendToServer } from '../connection/buffer.js';
import ctx from '../context.js';

/** @type {import('./session.js').Session | null} */
let session = null;

/** @type {AbortController | null} */
let currentAbort = null;

/**
 * Handle a unify_chat message from the web UI.
 *
 * @param {{ prompt: string, userId?: string, username?: string }} msg
 */
export async function handleUnifyChat(msg) {
  const { prompt } = msg;
  if (!prompt?.trim()) return;

  try {
    // Lazy-init session (reuse across queries — Engine manages history)
    if (!session) {
      const yeaftDir = ctx.CONFIG?.yeaftDir;
      session = await loadSession({
        ...(yeaftDir && { dir: yeaftDir }),
        skipMCP: true,
        skipSkills: true,
      });

      // Send model info to UI so the badge updates
      sendToServer({
        type: 'unify_output',
        event: { type: 'model_info', model: session.config.model },
      });
    }

    // Cancel any in-flight query
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }

    currentAbort = new AbortController();

    // Stream query events → unify_output messages
    for await (const event of session.engine.query({ prompt, signal: currentAbort.signal })) {
      switch (event.type) {
        case 'text_delta':
          sendToServer({
            type: 'unify_output',
            event: { type: 'text_delta', text: event.text },
          });
          break;

        case 'error':
          sendToServer({
            type: 'unify_output',
            event: {
              type: 'error',
              message: event.error?.message || 'Unknown error',
            },
          });
          break;

        // Silently consume other events (tool_call, thinking_delta, usage, etc.)
        // These can be surfaced later as the Unify UI grows.
        default:
          break;
      }
    }

    // Signal completion
    sendToServer({
      type: 'unify_output',
      event: { type: 'done' },
    });
  } catch (err) {
    // Don't report abort errors
    if (err.name === 'AbortError') return;

    console.error('[Unify] query error:', err.message);
    sendToServer({
      type: 'unify_output',
      event: { type: 'error', message: err.message || 'Session error' },
    });
  } finally {
    currentAbort = null;
  }
}
