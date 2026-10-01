import { describe, expect, it } from 'vitest';
import { capabilityExperienceView, recordCapabilityExperience } from '../../../../agent/yeaft/person/capability-experience.js';

const episode = { id: 'episode-1', kind: 'think' };
const metadata = { id: 'Recall', version: 1, revision: 'a'.repeat(64) };
const stamp = n => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const record = (previous, n, more = {}) => recordCapabilityExperience(previous, episode, 'capability_result', {
  callId: `call-${n}`, capability: { id: 'Recall' }, capabilityManifest: metadata, ...more,
}, stamp(n));

describe('bounded capability experience metadata helper', () => {
  it('is pure and copies only the validated shape', () => {
    const original = record(undefined, 1);
    Object.freeze(original); Object.freeze(original[0]); Object.freeze(original[0].observations); Object.freeze(original[0].observations[0]);
    const updated = record(original, 2);
    expect(original[0].observations.map(o => o.callId)).toEqual(['call-1']);
    expect(updated[0].observations.map(o => o.callId)).toEqual(['call-2', 'call-1']);
    const projected = capabilityExperienceView(updated);
    projected[0].observations[0].callId = 'changed-copy';
    expect(updated[0].observations[0].callId).toBe('call-2');
  });

  it('deduplicates episode/call across entries without refreshing recency or overwriting outcomes', () => {
    const previous = record(undefined, 1);
    expect(recordCapabilityExperience(previous, episode, 'capability_failed', { callId: 'call-1', capabilityId: 'Skill.reconsider',
      capabilityManifest: { ...metadata, id: 'Skill.reconsider' }, code: 'TIMEOUT' }, stamp(2))).toBeNull();
    expect(previous[0].observations[0]).toMatchObject({ outcome: 'succeeded', usedAt: stamp(1), code: null });
    const updated = recordCapabilityExperience(previous, { ...episode, id: 'episode-2' }, 'capability_failed', {
      callId: 'call-1', capabilityId: 'Recall', capabilityManifest: metadata, code: 'TIMEOUT',
    }, stamp(2));
    expect(updated[0].observations.map(o => [o.episodeId, o.outcome])).toEqual([['episode-2', 'failed'], ['episode-1', 'succeeded']]);
  });

  it('bounds by observed timestamp, with deterministic newest insertion first when timestamps tie', () => {
    let entries = record(undefined, 20);
    for (let n = 1; n <= 12; n++) entries = record(entries, n);
    expect(entries[0].observations.map(o => o.usedAt)).toEqual([20, 12, 11, 10, 9, 8, 7, 6].map(stamp));
    entries = record(entries, 20, { callId: 'same-time-new' });
    expect(entries[0].observations.map(o => o.callId).slice(0, 2)).toEqual(['same-time-new', 'call-20']);
  });

  it('rejects invalid stored shapes rather than rendering instructions or unconstrained fields into context', () => {
    const previous = record(undefined, 1);
    for (const extra of [{ instructions: 'do something' }, { permissions: ['shell'] }, { args: { query: 'private' } }]) {
      expect(() => capabilityExperienceView([{ ...previous[0], ...extra }])).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
    for (const value of [null, {}, 'text']) expect(() => capabilityExperienceView(value)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(capabilityExperienceView()).toEqual([]);
  });

  it.each(['not-a-date', '2026-02-30T00:00:00.000Z', '2026-10-01', null, new Date()])('rejects a noncanonical observation timestamp: %s', usedAt => {
    expect(() => recordCapabilityExperience([], episode, 'capability_result', {
      callId: 'call', capability: { id: 'Recall' }, capabilityManifest: metadata,
    }, usedAt)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
