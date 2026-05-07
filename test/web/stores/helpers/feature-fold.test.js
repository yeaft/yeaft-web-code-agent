/**
 * Tests for PR-2 feature-pill double-track folding helpers.
 *
 * These cover the pure logic that drives:
 *   - Folding consecutive feature-tagged turns into a single `feature-pill`
 *     row in MessageList.turnGroups.
 *   - Inserting Track-A quick-preview marker rows immediately before the
 *     assistant-turn whose vpId:turnId matches.
 *
 * Both helpers are extracted into a separate module so we can test them
 * without spinning up Vue / Pinia / DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  featureIdOfTurn,
  isFoldable,
  foldByFeatureId,
  injectQuickPreviews,
} from '../../../../web/stores/helpers/feature-fold.js';

describe('featureIdOfTurn', () => {
  it('reads featureId from any inner message of an assistant-turn', () => {
    const item = {
      type: 'assistant-turn',
      messages: [
        { id: 'm1', featureId: null },     // skipped
        { id: 'm2', featureId: 'feat-7' }, // matched
        { id: 'm3', featureId: 'feat-9' }, // first-wins, ignored
      ],
    };
    expect(featureIdOfTurn(item)).toBe('feat-7');
  });

  it('returns null for an untagged assistant-turn', () => {
    expect(featureIdOfTurn({ type: 'assistant-turn', messages: [{ id: 'a', featureId: null }] }))
      .toBeNull();
  });

  it('falls back to item.featureId when assistant-turn has empty messages (typing placeholder)', () => {
    // PR-2 review fix (Fowler I1): a typing-placeholder turn synthesised
    // between vp_typing_start and the first delta carries no inner
    // messages yet, so the helper must read featureId off the item itself
    // — otherwise the placeholder appears untagged and breaks an
    // in-flight feature run, snapping the pill shut for the typing gap.
    expect(featureIdOfTurn({ type: 'assistant-turn', messages: [], featureId: 'feat-Q' }))
      .toBe('feat-Q');
  });

  it('prefers an inner message featureId over item.featureId when both exist', () => {
    // The inner-message latch is the source of truth once delta arrives;
    // the item-level fallback is only for the empty-placeholder window.
    const item = {
      type: 'assistant-turn',
      featureId: 'feat-stale',
      messages: [{ featureId: 'feat-fresh' }],
    };
    expect(featureIdOfTurn(item)).toBe('feat-fresh');
  });

  it('returns null for a user / system / error / unknown item', () => {
    expect(featureIdOfTurn({ type: 'user' })).toBeNull();
    expect(featureIdOfTurn({ type: 'system' })).toBeNull();
    expect(featureIdOfTurn({ type: 'error' })).toBeNull();
    expect(featureIdOfTurn({ type: 'whatever' })).toBeNull();
    expect(featureIdOfTurn(null)).toBeNull();
    expect(featureIdOfTurn(undefined)).toBeNull();
  });
});

describe('isFoldable', () => {
  it('treats only assistant-turn as foldable', () => {
    expect(isFoldable({ type: 'assistant-turn' })).toBe(true);
  });
  it('rejects user / system / error / quick-preview / null', () => {
    expect(isFoldable({ type: 'user' })).toBe(false);
    expect(isFoldable({ type: 'system' })).toBe(false);
    expect(isFoldable({ type: 'error' })).toBe(false);
    expect(isFoldable({ type: 'quick-preview' })).toBe(false);
    expect(isFoldable(null)).toBe(false);
  });
});

describe('foldByFeatureId', () => {
  it('returns the input untouched when no items have featureIds', () => {
    const items = [
      { type: 'user', id: 'u1', message: {} },
      { type: 'assistant-turn', id: 't1', messages: [{ id: 'm1' }] },
      { type: 'system', id: 's1', message: {} },
    ];
    const out = foldByFeatureId(items);
    expect(out).toEqual(items);
  });

  it('folds two consecutive turns sharing a featureId into a single feature-pill', () => {
    const t1 = { type: 'assistant-turn', id: 't1', messages: [{ featureId: 'feat-A' }] };
    const t2 = { type: 'assistant-turn', id: 't2', messages: [{ featureId: 'feat-A' }] };
    const out = foldByFeatureId([t1, t2]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('feature-pill');
    expect(out[0].featureId).toBe('feat-A');
    expect(out[0].turns).toEqual([t1, t2]);
  });

  it('does NOT merge across a user message break', () => {
    const t1 = { type: 'assistant-turn', id: 't1', messages: [{ featureId: 'feat-A' }] };
    const u  = { type: 'user', id: 'u', message: { content: 'next ?' } };
    const t2 = { type: 'assistant-turn', id: 't2', messages: [{ featureId: 'feat-A' }] };
    const out = foldByFeatureId([t1, u, t2]);
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe('feature-pill');
    expect(out[0].turns).toEqual([t1]);
    expect(out[1]).toBe(u);
    expect(out[2].type).toBe('feature-pill');
    expect(out[2].turns).toEqual([t2]);
  });

  it('starts a new pill when the featureId changes between adjacent turns', () => {
    const t1 = { type: 'assistant-turn', id: 't1', messages: [{ featureId: 'feat-A' }] };
    const t2 = { type: 'assistant-turn', id: 't2', messages: [{ featureId: 'feat-B' }] };
    const out = foldByFeatureId([t1, t2]);
    expect(out).toHaveLength(2);
    expect(out[0].featureId).toBe('feat-A');
    expect(out[1].featureId).toBe('feat-B');
  });

  it('lets an untagged turn (no featureId) break the run', () => {
    const t1 = { type: 'assistant-turn', id: 't1', messages: [{ featureId: 'feat-A' }] };
    const t2 = { type: 'assistant-turn', id: 't2', messages: [{ featureId: null }] };
    const t3 = { type: 'assistant-turn', id: 't3', messages: [{ featureId: 'feat-A' }] };
    const out = foldByFeatureId([t1, t2, t3]);
    // t1 → pill, t2 → standalone, t3 → pill (separate from t1's because t2 broke the run)
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe('feature-pill');
    expect(out[0].turns).toEqual([t1]);
    expect(out[1]).toBe(t2);
    expect(out[2].type).toBe('feature-pill');
    expect(out[2].turns).toEqual([t3]);
  });

  it('produces a stable pill id derived from the featureId AND the first turn id', () => {
    // PR-2 review fix (C1): pill id includes the first turn id so two
    // non-contiguous runs sharing a featureId get distinct Vue keys.
    const t = { type: 'assistant-turn', id: 't1', messages: [{ featureId: 'feat-XYZ' }] };
    const out = foldByFeatureId([t]);
    expect(out[0].id).toBe('feature_feat-XYZ_t1');
  });

  it('emits DISTINCT pill ids for two non-contiguous runs sharing a featureId (C1)', () => {
    // Without the firstTurnId disambiguator, both pills would have id
    // "feature_feat-A" and Vue's keyed reconciliation would reuse the
    // first instance — leaking userToggled / expand state across runs.
    const t1 = { type: 'assistant-turn', id: 't1', messages: [{ featureId: 'feat-A' }] };
    const u  = { type: 'user', id: 'u', message: { content: 'next?' } };
    const t2 = { type: 'assistant-turn', id: 't2', messages: [{ featureId: 'feat-A' }] };
    const out = foldByFeatureId([t1, u, t2]);
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe('feature-pill');
    expect(out[2].type).toBe('feature-pill');
    expect(out[0].id).not.toBe(out[2].id);
    // Both pills are still tagged with the same featureId — only the key differs.
    expect(out[0].featureId).toBe('feat-A');
    expect(out[2].featureId).toBe('feat-A');
  });

  it('handles empty / non-array input safely', () => {
    expect(foldByFeatureId([])).toEqual([]);
    expect(foldByFeatureId(null)).toEqual([]);
    expect(foldByFeatureId(undefined)).toEqual([]);
  });

  it('folds same-featureId turns from different VPs into one pill (cross-VP)', () => {
    // PR-2 review fix (Torvalds M6): the policy is "feature-id is the
    // unit, not the speaker" — when vp-1 and vp-2 each emit feat-A in
    // adjacent turns, they fold into a SINGLE pill. This test pins that
    // policy so a future maintainer doesn't accidentally key the fold on
    // (vpId, featureId).
    const t1 = {
      type: 'assistant-turn', id: 't1',
      speakerVpId: 'vp-1', messages: [{ featureId: 'feat-A' }],
    };
    const t2 = {
      type: 'assistant-turn', id: 't2',
      speakerVpId: 'vp-2', messages: [{ featureId: 'feat-A' }],
    };
    const out = foldByFeatureId([t1, t2]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('feature-pill');
    expect(out[0].turns).toEqual([t1, t2]);
  });

  it('does not mutate input items or the input array (M5)', () => {
    // Helpers must be pure — only the OUTPUT array is fresh. This guards
    // against a future maintainer reaching for `item.foo = ...` and
    // breaking the contract silently.
    const t1 = Object.freeze({
      type: 'assistant-turn',
      id: 't1',
      messages: Object.freeze([Object.freeze({ featureId: 'feat-A' })]),
    });
    const u = Object.freeze({ type: 'user', id: 'u', message: Object.freeze({ content: 'x' }) });
    const items = Object.freeze([t1, u]);
    expect(() => foldByFeatureId(items)).not.toThrow();
    // Sanity: result is a fresh array, items inside are the same refs.
    const out = foldByFeatureId(items);
    expect(out).not.toBe(items);
    expect(out[0].turns[0]).toBe(t1);
    expect(out[1]).toBe(u);
  });
});

describe('injectQuickPreviews', () => {
  it('inserts a quick-preview marker before the matching assistant-turn', () => {
    const items = [
      { type: 'user', id: 'u', message: {} },
      { type: 'assistant-turn', id: 't1', speakerVpId: 'vp-1', turnId: 'turn-A', messages: [] },
    ];
    const previewMap = {
      'vp-1:turn-A': { vpId: 'vp-1', turnId: 'turn-A', intent: 'quick', preview: 'hi', ts: 1 },
    };
    const out = injectQuickPreviews(items, previewMap);
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe('user');
    expect(out[1].type).toBe('quick-preview');
    expect(out[1].forVpId).toBe('vp-1');
    expect(out[1].forTurnId).toBe('turn-A');
    expect(out[1].preview.preview).toBe('hi');
    expect(out[2].type).toBe('assistant-turn');
  });

  it('does NOT duplicate a preview when several turns share the same vpId:turnId', () => {
    // Defensive — turn-aggregation should always produce a single turn per
    // (vpId, turnId), but if a typing-placeholder + a real turn end up with
    // the same key, the preview should still appear at most once.
    const items = [
      { type: 'assistant-turn', id: 't1', speakerVpId: 'vp-1', turnId: 'turn-A', messages: [] },
      { type: 'assistant-turn', id: 't2', speakerVpId: 'vp-1', turnId: 'turn-A', messages: [] },
    ];
    const previewMap = {
      'vp-1:turn-A': { vpId: 'vp-1', turnId: 'turn-A', intent: 'quick', preview: 'hi', ts: 1 },
    };
    const out = injectQuickPreviews(items, previewMap);
    const previews = out.filter((x) => x.type === 'quick-preview');
    expect(previews).toHaveLength(1);
    expect(previews[0].forTurnId).toBe('turn-A');
  });

  it('skips assistant-turns that have no speakerVpId / turnId', () => {
    const items = [
      { type: 'assistant-turn', id: 't1', messages: [] },
      { type: 'assistant-turn', id: 't2', speakerVpId: 'vp-1', messages: [] },
      { type: 'assistant-turn', id: 't3', turnId: 'turn-A', messages: [] },
    ];
    // Even if the map happens to have an entry for "undefined:undefined",
    // we never look it up because we gate on both fields being truthy.
    const previewMap = { 'undefined:undefined': { preview: 'wrong' } };
    const out = injectQuickPreviews(items, previewMap);
    expect(out.filter((x) => x.type === 'quick-preview')).toHaveLength(0);
  });

  it('returns the input untouched when previewMap is empty / null', () => {
    const items = [
      { type: 'assistant-turn', id: 't1', speakerVpId: 'vp-1', turnId: 'turn-A', messages: [] },
    ];
    expect(injectQuickPreviews(items, null)).toEqual(items);
    expect(injectQuickPreviews(items, {})).toEqual(items);
  });

  it('handles empty / non-array input safely', () => {
    expect(injectQuickPreviews([], { 'a:b': {} })).toEqual([]);
    expect(injectQuickPreviews(null, { 'a:b': {} })).toEqual([]);
  });

  it('does not mutate input items or the input arrays (M5)', () => {
    const t = Object.freeze({
      type: 'assistant-turn', id: 't1',
      speakerVpId: 'vp-1', turnId: 'turn-A',
      messages: Object.freeze([]),
    });
    const items = Object.freeze([t]);
    const previewMap = Object.freeze({
      'vp-1:turn-A': Object.freeze({
        vpId: 'vp-1', turnId: 'turn-A', intent: 'quick', preview: 'hi', ts: 1,
      }),
    });
    expect(() => injectQuickPreviews(items, previewMap)).not.toThrow();
    const out = injectQuickPreviews(items, previewMap);
    expect(out).not.toBe(items);
    // The original turn ref is preserved as-is at its new index.
    expect(out[1]).toBe(t);
  });
});

describe('foldByFeatureId + injectQuickPreviews integration', () => {
  it('preserves the quick-preview marker outside the feature-pill', () => {
    // Track A fires a preview for (vp-1, turn-A); the same VP then escalates
    // into a feature run on the same turn. The preview should stay visible
    // ABOVE the pill (not folded inside it).
    const t = {
      type: 'assistant-turn',
      id: 't1',
      speakerVpId: 'vp-1',
      turnId: 'turn-A',
      messages: [{ featureId: 'feat-Z' }],
    };
    const previewMap = {
      'vp-1:turn-A': { vpId: 'vp-1', turnId: 'turn-A', intent: 'feature', preview: 'starting work…', ts: 1 },
    };
    const injected = injectQuickPreviews([t], previewMap);
    const folded = foldByFeatureId(injected);
    expect(folded).toHaveLength(2);
    expect(folded[0].type).toBe('quick-preview');
    expect(folded[1].type).toBe('feature-pill');
    expect(folded[1].featureId).toBe('feat-Z');
    expect(folded[1].turns).toEqual([t]);
  });
});
