import { describe, expect, it } from 'vitest';
import { executionBehavior, executionOrientation } from '../../../../agent/yeaft/person/behavior.js';

describe('Person entry behavior', () => {
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
