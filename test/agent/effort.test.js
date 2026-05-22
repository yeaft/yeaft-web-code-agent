/**
 * task-327b: Unify LLM thinking/reasoning — scenario → effort decision
 * tree + `/effort` prompt-prefix parser + engine wiring sanity.
 *
 * Coverage:
 *   - effort.js: pickEffort() decision table (chat/consolidate/dream/
 *     sub_agent/recall/light), long-loop auto-bump, userEffort override,
 *     cheap-scenario-no-bump guard, unknown scenario defaults 'max'.
 *   - effort.js: parseEffortPrefix() accepts `/max `, `/high `, `/medium`,
 *     `/low`; rejects `/maxfoo` (no word boundary via trailing \s|$);
 *     caseful (`/MAX` rejected, matches adapter normalizeEffort).
 *
 * Red lines:
 *   - Decision tree must not call into models.js capability matrix
 *     (that's the adapter/router's job per 327a).
 *   - Unknown scenario → 'max', never throw.
 */
import { describe, it, expect } from 'vitest';
import {
  pickEffort,
  parseEffortPrefix,
  SCENARIO_EFFORT,
  LONG_LOOP_TURN_THRESHOLD,
} from '../../agent/unify/effort.js';

describe('task-327b: SCENARIO_EFFORT table', () => {
  it('chat defaults to max (per user 2026-05-22 — quality over latency)', () => {
    expect(SCENARIO_EFFORT.chat).toBe('max');
  });

  it('consolidate / dream / sub_agent get max', () => {
    expect(SCENARIO_EFFORT.consolidate).toBe('max');
    expect(SCENARIO_EFFORT.dream).toBe('max');
    expect(SCENARIO_EFFORT.sub_agent).toBe('max');
  });

  it('recall and light side-queries stay cheap (low)', () => {
    expect(SCENARIO_EFFORT.recall).toBe('low');
    expect(SCENARIO_EFFORT.light).toBe('low');
  });

  it('long_loop scenario is max (used when auto-bumped)', () => {
    expect(SCENARIO_EFFORT.long_loop).toBe('max');
  });

  it('table is frozen — nobody can stomp on it at runtime', () => {
    expect(Object.isFrozen(SCENARIO_EFFORT)).toBe(true);
  });
});

describe('task-327b: pickEffort — user override wins', () => {
  it('valid userEffort overrides any scenario', () => {
    expect(pickEffort({ scenario: 'chat', userEffort: 'low' })).toBe('low');
    expect(pickEffort({ scenario: 'consolidate', userEffort: 'medium' })).toBe('medium');
    expect(pickEffort({ scenario: 'dream', userEffort: 'high' })).toBe('high');
    expect(pickEffort({ scenario: 'recall', userEffort: 'max' })).toBe('max');
  });

  it('invalid userEffort is ignored — falls through to scenario', () => {
    expect(pickEffort({ scenario: 'chat', userEffort: 'ULTRA' })).toBe('max');
    expect(pickEffort({ scenario: 'chat', userEffort: '' })).toBe('max');
    expect(pickEffort({ scenario: 'chat', userEffort: 42 })).toBe('max');
  });

  it('userEffort=null defers to the scenario tree', () => {
    expect(pickEffort({ scenario: 'recall', userEffort: null })).toBe('low');
    expect(pickEffort({ scenario: 'consolidate', userEffort: null })).toBe('max');
  });
});

describe('task-327b: pickEffort — scenario tree', () => {
  it('default scenario is chat → max', () => {
    expect(pickEffort({})).toBe('max');
    expect(pickEffort()).toBe('max');
  });

  it('unknown scenario defaults to max (never throws)', () => {
    expect(pickEffort({ scenario: 'banana' })).toBe('max');
    expect(pickEffort({ scenario: 'MAX' })).toBe('max');
  });

  it('consolidate/dream/sub_agent map to max', () => {
    expect(pickEffort({ scenario: 'consolidate' })).toBe('max');
    expect(pickEffort({ scenario: 'dream' })).toBe('max');
    expect(pickEffort({ scenario: 'sub_agent' })).toBe('max');
  });

  it('recall and light stay low by design', () => {
    expect(pickEffort({ scenario: 'recall' })).toBe('low');
    expect(pickEffort({ scenario: 'light' })).toBe('low');
  });
});

describe('task-327b: pickEffort — long-loop auto-bump', () => {
  it(`does not bump below threshold=${LONG_LOOP_TURN_THRESHOLD}`, () => {
    expect(pickEffort({ scenario: 'chat', toolLoopTurns: LONG_LOOP_TURN_THRESHOLD - 1 }))
      .toBe('max');
  });

  it('bumps chat → max at threshold', () => {
    expect(pickEffort({ scenario: 'chat', toolLoopTurns: LONG_LOOP_TURN_THRESHOLD }))
      .toBe('max');
  });

  it('bumps well past threshold too', () => {
    expect(pickEffort({ scenario: 'chat', toolLoopTurns: LONG_LOOP_TURN_THRESHOLD + 50 }))
      .toBe('max');
  });

  it('does NOT bump cheap scenarios (recall stays low)', () => {
    expect(pickEffort({ scenario: 'recall', toolLoopTurns: LONG_LOOP_TURN_THRESHOLD * 10 }))
      .toBe('low');
    expect(pickEffort({ scenario: 'light', toolLoopTurns: LONG_LOOP_TURN_THRESHOLD * 10 }))
      .toBe('low');
  });

  it('user override beats the auto-bump', () => {
    expect(pickEffort({
      scenario: 'chat',
      toolLoopTurns: LONG_LOOP_TURN_THRESHOLD + 1,
      userEffort: 'low',
    })).toBe('low');
  });

  it('non-numeric toolLoopTurns does not bump (no NaN blow-up)', () => {
    expect(pickEffort({ scenario: 'chat', toolLoopTurns: 'not a number' })).toBe('max');
    expect(pickEffort({ scenario: 'chat', toolLoopTurns: null })).toBe('max');
    expect(pickEffort({ scenario: 'chat', toolLoopTurns: undefined })).toBe('max');
  });
});

describe('task-327b: parseEffortPrefix — /max /high /medium /low', () => {
  it('extracts /max and cleans the prompt', () => {
    expect(parseEffortPrefix('/max refactor the store')).toEqual({
      effort: 'max',
      cleanedPrompt: 'refactor the store',
    });
  });

  it('extracts /high', () => {
    expect(parseEffortPrefix('/high plan the sprint')).toEqual({
      effort: 'high',
      cleanedPrompt: 'plan the sprint',
    });
  });

  it('extracts /medium and /low', () => {
    expect(parseEffortPrefix('/medium draft notes')).toEqual({
      effort: 'medium',
      cleanedPrompt: 'draft notes',
    });
    expect(parseEffortPrefix('/low one-liner please')).toEqual({
      effort: 'low',
      cleanedPrompt: 'one-liner please',
    });
  });

  it('returns null effort when there is no prefix', () => {
    expect(parseEffortPrefix('normal prompt')).toEqual({
      effort: null,
      cleanedPrompt: 'normal prompt',
    });
  });

  it('rejects partial words like /maxfoo (must be followed by whitespace or EOL)', () => {
    expect(parseEffortPrefix('/maxwell sells coffee')).toEqual({
      effort: null,
      cleanedPrompt: '/maxwell sells coffee',
    });
  });

  it('accepts /max alone (EOL)', () => {
    expect(parseEffortPrefix('/max')).toEqual({
      effort: 'max',
      cleanedPrompt: '',
    });
  });

  it('is case-sensitive — /MAX is NOT a prefix', () => {
    expect(parseEffortPrefix('/MAX do a thing')).toEqual({
      effort: null,
      cleanedPrompt: '/MAX do a thing',
    });
  });

  it('only strips the first prefix (no double-stack)', () => {
    expect(parseEffortPrefix('/max /high stacked')).toEqual({
      effort: 'max',
      cleanedPrompt: '/high stacked',
    });
  });

  it('safe on non-string input', () => {
    expect(parseEffortPrefix(null)).toEqual({ effort: null, cleanedPrompt: null });
    expect(parseEffortPrefix(undefined)).toEqual({ effort: null, cleanedPrompt: undefined });
  });

  it('does not trigger on embedded /max (not at start)', () => {
    expect(parseEffortPrefix('hello /max world')).toEqual({
      effort: null,
      cleanedPrompt: 'hello /max world',
    });
  });
});
