/**
 * VpAvatar / UserAvatar — illustrated portrait branch contract.
 *
 * The Unify group view ships pre-generated DiceBear `personas` SVGs
 * under web/assets/avatars/. Both avatar components render an <img>
 * pointing at that asset, falling back to the original letter+colour
 * disc when the SVG either does not exist (unknown vpId) or fails to
 * load at runtime.
 *
 * This test is a source-string contract — identical pattern to
 * test/web/vp-avatar-typing.test.js. No Vue mount, no DOM, no Pinia;
 * we just assert the template + setup shape that matters.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// Illustrated-avatar IDs the generator ships SVGs for. DEFAULT_VPS may include
// additional VPs; those MUST fall back to the letter render to avoid 404 spam.
const KNOWN = [
  // Original 12 (engineering / design / science / security / business).
  'ada', 'alan', 'alice', 'dieter', 'grace', 'ken',
  'linus', 'margaret', 'martin', 'norman', 'shannon', 'steve',
  // Expansion 20 (philosophy / psychology / strategy / history /
  // investing / business / writing / science / arts).
  'kongzi', 'socrates', 'nietzsche', 'kahneman', 'jung',
  'sunzi', 'clausewitz', 'simaqian', 'harari',
  'buffett', 'munger', 'dalio', 'bezos', 'drucker',
  'luxun', 'sudongpo', 'borges', 'einstein',
  'kubrick', 'miyazaki',
];

describe('VpAvatar — illustrated portrait branch', () => {
  const src = read('web/components/VpAvatar.js');

  it('declares a KNOWN_AVATAR_IDS set covering all shipped VP avatars', () => {
    for (const id of KNOWN) {
      expect(src).toContain(`'${id}'`);
    }
    expect(src).toContain('KNOWN_AVATAR_IDS');
  });

  it('renders an <img> with src bound to avatarUrl', () => {
    expect(src).toMatch(/<img[^>]*v-if="avatarUrl"/);
    expect(src).toMatch(/:src="avatarUrl"/);
  });

  it('falls back to the .vp-avatar-letter span via v-else', () => {
    expect(src).toMatch(/v-else\s+class="vp-avatar-letter"/);
  });

  it('wires @error to onImgError so 404 falls back to the letter', () => {
    expect(src).toContain('@error="onImgError"');
    expect(src).toMatch(/imgFailed\.value\s*=\s*true/);
  });

  it('resets imgFailed on vpId change via Vue.watch (component-reuse safety)', () => {
    // If this watch is deleted, a "this VP\'s SVG broke once" decision
    // leaks into the next VP that lands in this component slot when
    // Vue reuses the DOM node. The test guards against that regression.
    expect(src).toMatch(/Vue\.watch\(\s*\(\)\s*=>\s*props\.vpId/);
    expect(src).toMatch(/imgFailed\.value\s*=\s*false/);
  });

  it('avatarUrl points at the absolute /assets/avatars path', () => {
    expect(src).toContain('/assets/avatars/');
  });

  it('does not request an illustrated avatar for Omni until omni.svg ships', () => {
    expect(src).not.toMatch(/KNOWN_AVATAR_IDS[\s\S]*'omni'/);
  });
});

describe('UserAvatar — illustrated portrait branch', () => {
  const src = read('web/components/UserAvatar.js');

  it('renders an <img> for the user.svg', () => {
    expect(src).toMatch(/<img[^>]*v-if="!imgFailed"/);
    expect(src).toContain('/assets/avatars/user.svg');
  });

  it('falls back to .user-avatar-letter on load error', () => {
    expect(src).toContain('@error="onImgError"');
    expect(src).toMatch(/v-else\s+class="user-avatar-letter"/);
  });
});

describe('web/assets/avatars — pre-generated SVGs present', () => {
  for (const id of [...KNOWN, 'user']) {
    it(`ships ${id}.svg`, () => {
      const p = join(repoRoot, 'web', 'assets', 'avatars', `${id}.svg`);
      expect(existsSync(p)).toBe(true);
      const body = readFileSync(p, 'utf8');
      // Sanity: real SVG, no inline <script>, no external href that
      // would defeat the no-CDN policy.
      expect(body.startsWith('<svg')).toBe(true);
      expect(body).not.toMatch(/<script/i);
      expect(body).not.toMatch(/https?:\/\/(?!purl\.org|creativecommons\.org|www\.w3\.org|personas\.draftbit\.com)/i);
    });
  }
});
