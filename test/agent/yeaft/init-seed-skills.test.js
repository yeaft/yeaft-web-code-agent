/**
 * init-seed-skills.test.js — seedBundledSkills() Claude-Code-style installer
 *
 * Covers the manifest-sentinel contract:
 *   (a) Empty user dir → copy every bundled SKILL.md, manifest records sha
 *   (b) User-edited file is NOT overwritten on re-seed (preserved)
 *   (c) Bundled-but-unchanged file IS overwritten when the bundled version
 *       changes (upgrade flows through)
 *   (d) Manifest tracks shas correctly across runs
 *   (e) Idempotent: re-running with stable inputs produces no writes
 *   (f) Brand new bundled file appears on next seed (auto-install)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { seedBundledSkills } from '../../../agent/yeaft/init.js';

const MANIFEST = '.bundled-manifest.json';

let bundledRoot;
let userDir;
let originalEnv;

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function writeBundledSkill(name, body) {
  const dir = join(bundledRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function readManifest() {
  const p = join(userDir, MANIFEST);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8'));
}

beforeEach(() => {
  bundledRoot = mkdtempSync(join(tmpdir(), 'yeaft-seed-bundled-'));
  userDir = mkdtempSync(join(tmpdir(), 'yeaft-seed-user-'));
  originalEnv = process.env.YEAFT_SKILLS_BUNDLED_DIR;
  process.env.YEAFT_SKILLS_BUNDLED_DIR = bundledRoot;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.YEAFT_SKILLS_BUNDLED_DIR;
  else process.env.YEAFT_SKILLS_BUNDLED_DIR = originalEnv;
  if (existsSync(bundledRoot)) rmSync(bundledRoot, { recursive: true, force: true });
  if (existsSync(userDir)) rmSync(userDir, { recursive: true, force: true });
});

describe('seedBundledSkills — first-time install', () => {
  it('copies every bundled SKILL.md into an empty user dir', () => {
    writeBundledSkill('alpha', '---\nname: alpha\n---\nbody A');
    writeBundledSkill('beta', '---\nname: beta\n---\nbody B');
    writeBundledSkill('gamma', '---\nname: gamma\n---\nbody C');

    const warnings = [];
    const result = seedBundledSkills(userDir, warnings);

    expect(result.copied).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.preserved).toBe(0);
    expect(warnings).toEqual([]);

    expect(readFileSync(join(userDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('---\nname: alpha\n---\nbody A');
    expect(readFileSync(join(userDir, 'beta', 'SKILL.md'), 'utf8')).toBe('---\nname: beta\n---\nbody B');
    expect(readFileSync(join(userDir, 'gamma', 'SKILL.md'), 'utf8')).toBe('---\nname: gamma\n---\nbody C');
  });

  it('records the bundled sha for each installed file in the manifest', () => {
    writeBundledSkill('alpha', 'alpha-body');
    writeBundledSkill('beta', 'beta-body');

    seedBundledSkills(userDir);
    const manifest = readManifest();

    expect(manifest[join('alpha', 'SKILL.md')]).toBe(sha256('alpha-body'));
    expect(manifest[join('beta', 'SKILL.md')]).toBe(sha256('beta-body'));
  });

  it('returns zero counts when the bundled dir has zero files (no work to do)', () => {
    // Empty bundled dir (no skills) — env override points to a real empty dir
    // so the resolver picks it as the source of truth.
    const warnings = [];
    const result = seedBundledSkills(userDir, warnings);
    expect(result).toEqual({ copied: 0, updated: 0, preserved: 0, skipped: 0 });
    expect(warnings).toEqual([]);
  });
});

describe('seedBundledSkills — user edits win', () => {
  it('does NOT overwrite a file the user has edited', () => {
    writeBundledSkill('alpha', 'bundled-v1');
    seedBundledSkills(userDir);

    // User edits the file
    writeFileSync(join(userDir, 'alpha', 'SKILL.md'), 'user-customisation', 'utf8');

    // Re-seed without changing the bundled file
    const result = seedBundledSkills(userDir);
    expect(result.copied).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.preserved).toBe(1);
    expect(readFileSync(join(userDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('user-customisation');
  });

  it('does NOT update the manifest sha when the user has diverged', () => {
    writeBundledSkill('alpha', 'bundled-v1');
    seedBundledSkills(userDir);
    const originalSha = readManifest()[join('alpha', 'SKILL.md')];
    expect(originalSha).toBe(sha256('bundled-v1'));

    writeFileSync(join(userDir, 'alpha', 'SKILL.md'), 'user-edit', 'utf8');
    seedBundledSkills(userDir);

    // Manifest still reflects what we INSTALLED, so the divergence
    // remains visible on every subsequent run.
    expect(readManifest()[join('alpha', 'SKILL.md')]).toBe(originalSha);
  });

  it('preserves a user file even when the bundled version is upgraded', () => {
    writeBundledSkill('alpha', 'bundled-v1');
    seedBundledSkills(userDir);
    writeFileSync(join(userDir, 'alpha', 'SKILL.md'), 'user-fork', 'utf8');

    // Bundle upgrade
    writeBundledSkill('alpha', 'bundled-v2');
    const result = seedBundledSkills(userDir);
    expect(result.preserved).toBe(1);
    expect(result.updated).toBe(0);
    expect(readFileSync(join(userDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('user-fork');
  });
});

describe('seedBundledSkills — bundled upgrade flow', () => {
  it('overwrites a bundled-but-unchanged file when the bundled version changes', () => {
    writeBundledSkill('alpha', 'bundled-v1');
    seedBundledSkills(userDir);
    expect(readFileSync(join(userDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('bundled-v1');

    // Upgrade the bundle; user hasn't touched the file.
    writeBundledSkill('alpha', 'bundled-v2');
    const result = seedBundledSkills(userDir);

    expect(result.updated).toBe(1);
    expect(result.copied).toBe(0);
    expect(result.preserved).toBe(0);
    expect(readFileSync(join(userDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('bundled-v2');
    // Manifest now tracks the new sha.
    expect(readManifest()[join('alpha', 'SKILL.md')]).toBe(sha256('bundled-v2'));
  });
});

describe('seedBundledSkills — idempotency + new files', () => {
  it('is a no-op when disk and bundled already agree (second run writes nothing)', () => {
    writeBundledSkill('alpha', 'bundled-v1');
    seedBundledSkills(userDir);

    const firstMtime = statSync(join(userDir, 'alpha', 'SKILL.md')).mtimeMs;
    const result = seedBundledSkills(userDir);

    expect(result.copied).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.preserved).toBe(0);
    // No writes ⇒ mtime stable
    const secondMtime = statSync(join(userDir, 'alpha', 'SKILL.md')).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it('auto-installs a brand new bundled file on the next seed', () => {
    writeBundledSkill('alpha', 'a');
    seedBundledSkills(userDir);
    expect(existsSync(join(userDir, 'beta', 'SKILL.md'))).toBe(false);

    writeBundledSkill('beta', 'b');
    const result = seedBundledSkills(userDir);
    expect(result.copied).toBe(1);
    expect(existsSync(join(userDir, 'beta', 'SKILL.md'))).toBe(true);
    expect(readManifest()[join('beta', 'SKILL.md')]).toBe(sha256('b'));
  });

  it('keeps the bundled file untouched when a same-sha user file already exists', () => {
    writeBundledSkill('alpha', 'identical-body');
    // User pre-creates the file with the same content (no manifest entry yet).
    mkdirSync(join(userDir, 'alpha'), { recursive: true });
    writeFileSync(join(userDir, 'alpha', 'SKILL.md'), 'identical-body', 'utf8');

    const result = seedBundledSkills(userDir);
    // Same sha → no write, just refresh manifest.
    expect(result.copied).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.preserved).toBe(0);
    expect(readManifest()[join('alpha', 'SKILL.md')]).toBe(sha256('identical-body'));
  });
});
