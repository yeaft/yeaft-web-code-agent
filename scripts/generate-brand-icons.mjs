#!/usr/bin/env node
/**
 * generate-brand-icons.mjs — regenerate the Yeaft app icon set.
 *
 * The mark: an ink "Y" (main line: stem + left arm) whose right arm has
 * split off as an amber comet — one line of work spawning a new branch. The
 * plate is the same deep night as the Cosmos unified world.
 *
 * All variants are drawn from the geometry below on a 1024 grid so the
 * favicon, installed-app icons and maskable / Apple icons stay in sync:
 *
 *   icon.svg / icon-{192,512}.png       purpose "any": squircle plate with a
 *                                        small transparent margin (Windows,
 *                                        Linux and macOS desktop shortcuts).
 *   favicon.svg / favicon-32.png        full-bleed plate, no soft effects;
 *                                        tuned for 16–32 px browser tabs.
 *   icon-maskable-{192,512}.png         square full-bleed plate, mark inside
 *                                        the 80% safe circle (Android / ChromeOS).
 *   apple-touch-icon.png (180)          square full-bleed plate; iOS applies
 *                                        its own mask.
 *
 * Run with:  npm run brand-icons
 * Output:    web/assets/brand/ (SVG sources + PNG renders via Playwright's
 *            Chromium, which is already a devDependency for E2E) and
 *            docs/public/logo.svg. test/web/brand-icons.test.js fails when the
 *            committed SVGs drift from this file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'web', 'assets', 'brand');
const docsLogo = join(__dirname, '..', 'docs', 'public', 'logo.svg');

// ── Palette ────────────────────────────────────────────────────────────────
const NIGHT_TOP = '#232B44';
const NIGHT_BOTTOM = '#090C15';
const INK_TOP = '#FFFDF9';
const INK_BOTTOM = '#E8E1D6';
const AMBER_HEAD = '#FFD487';
const AMBER_MID = '#FF9440';
const AMBER_TAIL = '#F2551F';
const AMBER_GLOW = '#FF7A30';

// ── Geometry (1024 grid, designed against a 880-wide plate) ────────────────
const C = 512;
const DESIGN_PLATE_HALF = 440;
const J = [512, 512];   // junction
const TL = [330, 272];  // left arm tip
const TR = [694, 272];  // comet head
const B = [512, 776];   // stem foot
const STROKE = 116;
const HEAD_R = 70;
const TAIL_R = 12;
const GAP = 40;

const r1 = (n) => Math.round(n * 10) / 10;
const unit = (from, to) => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  return [dx / len, dy / len];
};
const TAIL = (() => {
  const u = unit(J, TR);
  const d = STROKE / 2 + GAP + TAIL_R;
  return [J[0] + u[0] * d, J[1] + u[1] * d];
})();

/** Superellipse plate (n = 5), close to the continuous-corner app icon shape. */
function squirclePath(half, n = 5, steps = 144) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(`${Math.round(C + half * Math.sign(c) * Math.abs(c) ** (2 / n))} ${Math.round(C + half * Math.sign(s) * Math.abs(s) ** (2 / n))}`);
  }
  return `M${pts.join('L')}Z`;
}

/** Convex hull of the comet head circle and the small tail circle. */
function cometPath() {
  const dx = TAIL[0] - TR[0];
  const dy = TAIL[1] - TR[1];
  const base = Math.atan2(dy, dx);
  const phi = Math.acos((HEAD_R - TAIL_R) / Math.hypot(dx, dy));
  const at = (c, r, a) => `${r1(c[0] + r * Math.cos(a))} ${r1(c[1] + r * Math.sin(a))}`;
  return `M${at(TR, HEAD_R, base + phi)}L${at(TAIL, TAIL_R, base + phi)}`
    + `A${TAIL_R} ${TAIL_R} 0 0 0 ${at(TAIL, TAIL_R, base - phi)}`
    + `L${at(TR, HEAD_R, base - phi)}A${HEAD_R} ${HEAD_R} 0 1 0 ${at(TR, HEAD_R, base + phi)}Z`;
}

const MAIN_PATH = `M${B[0]} ${B[1]}L${J[0]} ${J[1]}L${TL[0]} ${TL[1]}`;
const COMET_PATH = cometPath();

/**
 * @param {object} opts
 * @param {'squircle'|'square'} opts.plate  plate shape
 * @param {number} opts.plateHalf           half size of the squircle plate
 * @param {number} opts.markScale           mark scale relative to the design plate
 * @param {boolean} opts.detail             soft shadow, glow and rim light
 */
function iconSvg({ plate, plateHalf = C, markScale, detail }) {
  const platePath = plate === 'square' ? 'M0 0H1024V1024H0Z' : squirclePath(plateHalf);
  const s = r1(markScale * 1000) / 1000;
  const mark = `translate(${r1(C - C * s)} ${r1(C - C * s)}) scale(${s})`;
  const glowAt = [r1(C + (TR[0] - C) * s), r1(C + (TR[1] - C) * s)];
  const clip = plate === 'square' ? '' : ' clip-path="url(#y-clip)"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="y-plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${NIGHT_TOP}"/><stop offset="1" stop-color="${NIGHT_BOTTOM}"/></linearGradient>
<linearGradient id="y-ink" x1="0" y1="${TL[1]}" x2="0" y2="${B[1]}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${INK_TOP}"/><stop offset="1" stop-color="${INK_BOTTOM}"/></linearGradient>
<linearGradient id="y-amber" x1="${TR[0] + 40}" y1="${TR[1] - 50}" x2="${r1(TAIL[0])}" y2="${r1(TAIL[1])}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${AMBER_HEAD}"/><stop offset=".55" stop-color="${AMBER_MID}"/><stop offset="1" stop-color="${AMBER_TAIL}"/></linearGradient>
<radialGradient id="y-wash" cx="${glowAt[0]}" cy="${glowAt[1]}" r="${r1(400 * s)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${AMBER_GLOW}" stop-opacity=".2"/><stop offset="1" stop-color="${AMBER_GLOW}" stop-opacity="0"/></radialGradient>${detail ? `
<linearGradient id="y-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="y-shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="16"/></filter>
<filter id="y-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="34"/></filter>` : ''}${clip ? `
<clipPath id="y-clip"><path d="${platePath}"/></clipPath>` : ''}
</defs>
<path d="${platePath}" fill="url(#y-plate)"/>
<g${clip}>
<rect width="1024" height="1024" fill="url(#y-wash)"/>${detail ? `
<g transform="${mark}">
<path d="${MAIN_PATH}" transform="translate(0 16)" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" filter="url(#y-shadow)"/>
<path d="${COMET_PATH}" fill="${AMBER_GLOW}" opacity=".7" filter="url(#y-glow)"/>
</g>` : ''}
</g>${detail && plate !== 'square' ? `
<path d="${platePath}" fill="none" stroke="url(#y-rim)" stroke-width="6"/>` : ''}
<g transform="${mark}">
<path d="${MAIN_PATH}" fill="none" stroke="url(#y-ink)" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
<path d="${COMET_PATH}" fill="url(#y-amber)"/>
</g>
</svg>
`;
}

const ANY_PLATE_HALF = 460;
const variants = {
  icon: iconSvg({ plate: 'squircle', plateHalf: ANY_PLATE_HALF, markScale: ANY_PLATE_HALF / DESIGN_PLATE_HALF, detail: true }),
  favicon: iconSvg({ plate: 'squircle', plateHalf: C, markScale: 1.12, detail: false }),
  maskable: iconSvg({ plate: 'square', markScale: 0.9, detail: true }),
  apple: iconSvg({ plate: 'square', markScale: 1, detail: true }),
};

const renders = [
  { variant: 'icon', file: 'icon-192.png', size: 192 },
  { variant: 'icon', file: 'icon-512.png', size: 512 },
  { variant: 'favicon', file: 'favicon-32.png', size: 32 },
  { variant: 'maskable', file: 'icon-maskable-192.png', size: 192 },
  { variant: 'maskable', file: 'icon-maskable-512.png', size: 512 },
  { variant: 'apple', file: 'apple-touch-icon.png', size: 180 },
];

/** SVG files written verbatim; the docs site reuses the favicon artwork. */
const svgOutputs = [
  { variant: 'icon', path: join(outDir, 'icon.svg') },
  { variant: 'favicon', path: join(outDir, 'favicon.svg') },
  { variant: 'favicon', path: docsLogo },
];

export { variants, renders, svgOutputs };

async function main() {
  mkdirSync(outDir, { recursive: true });
  for (const { variant, path } of svgOutputs) writeFileSync(path, variants[variant]);

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const { variant, file, size } of renders) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(variants[variant]).toString('base64')}">`);
      await page.waitForFunction(() => document.images[0]?.complete);
      const opaque = variant === 'maskable' || variant === 'apple';
      await page.screenshot({ path: join(outDir, file), omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
      console.log(`  ${file} (${size}x${size})`);
    }
  } finally {
    await browser.close();
  }
  console.log(`Wrote brand icons to ${outDir} and ${docsLogo}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  await main();
}
