/**
 * vp-bridge-serialize-stock.test.js — pin the `isStock` field on the wire
 * shape produced by `serializeVpForWire`. The frontend uses this to gate
 * Edit/Delete buttons and render a "Stock" badge.
 *
 * Contract:
 *   - vpId in STOCK_VP_IDS (e.g. 'steve') → isStock: true
 *   - any other vpId (user-authored)      → isStock: false
 *   - existing fields (vpId, displayName, role, traits, modelHint,
 *     personaHash, displayNameZh, aliases, subtitle) are unaffected.
 */

import { describe, it, expect } from 'vitest';
import { serializeVpForWire } from '../../../agent/unify/vp/vp-bridge.js';
import { STOCK_VP_IDS } from '../../../agent/unify/vp/seed-defaults.js';

describe('serializeVpForWire — isStock', () => {
  it('marks a stock VP id as isStock:true', () => {
    // 'steve' is in DEFAULT_VPS → in STOCK_VP_IDS.
    expect(STOCK_VP_IDS.has('steve')).toBe(true);

    const wire = serializeVpForWire({
      id: 'steve',
      name: 'Steve',
      role: 'Visionary',
      traits: ['relentless'],
      modelHint: 'primary',
      personaHash: 'abc123',
    });
    expect(wire.isStock).toBe(true);
    // Existing fields preserved.
    expect(wire.vpId).toBe('steve');
    expect(wire.displayName).toBe('Steve');
    expect(wire.role).toBe('Visionary');
    expect(wire.subtitle).toBe('Visionary');
    expect(wire.traits).toEqual(['relentless']);
    expect(wire.modelHint).toBe('primary');
    expect(wire.personaHash).toBe('abc123');
  });

  it('marks a user-authored VP id as isStock:false', () => {
    const customId = 'my_custom_vp';
    expect(STOCK_VP_IDS.has(customId)).toBe(false);

    const wire = serializeVpForWire({
      id: customId,
      name: 'My Custom',
      role: 'helper',
      traits: [],
    });
    expect(wire.isStock).toBe(false);
    expect(wire.vpId).toBe(customId);
    expect(wire.displayName).toBe('My Custom');
  });

  it('isStock is a pure function of vp.id — does not consult other fields', () => {
    // A user-authored VP that LOOKS like a stock one (same display name)
    // but has a different id stays non-stock.
    const wire = serializeVpForWire({
      id: 'fake_steve',
      name: 'Steve',
      role: 'Visionary',
    });
    expect(wire.isStock).toBe(false);
  });
});
