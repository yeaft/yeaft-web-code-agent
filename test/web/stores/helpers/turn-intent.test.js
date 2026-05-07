// test/web/stores/helpers/turn-intent.test.js
import { describe, it, expect } from 'vitest';
import { deriveTurnIntent } from '../../../../web/stores/helpers/turn-intent.js';

describe('deriveTurnIntent', () => {
  it("returns 'quick' when turn has no speakerVpId or turnId", () => {
    expect(deriveTurnIntent({}, {})).toBe('quick');
    expect(deriveTurnIntent({ speakerVpId: 'jobs' }, {})).toBe('quick');
    expect(deriveTurnIntent({ turnId: 't1' }, {})).toBe('quick');
  });

  it("returns 'quick' when previewMap has no matching entry (Track-A pending or failed)", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    expect(deriveTurnIntent(turn, {})).toBe('quick');
    expect(deriveTurnIntent(turn, { 'jobs:other': { intent: 'feature' } })).toBe('quick');
  });

  it("returns the preview's intent when key matches", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'feature', preview: 'building...' } };
    expect(deriveTurnIntent(turn, map)).toBe('feature');
  });

  it("returns 'quick' when matched entry has intent='quick'", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'quick', preview: 'sure' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });

  it("falls back to 'quick' if intent is malformed", () => {
    const turn = { speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'garbage' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(deriveTurnIntent(null, null)).toBe('quick');
    expect(deriveTurnIntent(undefined, undefined)).toBe('quick');
  });
});
