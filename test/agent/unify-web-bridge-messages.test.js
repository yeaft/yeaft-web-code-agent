/**
 * Tests for web-bridge conversation-history behaviour.
 *
 * Originally written for task-269 against a flat `conversationMessages`
 * module-level array. Task-310 (Phase 2 pipeline) preserved that flat
 * array. Task-320 replaces it with a per-thread `messagesByThread` Map —
 * the invariants migrate accordingly:
 *
 *   1. `messagesByThread` exists as a module-level Map (per-thread
 *      history — no more cross-thread contamination).
 *   2. Assistant text deltas are still collected into
 *      `assistantTextParts` at call-scope.
 *   3. After the pipeline drain completes, the bridge resolves the
 *      target thread from `routing_decision` and appends user +
 *      assistant entries INTO THAT THREAD'S bucket (cleanedPrompt used
 *      because `@thread-` prefixes are stripped before the engine sees
 *      the text).
 *   4. Consolidate clears the bucket for the event's thread only;
 *      session-reset clears the whole map.
 *   5. Engine consumes a `messages` parameter (delegated to
 *      EngineInstance.query which forwards to engine.query).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WEB_BRIDGE_PATH = join(import.meta.dirname, '..', '..', 'agent', 'unify', 'web-bridge.js');
const ENGINE_PATH = join(import.meta.dirname, '..', '..', 'agent', 'unify', 'engine.js');
const ENGINE_INSTANCE_PATH = join(
  import.meta.dirname, '..', '..', 'agent', 'unify', 'threads', 'engine-instance.js'
);

describe('web-bridge conversation history (task-320 per-thread map)', () => {
  const src = readFileSync(WEB_BRIDGE_PATH, 'utf8');

  it('declares messagesByThread module-level Map', () => {
    expect(src).toContain('const messagesByThread = new Map()');
  });

  it('does NOT retain the pre-task-320 flat conversationMessages array', () => {
    // Regression guard: the old single-thread singleton must be gone.
    expect(src).not.toContain('let conversationMessages');
    expect(src).not.toContain('conversationMessages =');
    expect(src).not.toContain('conversationMessages.push');
  });

  it('routes unify_chat through the Dispatcher pipeline (not engine.query directly)', () => {
    expect(src).toContain('session.dispatcher.submit(');
    expect(src).toContain('session.dispatcher.drain(');
    expect(src).not.toContain('session.engine.query({');
  });

  it('collects assistant text from text_delta engine events', () => {
    expect(src).toContain('assistantTextParts.push(event.text)');
  });

  it('resolves target thread from routing_decision event before recording history', () => {
    // task-320: the thread id is NOT known upfront — we wait for the
    // router to announce it and bucket history under that id.
    expect(src).toContain("pev.type === 'routing_decision'");
    expect(src).toContain('pev.targetThreadId');
  });

  it('appends cleaned user prompt to the per-thread bucket after drain completes', () => {
    expect(src).toContain("threadMessages.push({ role: 'user', content: cleanedPrompt })");
  });

  it('appends assistant message with plain text content to the per-thread bucket', () => {
    expect(src).toContain("threadMessages.push({ role: 'assistant', content: fullText })");
  });

  it('builds fullText from collected text parts', () => {
    expect(src).toContain('assistantTextParts.join');
  });

  it('only appends assistant message when fullText is non-empty', () => {
    expect(src).toContain('if (fullText)');
  });

  it('clears per-thread history on consolidation event (scoped to the event thread)', () => {
    const consolidateSection = src.slice(
      src.indexOf("case 'consolidate':"),
      src.indexOf("case 'consolidate':") + 400
    );
    expect(consolidateSection).toMatch(/messagesByThread\.set\(threadId, \[\]\)|messagesByThread\.clear\(\)/);
  });

  it('clears messagesByThread on session reset', () => {
    const resetSection = src.slice(
      src.indexOf('async function resetUnifySession'),
      src.indexOf('async function resetUnifySession') + 800
    );
    expect(resetSection).toContain('messagesByThread.clear()');
  });

  it('preserves the permission-error one-time diagnostic filter', () => {
    expect(src).toContain('_permissionDiagnosticSent');
    expect(src).toMatch(/Filter permission errors/);
    expect(src).toMatch(/Don't show subsequent permission errors/);
  });

  it('does NOT collect tool_use blocks into per-thread history (regression guard)', () => {
    expect(src).not.toContain('assistantToolUseBlocks');
  });

  it('stores assistant content as plain string, not content-block array (regression guard)', () => {
    expect(src).not.toContain("assistantContent.push({ type: 'text'");
    expect(src).not.toContain('content: assistantContent');
  });

  it('strips @thread-<id> prefix before submitting to dispatcher', () => {
    expect(src).toContain('parseThreadPrefix(prompt)');
    expect(src).toContain('dispatcher.submit(cleanedPrompt');
  });
});

describe('engine + EngineInstance messages contract (still honored)', () => {
  it('engine.query() accepts messages parameter with default empty array', () => {
    const engineSrc = readFileSync(ENGINE_PATH, 'utf8');
    expect(engineSrc).toMatch(/async\s+\*query\(\{\s*prompt[\s\S]*?messages\s*=\s*\[\]/);
  });

  it('engine spreads messages into conversation history', () => {
    const engineSrc = readFileSync(ENGINE_PATH, 'utf8');
    expect(engineSrc).toContain('...messages');
  });

  it('EngineInstance forwards messages to engine.query (per-thread)', () => {
    const instSrc = readFileSync(ENGINE_INSTANCE_PATH, 'utf8');
    expect(instSrc).toMatch(/messages:\s*\w+/);
  });
});
