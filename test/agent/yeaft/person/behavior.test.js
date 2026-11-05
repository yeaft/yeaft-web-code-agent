import { describe, expect, it } from 'vitest';
import { executionBehavior, executionOrientation } from '../../../../agent/yeaft/person/behavior.js';
import { PERSON_REPLY_INSTRUCTIONS } from '../../../../agent/yeaft/person/reply-guidance.js';
import { EXECUTION_INSTRUCTIONS } from '../../../../agent/yeaft/person/execution-protocol.js';
import { PROPOSAL_INSTRUCTIONS } from '../../../../agent/yeaft/person/contracts.js';
import { personFinalContextReserveBytes, personMinimumRequestBytes, PERSON_FINAL_CONTEXT_RESERVE_BYTES } from '../../../../agent/yeaft/person/request-budget.js';

describe('Person entry behavior', () => {
  it('shares calibrated judgment and adaptive public delivery across both budgeted phases', () => {
    for (const instructions of [EXECUTION_INSTRUCTIONS, PROPOSAL_INSTRUCTIONS]) {
      expect(instructions.split(PERSON_REPLY_INSTRUCTIONS)).toHaveLength(2);
    }
    for (const clause of ['Objectivity means proportionate weight', 'Do not manufacture certainty',
      'comparable evidence', 'not endorsing every premise', 'not a fixed report template',
      'answer the new point', 'never invent human experiences', 'use reply:null']) {
      expect(PERSON_REPLY_INSTRUCTIONS).toContain(clause);
    }
    // Shared text must cost real bytes, not disappear from readiness/reserves.
    const encodedBytes = value => Buffer.byteLength(value, 'utf8');
    const withoutReply = EXECUTION_INSTRUCTIONS.replace(PERSON_REPLY_INSTRUCTIONS, '');
    const schemas = [{ name: 'fixture', input_schema: { type: 'object' } }];
    expect(personMinimumRequestBytes(schemas, EXECUTION_INSTRUCTIONS)).toBe(
      encodedBytes(JSON.stringify(schemas)) + Math.max(encodedBytes(EXECUTION_INSTRUCTIONS), encodedBytes(PROPOSAL_INSTRUCTIONS)) +
      2 + PERSON_FINAL_CONTEXT_RESERVE_BYTES);
    expect(personFinalContextReserveBytes(withoutReply) - personFinalContextReserveBytes(EXECUTION_INSTRUCTIONS))
      .toBe(encodedBytes(PERSON_REPLY_INSTRUCTIONS));
  });

  it('grounds each trigger before tools without forcing per-step cognition, novelty or a monetary proxy', () => {
    const send = executionBehavior('send'), think = executionBehavior('think'), dream = executionBehavior('dream');
    for (const value of [send, think, dream]) {
      expect(value).toContain('real interests');
      expect(value).toContain('futures');
      expect(value).toContain('hypothesis');
      expect(value).toContain('low-cost');
      expect(value).toContain('newest');
      expect(value).toContain('not permission');
      expect(value).toContain('persona');
      expect(value).toContain('No compulsory');
      expect(value).toContain('not a per-step');
      expect(value).toContain('quiet rest');
    }
    expect(send).toContain('current user request');
    expect(think).toContain('concrete');
    expect(dream).toContain('older');
    expect(dream).toContain('premise');
    expect(think).toContain('scheduler');
    expect(new Set([send, think, dream]).size).toBe(3);
    expect(() => executionBehavior('unexpected')).toThrow();
    expect(executionBehavior('autonomous', { reason: 'idle' })).toContain('Dream:');
    expect(executionBehavior('autonomous', { reason: 'task-completion' })).toContain('Think:');
    expect(executionBehavior('autonomous')).toContain('observation-only');
    expect(executionOrientation('autonomous', { reason: 'idle' })).toBe('dream');
  });
});
