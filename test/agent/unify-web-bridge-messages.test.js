/**
 * Tests for web-bridge conversation-history behaviour.
 *
 * Originally written for task-269 against the direct `engine.query({
 * prompt, messages })` code path. Task-310 (Phase 2 integration)
 * replaces that direct call with a Dispatcher pipeline
 * (`submit()` + `drain()`), and the messages array is now owned by the
 * per-thread EngineInstance rather than passed into the bridge call
 * site. The structural invariants that still matter are:
 *
 *   1. `conversationMessages` array still exists at module scope (it's
 *      a UI-side mirror used for the consolidate/reset paths).
 *   2. Assistant text deltas are collected into `assistantTextParts`.
 *   3. After the pipeline drain completes, the bridge accumulates
 *      user + assistant entries into `conversationMessages`
 *      (`cleanedPrompt` is used because `@thread-` prefixes are
 *      stripped before the engine sees the text).
 *   4. Consolidate + session-reset still clear the array.
 *   5. Engine consumes a `messages` parameter (delegated to
 *      EngineInstance.query which forwards to engine.query), so the
 *      engine-level signature contract is preserved.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WEB_BRIDGE_PATH = join(import.meta.dirname, '..', '..', 'agent', 'unify', 'web-bridge.js');
const ENGINE_PATH = join(import.meta.dirname, '..', '..', 'agent', 'unify', 'engine.js');
const ENGINE_INSTANCE_PATH = join(
  import.meta.dirname, '..', '..', 'agent', 'unify', 'threads', 'engine-instance.js'
);

describe('web-bridge conversation history (task-310 Phase 2 pipeline)', () => {
  const src = readFileSync(WEB_BRIDGE_PATH, 'utf8');

  it('declares conversationMessages module-level array', () => {
    expect(src).toContain('let conversationMessages = []');
  });

  it('routes unify_chat through the Dispatcher pipeline (not engine.query directly)', () => {
    // Dispatcher.submit() + drain() is the new entry point.
    expect(src).toContain('session.dispatcher.submit(');
    expect(src).toContain('session.dispatcher.drain(');
    // The direct `session.engine.query({ prompt, messages: conversationMessages })`
    // call site must be gone — it would bypass the queue + router.
    expect(src).not.toContain('session.engine.query({');
  });

  it('collects assistant text from text_delta engine events', () => {
    // The handler pushes to assistantTextParts when the engine yields text_delta.
    expect(src).toContain('assistantTextParts.push(event.text)');
  });

  it('appends cleaned user prompt to conversationMessages after drain completes', () => {
    // @thread-xxx prefixes are stripped before routing; the message we
    // record is the cleaned prompt, not the raw `prompt`.
    expect(src).toContain("conversationMessages.push({ role: 'user', content: cleanedPrompt })");
  });

  it('appends assistant message with plain text content after drain completes', () => {
    expect(src).toContain("conversationMessages.push({ role: 'assistant', content: fullText })");
  });

  it('builds fullText from collected text parts', () => {
    expect(src).toContain('assistantTextParts.join');
  });

  it('only appends assistant message when fullText is non-empty', () => {
    expect(src).toContain('if (fullText)');
  });

  it('clears conversationMessages on consolidation event (inside engine-event handler)', () => {
    // handleEngineEvent owns the consolidate case now; the array clear
    // must live inside that switch.
    const consolidateSection = src.slice(
      src.indexOf("case 'consolidate':"),
      src.indexOf("case 'consolidate':") + 300
    );
    expect(consolidateSection).toContain('conversationMessages = []');
  });

  it('clears conversationMessages on session reset', () => {
    const resetSection = src.slice(
      src.indexOf('async function resetUnifySession'),
      src.indexOf('async function resetUnifySession') + 500
    );
    expect(resetSection).toContain('conversationMessages = []');
  });

  it('preserves the permission-error one-time diagnostic filter', () => {
    // Flag + comment + early bail must still be present after the
    // handleEngineEvent extraction (rev-1 nit).
    expect(src).toContain('_permissionDiagnosticSent');
    expect(src).toMatch(/Filter permission errors/);
    expect(src).toMatch(/Don't show subsequent permission errors/);
  });

  it('does NOT collect tool_use blocks into conversationMessages (regression guard)', () => {
    expect(src).not.toContain('assistantToolUseBlocks');
  });

  it('stores assistant content as plain string, not content-block array (regression guard)', () => {
    expect(src).not.toContain("assistantContent.push({ type: 'text'");
    expect(src).not.toContain('content: assistantContent');
  });

  it('strips @thread-<id> prefix before submitting to dispatcher', () => {
    // parseThreadPrefix is called and its `prompt` field is what the
    // dispatcher actually receives (not the raw user-typed text).
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
    // Phase 2: the messages array is owned by EngineInstance and
    // forwarded into engine.query as `messages: snapshot` (or similar).
    const instSrc = readFileSync(ENGINE_INSTANCE_PATH, 'utf8');
    expect(instSrc).toMatch(/messages:\s*\w+/);
  });
});
