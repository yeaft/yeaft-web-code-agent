/**
 * Phase 4 — compact triggers (DESIGN.md §4.1).
 *
 * Pin the trigger conditions before the orchestrator wires onto them.
 */

import { describe, it, expect } from 'vitest';
import { evaluateCompactTriggers } from '../../../../agent/unify/compact/triggers.js';

describe('evaluateCompactTriggers', () => {
  it('no triggers under all thresholds', () => {
    const out = evaluateCompactTriggers({
      messages: new Array(10),
      tokenCount: 1000,
      contextLimit: 200000,
    });
    expect(out).toEqual({ trigger: false, reasons: [] });
  });

  it('fires token_threshold above 90% of contextLimit', () => {
    const out = evaluateCompactTriggers({
      messages: [],
      tokenCount: 181000,
      contextLimit: 200000,
    });
    expect(out.trigger).toBe(true);
    expect(out.reasons).toContain('token_threshold');
  });

  it('does not fire token_threshold at 90% exactly', () => {
    const out = evaluateCompactTriggers({
      messages: [],
      tokenCount: 180000,
      contextLimit: 200000,
    });
    expect(out.reasons).not.toContain('token_threshold');
  });

  it('fires message_count when length > 50', () => {
    const out = evaluateCompactTriggers({
      messages: new Array(51),
      tokenCount: 0,
      contextLimit: 200000,
    });
    expect(out.reasons).toContain('message_count');
  });

  it('does not fire message_count at 50', () => {
    const out = evaluateCompactTriggers({
      messages: new Array(50),
      tokenCount: 0,
      contextLimit: 200000,
    });
    expect(out.reasons).not.toContain('message_count');
  });

  it('fires idle when last activity > 2 minutes ago', () => {
    const now = Date.now();
    const out = evaluateCompactTriggers({
      messages: [],
      tokenCount: 0,
      contextLimit: 200000,
      lastActivityAt: now - 130_000, // 2m10s ago
      now,
    });
    expect(out.reasons).toContain('idle');
  });

  it('idle quiet under threshold', () => {
    const now = Date.now();
    const out = evaluateCompactTriggers({
      messages: [],
      tokenCount: 0,
      contextLimit: 200000,
      lastActivityAt: now - 30_000,
      now,
    });
    expect(out.reasons).not.toContain('idle');
  });

  it('explicit always fires', () => {
    const out = evaluateCompactTriggers({
      messages: [],
      tokenCount: 0,
      contextLimit: 200000,
      explicit: true,
    });
    expect(out.trigger).toBe(true);
    expect(out.reasons).toContain('explicit');
  });

  it('records every triggered reason simultaneously', () => {
    const now = Date.now();
    const out = evaluateCompactTriggers({
      messages: new Array(60),
      tokenCount: 200000,
      contextLimit: 200000,
      lastActivityAt: now - 10 * 60 * 1000,
      now,
      explicit: true,
    });
    expect(out.reasons.sort()).toEqual(['explicit', 'idle', 'message_count', 'token_threshold']);
  });

  it('respects custom thresholds', () => {
    const out = evaluateCompactTriggers({
      messages: new Array(11),
      tokenCount: 0,
      contextLimit: 100000,
      maxMessages: 10,
    });
    expect(out.reasons).toContain('message_count');
  });

  it('zero contextLimit disables token gate', () => {
    const out = evaluateCompactTriggers({
      messages: [],
      tokenCount: 1_000_000,
      contextLimit: 0,
    });
    expect(out.reasons).not.toContain('token_threshold');
  });
});
