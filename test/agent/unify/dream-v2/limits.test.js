/**
 * dream-v2/limits.test.js — §18
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_LIMITS, loadLimitsFromConfig } from '../../../../agent/unify/dream-v2/limits.js';

describe('limits', () => {
  it('exposes the documented defaults', () => {
    // task-710: interval was 12h; cut to 1h so freshly opened agents
    // don't have to wait half a day for memory writes.
    expect(DEFAULT_LIMITS.DREAM_INTERVAL_HOURS).toBe(1);
    expect(DEFAULT_LIMITS.DREAM_OVERLAP).toBe(3);
    expect(DEFAULT_LIMITS.MIN_NEW_PER_GROUP).toBe(20);
    expect(DEFAULT_LIMITS.MAX_SINGLE_MESSAGE_CHARS).toBe(8000);
    expect(DEFAULT_LIMITS.MAX_DIFF_TOKENS_PER_TRIAGE).toBe(60000);
    expect(DEFAULT_LIMITS.MAX_APPLY_TOKENS).toBe(80000);
    expect(DEFAULT_LIMITS.DREAM_BACKUP_KEEP).toBe(7);
    // task-710: nudge threshold for noteUserMessage().
    expect(DEFAULT_LIMITS.DREAM_NUDGE_AFTER_MESSAGES).toBe(50);
  });
  it('loadLimitsFromConfig overrides only valid positive numbers', () => {
    const merged = loadLimitsFromConfig({
      unify: {
        dream: {
          DREAM_OVERLAP: 5,
          MIN_NEW_PER_GROUP: 'not-a-number',
          MAX_APPLY_TOKENS: -10,    // ignored
          UNKNOWN: 9999,            // ignored
        },
      },
    });
    expect(merged.DREAM_OVERLAP).toBe(5);
    expect(merged.MIN_NEW_PER_GROUP).toBe(DEFAULT_LIMITS.MIN_NEW_PER_GROUP);
    expect(merged.MAX_APPLY_TOKENS).toBe(DEFAULT_LIMITS.MAX_APPLY_TOKENS);
  });
  it('returns defaults for missing config block', () => {
    expect(loadLimitsFromConfig(undefined)).toEqual(DEFAULT_LIMITS);
    expect(loadLimitsFromConfig({})).toEqual(DEFAULT_LIMITS);
  });
});
