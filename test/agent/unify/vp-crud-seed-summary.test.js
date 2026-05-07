/**
 * vp-crud-seed-summary.test.js — Pin the contract that creating a VP via
 * `createVp` ALSO writes a Layer-A `summary.md` under
 * `<root>/memory/vp/<id>/summary.md` so the FIRST session has a non-empty
 * memory section for that VP. Without the seed, fresh VPs render an empty
 * memory section every turn until Dream-v2 has run (which itself takes
 * several turns of segment accumulation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createVp, buildVpSeedSummary } from '../../../agent/unify/vp/vp-crud.js';
import { VP_STUB_MARKER, isVpSeedBackfillStub } from '../../../agent/unify/memory/seed-backfill.js';

let tmpRoot;
let libDir;
let realHome;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vp-seed-'));
  libDir = join(tmpRoot, 'vps');
  // Redirect HOME so SEED_MEMORY_ROOT (computed from homedir()) lands in
  // our temp dir. The vp-crud module captures `homedir()` at import time
  // via `join(homedir(), '.yeaft', 'memory')`, so we have to set HOME
  // BEFORE importing — but the module is already imported. Workaround:
  // also write a dummy `~/.yeaft/memory/` if it doesn't exist (harmless),
  // and ALWAYS clean up only the IDs we created so the test is hermetic
  // even when running against the real $HOME.
  realHome = homedir();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Best-effort cleanup of any seeded files we wrote into the real home.
  // (Tests use unique VP ids so this doesn't clobber real data.)
});

describe('createVp seeds summary.md', () => {
  it('writes a non-empty summary.md for a newly created VP', () => {
    const vpId = `tst_seed_${Date.now()}`;
    createVp({ vpId, displayName: 'Tester', role: 'qa', persona: 'Diligent QA engineer.' }, { libDir });

    const summaryPath = join(realHome, '.yeaft', 'memory', 'vp', vpId, 'summary.md');
    try {
      expect(existsSync(summaryPath)).toBe(true);
      const body = readFileSync(summaryPath, 'utf-8');
      expect(body).toContain('Tester');
      expect(body).toContain('qa');
      // Persona body MUST NOT be embedded — it is rendered as Section 1
      // of the system prompt by `renderVpPersona`. Duplicating it into
      // Layer-A `vp/<id>` resident produced the visible "persona defined
      // twice" bug (PR #722 fixed the boot-time backfill twin).
      expect(body).not.toContain('Diligent QA engineer');
      expect(body).not.toContain('**Persona:**');
      // Stamp lets `engine.buildResidentEntries` skip the own-VP push.
      expect(body).toContain(VP_STUB_MARKER);
      expect(isVpSeedBackfillStub(body)).toBe(true);
    } finally {
      // Clean up the side-effect file
      if (existsSync(summaryPath)) {
        rmSync(join(realHome, '.yeaft', 'memory', 'vp', vpId), { recursive: true, force: true });
      }
    }
  });

  it('does NOT overwrite an existing summary.md', () => {
    const vpId = `tst_keep_${Date.now()}`;
    const summaryDir = join(realHome, '.yeaft', 'memory', 'vp', vpId);
    const summaryPath = join(summaryDir, 'summary.md');

    try {
      mkdirSync(summaryDir, { recursive: true });
      writeFileSync(summaryPath, 'KEEP ME\n', 'utf-8');

      createVp({ vpId, displayName: 'Bob', persona: 'Persona body.' }, { libDir });

      const body = readFileSync(summaryPath, 'utf-8');
      expect(body.trim()).toBe('KEEP ME');
    } finally {
      if (existsSync(summaryDir)) rmSync(summaryDir, { recursive: true, force: true });
    }
  });
});

describe('buildVpSeedSummary', () => {
  it('renders displayName, role, traits — but NOT persona body', () => {
    const out = buildVpSeedSummary({
      vpId: 'a',
      displayName: 'Alice',
      role: 'lead',
      traits: ['careful', 'concise'],
      persona: 'Alice is the lead.',
    });
    expect(out).toContain('# Alice');
    expect(out).toContain('lead');
    expect(out).toContain('careful, concise');
    expect(out).not.toContain('Alice is the lead');
    expect(out).not.toContain('**Persona:**');
    expect(out).toContain(VP_STUB_MARKER);
  });

  it('falls back to vpId when displayName is missing', () => {
    const out = buildVpSeedSummary({ vpId: 'foo' });
    expect(out).toContain('# foo');
    expect(out).toContain(VP_STUB_MARKER);
  });

  it('produces a stub regardless of persona length (persona is dropped, not truncated)', () => {
    const big = 'x'.repeat(2000);
    const out = buildVpSeedSummary({ vpId: 'big', displayName: 'Big', persona: big });
    expect(out).not.toContain('xxxx');
    expect(out).not.toMatch(/…/);
    expect(out).toContain(VP_STUB_MARKER);
    // Stub stays small — well under any persona truncation budget.
    expect(out.length).toBeLessThan(300);
  });
});
