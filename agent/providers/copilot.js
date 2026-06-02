import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import ctx from '../context.js';

export const name = 'copilot';

const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
// Opt-in only: --allow-all-tools is a destructive footgun by default in a
// multi-tenant agent. Set COPILOT_YOLO=1 (and only if you know what you're
// doing) to skip Copilot's tool prompts.
const YOLO = process.env.COPILOT_YOLO === '1';

/**
 * Start (or resume) a Copilot session.
 * Copilot's `-p` mode is one-shot per turn, so "start" just prepares state.
 * Each sendInput() spawns one `copilot -p ...` child with the same
 * --session-id for continuity.
 */
export async function start(opts) {
  const conversationId = opts.conversationId;
  // Tear down any prior entry so we don't leak children.
  const prior = ctx.conversations.get(conversationId);
  if (prior?.copilotChild) {
    try { prior.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
  }

  const sessionId = opts.resumeSessionId || randomUUID();
  const state = {
    providerName: name,
    conversationId: opts.conversationId,
    query: null,
    inputStream: null,
    workDir: opts.workDir,
    claudeSessionId: sessionId,
    sessionId,
    createdAt: prior?.createdAt || Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model: 'copilot',
    userId: opts.userId,
    username: opts.username,
    disallowedTools: prior?.disallowedTools || null,
    copilotChild: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 },
  };
  ctx.conversations.set(conversationId, state);
  return state;
}

export async function sendInput(state, prompt, opts = {}) {
  const conversationId = opts.conversationId || state.conversationId;
  if (!conversationId) throw new Error('copilot: conversationId required');
  if (!state.sessionId) state.sessionId = randomUUID();

  // Abort any in-flight turn.
  if (state.copilotChild) {
    try { state.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
    state.copilotChild = null;
  }
  const abortController = new AbortController();
  state.abortController = abortController;
  state.turnActive = true;
  state.turnResultReceived = false;

  const args = ['-p', prompt, '--output-format', 'json', '-C', state.workDir, '--session-id', state.sessionId];
  if (YOLO) args.push('--allow-all-tools');

  let child;
  try {
    child = spawn(COPILOT_BIN, args, {
      cwd: state.workDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    sendOutput(conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: `copilot spawn failed: ${err?.message || err}`,
    });
    state.turnActive = false;
    ctx.sendToServer({ type: 'turn_completed', conversationId, claudeSessionId: state.sessionId, workDir: state.workDir });
    return;
  }
  state.copilotChild = child;

  // Pre-register error handler so async ENOENT from spawn is never unhandled.
  child.on('error', (err) => {
    sendOutput(conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: `copilot process error: ${err?.message || err}`,
    });
  });

  let killTimer = null;
  abortController.signal.addEventListener('abort', () => {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    // Escalate to SIGKILL if the child ignores SIGTERM, so the awaited
    // close promise resolves and the next turn isn't blocked forever.
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, 5000);
  });

  let stderrBuf = '';
  const STDERR_CAP = 64 * 1024;
  let sawResult = false;

  const parser = createNdjsonParser((evt) => {
    const envelopes = translateCopilotEvent(evt, state);
    for (const e of envelopes) {
      sendOutput(conversationId, e);
      if (e?.type === 'result') sawResult = true;
    }
  });

  child.stdout.on('data', (chunk) => parser.push(chunk));
  child.stderr.on('data', (chunk) => {
    if (stderrBuf.length < STDERR_CAP) {
      stderrBuf += chunk.toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
    }
  });

  await new Promise((resolve) => {
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      parser.flush();
      if (!sawResult) {
        const ok = code === 0;
        sendOutput(conversationId, {
          type: 'result',
          subtype: ok ? 'success' : 'error',
          session_id: state.sessionId,
          is_error: !ok,
          error: ok ? undefined : (stderrBuf.trim().slice(0, 2000) || `copilot exited with code ${code}`),
        });
      }
      state.copilotChild = null;
      state.turnActive = false;
      ctx.sendToServer({
        type: 'turn_completed',
        conversationId,
        claudeSessionId: state.sessionId,
        workDir: state.workDir,
      });
      resolve();
    });
  });
}

export function abort(state) {
  if (state?.abortController) {
    try { state.abortController.abort(); } catch { /* noop */ }
  }
  if (state?.copilotChild) {
    try { state.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
  }
}

// ---------- internals ----------

function sendOutput(conversationId, data) {
  ctx.sendToServer({ type: 'claude_output', conversationId, data });
}

export function createNdjsonParser(onEvent) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); }
        catch (err) {
          if (ctx?.CONFIG?.debug) console.warn('[copilot] dropping unparsable line:', line.slice(0, 200));
          continue;
        }
        try { onEvent(evt); }
        catch (err) { console.warn('[copilot] event handler error:', err?.message || err); }
      }
    },
    flush() {
      const line = buf.trim();
      buf = '';
      if (!line) return;
      try {
        const evt = JSON.parse(line);
        onEvent(evt);
      } catch { /* discard trailing junk */ }
    },
  };
}

/**
 * Map a Copilot NDJSON event to zero-or-more claude_output envelopes.
 * Defensive: unknown shapes are logged and dropped.
 *
 * Recognized loose schemas (Copilot CLI JSON output is not yet stable, so
 * we accept several aliases and forward only what we understand):
 *  - text:        { type: 'text'|'text_delta'|'assistant_text', text|delta }
 *  - message:     { type: 'message', role, content }
 *  - tool_call:   { type: 'tool_call'|'tool_use', id, name|tool, input|arguments }
 *  - tool_result: { type: 'tool_result', tool_use_id|id, content|output }
 *  - done:        { type: 'result'|'done'|'complete', session_id?, error? }
 *  - error:       { type: 'error', message|error }
 */
export function translateCopilotEvent(evt, state) {
  if (!evt || typeof evt !== 'object') return [];
  const t = evt.type;

  if (t === 'text' || t === 'text_delta' || t === 'assistant_text') {
    const text = typeof evt.text === 'string' ? evt.text : (typeof evt.delta === 'string' ? evt.delta : '');
    if (!text) return [];
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }];
  }

  if (t === 'message' && evt.role === 'assistant') {
    const content = normalizeContent(evt.content);
    return [{ type: 'assistant', message: { role: 'assistant', content } }];
  }

  if (t === 'tool_call' || t === 'tool_use') {
    const id = evt.id || evt.call_id || randomUUID();
    const toolName = evt.name || evt.tool || 'unknown';
    const input = evt.input ?? evt.arguments ?? {};
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input }] } }];
  }

  if (t === 'tool_result') {
    const tool_use_id = evt.tool_use_id || evt.id || 'unknown';
    const content = typeof evt.content === 'string'
      ? evt.content
      : (typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.content ?? evt.output ?? ''));
    return [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] } }];
  }

  if (t === 'result' || t === 'done' || t === 'complete') {
    const isErr = !!evt.error || evt.is_error === true;
    return [{
      type: 'result',
      subtype: isErr ? 'error' : 'success',
      session_id: evt.session_id || state?.sessionId || null,
      is_error: isErr,
      error: isErr ? (evt.error || evt.message || 'copilot error') : undefined,
    }];
  }

  if (t === 'error') {
    return [{
      type: 'result',
      subtype: 'error',
      session_id: state?.sessionId || null,
      is_error: true,
      error: evt.message || evt.error || 'copilot error',
    }];
  }

  if (ctx?.CONFIG?.debug) console.warn('[copilot] dropping unknown event type:', t);
  return [];
}

function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content ?? '') }];
}

export default { name, start, sendInput, abort };
