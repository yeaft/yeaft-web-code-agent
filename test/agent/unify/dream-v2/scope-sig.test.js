/**
 * Phase 6 — scope signature (DESIGN.md §9.14).
 *
 * Pin: stable on cold start, changes when files change, missing files
 * contribute "0:0" deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeScopeSig } from '../../../../agent/unify/dream-v2/scope-sig.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scope-sig-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('computeScopeSig', () => {
  it('stable empty signature on cold start', async () => {
    const sig = await computeScopeSig({ root, scopeDir: 'groups/new' });
    expect(sig).toBe('0:0|0:0|0:0');
  });

  it('changes when summary.md is written', async () => {
    mkdirSync(join(root, 'groups/eng'), { recursive: true });
    writeFileSync(join(root, 'groups/eng/summary.md'), 'one');
    const a = await computeScopeSig({ root, scopeDir: 'groups/eng' });
    // Bigger content → different size component, even if mtime resolution coarsens.
    writeFileSync(join(root, 'groups/eng/summary.md'), 'one-but-longer-now');
    const b = await computeScopeSig({ root, scopeDir: 'groups/eng' });
    expect(a).not.toBe(b);
  });

  it('changes when index.md is written', async () => {
    mkdirSync(join(root, 'groups/eng'), { recursive: true });
    const before = await computeScopeSig({ root, scopeDir: 'groups/eng' });
    writeFileSync(join(root, 'groups/eng/index.md'), '# index');
    const after = await computeScopeSig({ root, scopeDir: 'groups/eng' });
    expect(after).not.toBe(before);
  });
});
