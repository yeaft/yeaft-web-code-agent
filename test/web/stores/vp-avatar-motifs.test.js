/**
 * VP fallback avatar motifs.
 *
 * Default VP avatars must be stable across refreshes and distinct without
 * relying on colour alone. The store owns the mapping so components do not
 * duplicate hashing logic.
 */
import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const {
  VP_AVATAR_MOTIFS,
  VP_AVATAR_MOTIF_BY_ID,
  VP_PALETTE,
  fallbackAvatarMotif,
  fallbackColor,
  stableVpHash,
  useVpStore,
} = await import('../../../web/stores/vp.js');

describe('VP avatar fallback motifs', () => {
  it('defines exactly 12 zodiac-inspired motifs', () => {
    expect(VP_AVATAR_MOTIFS).toHaveLength(12);
    expect(VP_AVATAR_MOTIFS.map((motif) => motif.key)).toEqual([
      'rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake',
      'horse', 'goat', 'monkey', 'rooster', 'dog', 'pig',
    ]);
  });

  it('maps the same VP id to the same motif and background', () => {
    const first = fallbackAvatarMotif('linus');
    const second = fallbackAvatarMotif('linus');

    expect(first).toEqual(second);
    expect(fallbackColor('linus')).toBe(first.background);
  });

  it('pins common group VPs to separated high-contrast hues', () => {
    expect(VP_AVATAR_MOTIF_BY_ID.steve.key).toBe('monkey');
    expect(VP_AVATAR_MOTIF_BY_ID.ada.key).toBe('rabbit');
    expect(VP_AVATAR_MOTIF_BY_ID.linus.key).toBe('rat');
    expect(VP_AVATAR_MOTIF_BY_ID.martin.key).toBe('dragon');

    expect(new Set([
      fallbackAvatarMotif('steve').key,
      fallbackAvatarMotif('ada').key,
      fallbackAvatarMotif('linus').key,
      fallbackAvatarMotif('martin').key,
    ])).toHaveLength(4);
  });

  it('cycles unknown ids through the 12 motifs using a stable hash', () => {
    const id = 'custom-vp-over-12';
    const expected = VP_AVATAR_MOTIFS[stableVpHash(id) % VP_AVATAR_MOTIFS.length];

    expect(fallbackAvatarMotif(id)).toBe(expected);
  });

  it('keeps non-colour identifiers for accessibility and recognition', () => {
    for (const motif of VP_AVATAR_MOTIFS) {
      expect(motif.key).toMatch(/^[a-z]+$/);
      expect(motif.label.length).toBeGreaterThan(0);
      expect(motif.glyph).toMatch(/^[A-Z]$/);
      expect(motif.foreground).toBe(`var(--vp-avatar-${motif.key}-fg)`);
      expect(motif.background).toBe(`var(--vp-avatar-${motif.key}-bg)`);
    }
  });

  it('keeps the legacy palette export aligned with motif backgrounds', () => {
    expect(VP_PALETTE).toEqual(VP_AVATAR_MOTIFS.map((motif) => motif.background));
  });

  it('exposes the motif picker from the VP store getters', () => {
    const schema = useVpStore();
    const motif = schema.getters.vpAvatarMotif()('ada');

    expect(motif).toBe(fallbackAvatarMotif('ada'));
  });
});
