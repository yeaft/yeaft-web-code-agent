/**
 * task-320: per-thread in-flight state tests.
 *
 * Encodes the exact invariants that protect multi-thread concurrency:
 *
 *   (a) SAME-thread sequential sends: the second send aborts the first.
 *       Enforced by the `abortByThread.get(resolvedThreadId)` lookup +
 *       `prior.abort()` guarded on a threadId match.
 *
 *   (b) DIFFERENT-thread concurrent sends: neither aborts the other,
 *       because the registry is keyed by threadId (the Map itself) and
 *       the abort gate only fires on a collision for that same key.
 *
 *   (c) LLMAbortError classification: an aborted round must NOT render
 *       a "Session error: Request aborted" bubble. The catch branch
 *       treats both `AbortError` and `LLMAbortError` as silent aborts.
 *
 *   (d) Session reset aborts EVERY in-flight controller across threads,
 *       then clears the registry.
 *
 *   (e) A controller clears its slot on completion ONLY if it's still
 *       the registered owner for that thread (so a newer message's
 *       controller isn't wiped by the older round's finally).
 *
 * The bridge lazy-initializes a real session via loadSession() which
 * pulls MCP + skills + filesystem — too heavyweight to mock for a unit
 * test. These structural assertions pin the source contract with the
 * same rigor as the other web-bridge.*.test.js files.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WEB_BRIDGE_PATH = join(
  import.meta.dirname, '..', '..', '..', 'agent', 'unify', 'web-bridge.js'
);

describe('task-320: per-thread in-flight state (abortByThread)', () => {
  const src = readFileSync(WEB_BRIDGE_PATH, 'utf8');

  it('declares a module-level abortByThread Map', () => {
    expect(src).toContain('const abortByThread = new Map()');
  });

  it('removes the single-flight `currentAbort` singleton', () => {
    expect(src).not.toContain('let currentAbort');
    expect(src).not.toMatch(/currentAbort\s*=\s*new AbortController/);
    expect(src).not.toMatch(/currentAbort\.abort\(\)/);
  });

  it('each handleUnifyChat call owns a local AbortController (abortCtrl)', () => {
    // Per-call controller is the workhorse; abortByThread only registers
    // it once the router resolves the thread.
    expect(src).toMatch(/const abortCtrl = new AbortController\(\)/);
    expect(src).toMatch(/signal:\s*abortCtrl\.signal/);
  });

  it('resolves target thread from the routing_decision pipeline event', () => {
    expect(src).toContain("pev.type === 'routing_decision'");
    expect(src).toContain('pev.targetThreadId');
    expect(src).toMatch(/resolvedThreadId\s*=\s*pev\.targetThreadId/);
  });

  it('aborts only the prior controller for the SAME resolved thread', () => {
    // Look up the current owner of the slot, bail if it's the same
    // instance we just made (shouldn't happen but defensive), otherwise
    // abort it. Different threads can never reach this branch because
    // they key into a different Map slot.
    expect(src).toMatch(/abortByThread\.get\(\s*resolvedThreadId\s*\)/);
    expect(src).toMatch(/prior\s*&&\s*prior\s*!==\s*abortCtrl[\s\S]{0,80}prior\.abort\(\)/);
    expect(src).toMatch(/abortByThread\.set\(\s*resolvedThreadId\s*,\s*abortCtrl\s*\)/);
  });

  it('clears the slot on completion only if still the registered owner', () => {
    // Prevents a slow older round from wiping a fresher controller.
    expect(src).toMatch(
      /abortByThread\.get\(\s*resolvedThreadId\s*\)\s*===\s*abortCtrl[\s\S]{0,120}abortByThread\.delete\(\s*resolvedThreadId\s*\)/
    );
  });

  it('classifies LLMAbortError as a silent abort (no session-error bubble)', () => {
    // Both DOM AbortError and our LLMAbortError must reach the early
    // `return` that suppresses the error rendering.
    expect(src).toContain('LLMAbortError');
    // A single predicate gates both names; match either ordering.
    expect(src).toMatch(/(AbortError[\s\S]{0,80}LLMAbortError|LLMAbortError[\s\S]{0,80}AbortError)/);
    // The error-bubble branch must live AFTER the abort early-return.
    const abortIdx = src.search(/LLMAbortError/);
    const sessionErrorIdx = src.search(/Session error:/);
    expect(abortIdx).toBeGreaterThan(0);
    expect(sessionErrorIdx).toBeGreaterThan(abortIdx);
  });

  it('does NOT emit a "Query timed out" bubble on abort (was wrong for multi-thread)', () => {
    // The old single-flight code rendered a "Query timed out" assistant
    // bubble whenever AbortError fired — but in the new multi-thread world
    // the abort is usually caused by the NEXT message on the same thread,
    // not a true timeout. Drop the bubble; let the new round speak.
    expect(src).not.toContain('Query timed out — no response from LLM');
  });

  it('resetUnifySession aborts every in-flight controller across all threads', () => {
    const resetIdx = src.indexOf('async function resetUnifySession');
    expect(resetIdx).toBeGreaterThan(-1);
    const section = src.slice(resetIdx, resetIdx + 1200);
    // Walk every registered controller, abort, then clear the registry.
    expect(section).toMatch(/abortByThread\.values\(\)/);
    expect(section).toMatch(/ctrl\.abort\(\)/);
    expect(section).toContain('abortByThread.clear()');
  });
});

describe('task-320: per-thread conversation history (messagesByThread)', () => {
  const src = readFileSync(WEB_BRIDGE_PATH, 'utf8');

  it('declares a module-level messagesByThread Map', () => {
    expect(src).toContain('const messagesByThread = new Map()');
  });

  it('removes the flat conversationMessages singleton', () => {
    expect(src).not.toContain('let conversationMessages');
    expect(src).not.toContain('conversationMessages =');
    expect(src).not.toContain('conversationMessages.push');
  });

  it('appends to the per-thread bucket resolved from the router', () => {
    expect(src).toMatch(/threadMessages\.push\(\{\s*role:\s*'user',\s*content:\s*cleanedPrompt\s*\}\)/);
    // task-fix (three-bugs): the assistant push is now through an
    // `assistantMsg` variable so toolCalls can be attached first.
    expect(src).toMatch(/const assistantMsg = \{ role: 'assistant', content: fullText \}/);
    expect(src).toContain('threadMessages.push(assistantMsg)');
  });

  it('consolidate event clears only the emitting thread\'s bucket', () => {
    const caseIdx = src.indexOf("case 'consolidate':");
    expect(caseIdx).toBeGreaterThan(-1);
    const section = src.slice(caseIdx, caseIdx + 400);
    // Scoped set-to-empty when threadId is known.
    expect(section).toMatch(/messagesByThread\.set\(\s*threadId\s*,\s*\[\]\s*\)/);
  });

  it('session reset clears the whole messagesByThread Map', () => {
    const resetIdx = src.indexOf('async function resetUnifySession');
    const section = src.slice(resetIdx, resetIdx + 1200);
    expect(section).toContain('messagesByThread.clear()');
  });

  it('restores per-thread history buckets on lazy-init from persisted store', () => {
    // Each loaded message routes into its own thread bucket (m.threadId).
    expect(src).toMatch(/m\.threadId\s*\|\|\s*MAIN_THREAD_ID/);
    expect(src).toMatch(/getThreadMessages\(\s*tid\s*\)/);
  });
});
