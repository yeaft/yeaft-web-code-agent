#!/usr/bin/env node
/**
 * generate-avatars.mjs — regenerate illustrated avatar SVGs for VPs.
 *
 * Why this exists as a one-shot script rather than a runtime fetch:
 *   • The web client explicitly bans CDN dependencies — `web/index.html`
 *     comments mark every vendor as "Local vendor dependencies (no CDN)".
 *     Pulling https://api.dicebear.com/... at runtime would violate that.
 *   • Adding `@dicebear/core` to the runtime bundle costs ~200 KB of JS the
 *     production page does not need; the script keeps it as a devDep only.
 *   • SVGs are deterministic per seed — pre-generation is faster and
 *     offline-safe.
 *
 * Run with:  npm run avatars
 *
 * Output: one SVG per entry below in web/assets/avatars/. Each file is
 * 3–6 KB, transparent background, 256×256 viewBox; rendered on top of the
 * existing 12-color palette ring so per-VP color identity is preserved.
 *
 * Style choice: DiceBear `personas` — illustrated head-and-shoulders, the
 * most "Crew / IM thread" looking style in the collection. Seed = vpId
 * keeps output stable across runs.
 *
 * Licensing: DiceBear core is MIT, the `personas` style is licensed CC-BY 4.0
 * by the upstream author Draftbit. Attribution lives in
 * web/assets/avatars/README.md.
 */

import { createAvatar } from '@dicebear/core';
import { personas } from '@dicebear/collection';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'web', 'assets', 'avatars');
mkdirSync(outDir, { recursive: true });

// VP seeds match the roster shipped under ~/.yeaft/virtual-persons/.
// `vpId` is the lookup key the web client uses; the file name MUST match.
// `seed` is the DiceBear input — kept identical to vpId for stable output.
//
// The illustrated-avatar roster is intentionally a subset of DEFAULT_VPS.
// VPs not listed here fall back to the letter render, which avoids 404s.
// These three places must stay in lockstep (test/web/vp-avatar-image.test.js
// guards two of them):
//   1. this ENTRIES array (generated SVG files)
//   2. web/components/VpAvatar.js#KNOWN_AVATAR_IDS (frontend gate)
//   3. test/web/vp-avatar-image.test.js#KNOWN (test gate)
const ENTRIES = [
  // Original 12 (engineering / design / science / security / business).
  { id: 'ada' },
  { id: 'alan' },
  { id: 'alice' },
  { id: 'dieter' },
  { id: 'grace' },
  { id: 'ken' },
  { id: 'linus' },
  { id: 'margaret' },
  { id: 'martin' },
  { id: 'norman' },
  { id: 'shannon' },
  { id: 'steve' },
  // Expansion 20 (philosophy / psychology / strategy / history /
  // investing / business / writing / science / arts).
  { id: 'kongzi' },
  { id: 'socrates' },
  { id: 'nietzsche' },
  { id: 'kahneman' },
  { id: 'jung' },
  { id: 'sunzi' },
  { id: 'clausewitz' },
  { id: 'simaqian' },
  { id: 'harari' },
  { id: 'buffett' },
  { id: 'munger' },
  { id: 'dalio' },
  { id: 'bezos' },
  { id: 'drucker' },
  { id: 'luxun' },
  { id: 'sudongpo' },
  { id: 'borges' },
  { id: 'einstein' },
  { id: 'kubrick' },
  { id: 'miyazaki' },
];

let count = 0;
for (const { id, seed } of ENTRIES) {
  const svg = createAvatar(personas, {
    seed: seed || id,
    size: 256,
    backgroundType: ['transparent'],
    radius: 50,
  }).toString();
  const outPath = join(outDir, `${id}.svg`);
  writeFileSync(outPath, svg, 'utf8');
  count += 1;
  console.log(`  ✓ ${id}.svg`);
}

console.log(`\nWrote ${count} avatars to ${outDir}`);
