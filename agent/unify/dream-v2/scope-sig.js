/**
 * dream-v2/scope-sig.js — DESIGN.md §9.14.
 *
 * Default signature for a scope dir: combine the mtimes of `entries/`,
 * `index.md`, `summary.md` into a stable opaque string. Cheap and
 * dependency-free — we explicitly stay out of "compute SHA over all
 * entry bodies" territory because the dream tick is meant to be
 * fingertip-cheap when nothing changed.
 *
 * Missing files contribute `0` to the signature, so cold-start scopes
 * have a stable "empty" signature until the first entry lands.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * @param {{ root: string, scopeDir: string }} args
 * @returns {Promise<string>}
 */
export async function computeScopeSig({ root, scopeDir }) {
  if (!root || !scopeDir) throw new Error('computeScopeSig: root + scopeDir required');
  const targets = [
    join(root, scopeDir, 'entries'),
    join(root, scopeDir, 'index.md'),
    join(root, scopeDir, 'summary.md'),
  ];
  const stamps = [];
  for (const p of targets) {
    try {
      const s = await fs.stat(p);
      stamps.push(`${s.mtimeMs.toFixed(0)}:${s.size}`);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        stamps.push('0:0');
      } else {
        throw err;
      }
    }
  }
  return stamps.join('|');
}
