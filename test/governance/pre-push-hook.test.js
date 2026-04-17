/**
 * task-304 — governance: dev-tag-guard pre-push hook.
 *
 * Validates the opt-in `.githooks/pre-push` hook that blocks version-tag
 * pushes from non-main branches. Historical precedent: 2026-04-17 dev
 * regression. These tests check file-level invariants (existence,
 * executability, bash syntax) and documentation (opt-in instructions).
 *
 * The hook's runtime behaviour is intentionally not exercised here —
 * running `git push` in a vitest would require a full sandbox repo and
 * coupling the unit suite to network-like operations. Behaviour is
 * verified manually and via the identical legacy `hooks/pre-push`
 * script that ships alongside.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const hookPath = join(root, '.githooks/pre-push');
const readmePath = join(root, '.githooks/README.md');
const contribPath = join(root, 'CONTRIBUTING.md');

describe('governance — .githooks/pre-push', () => {
  it('the pre-push hook file exists', () => {
    expect(existsSync(hookPath)).toBe(true);
  });

  it('the pre-push hook is marked executable', () => {
    const mode = statSync(hookPath).mode;
    // owner-execute bit (0o100) — minimum required for git to invoke it
    expect(mode & 0o100).toBe(0o100);
  });

  it('the pre-push hook passes `bash -n` syntax check', () => {
    // Throws non-zero exit on syntax errors; stdio inherited into the
    // error object so vitest surfaces the bash message verbatim.
    expect(() => {
      execSync(`bash -n "${hookPath}"`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('starts with a bash shebang', () => {
    const src = readFileSync(hookPath, 'utf8');
    expect(src.startsWith('#!/bin/bash') || src.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('blocks version tags (v*) on non-main branches', () => {
    const src = readFileSync(hookPath, 'utf8');
    expect(src).toMatch(/refs\/tags\/v\*/);
    expect(src).toMatch(/CURRENT_BRANCH.*!=.*main|"\$CURRENT_BRANCH"\s*!=\s*"main"/);
    expect(src).toMatch(/exit 1/);
  });

  it('also blocks release-* tags', () => {
    const src = readFileSync(hookPath, 'utf8');
    expect(src).toContain('release-');
  });

  it('verifies tagged commit is reachable from main', () => {
    const src = readFileSync(hookPath, 'utf8');
    expect(src).toMatch(/merge-base\s+--is-ancestor/);
  });
});

describe('governance — .githooks/README.md', () => {
  it('README exists', () => {
    expect(existsSync(readmePath)).toBe(true);
  });

  it('documents the opt-in activation via core.hooksPath', () => {
    const md = readFileSync(readmePath, 'utf8');
    expect(md).toContain('core.hooksPath');
    expect(md).toContain('.githooks');
  });

  it('documents how to disable the hook', () => {
    const md = readFileSync(readmePath, 'utf8');
    expect(md).toMatch(/--unset\s+core\.hooksPath/);
  });

  it('mentions the pre-push hook purpose (tag guard)', () => {
    const md = readFileSync(readmePath, 'utf8');
    expect(md).toMatch(/pre-push/);
    expect(md).toMatch(/tag/i);
  });
});

describe('governance — CONTRIBUTING.md tagging rules', () => {
  it('has a dedicated tagging / release governance section', () => {
    const md = readFileSync(contribPath, 'utf8');
    expect(md).toMatch(/Tagging.*Release|🚨/);
  });

  it('references the 2026-04-17 violation as precedent (without naming the dev)', () => {
    const md = readFileSync(contribPath, 'utf8');
    expect(md).toContain('2026-04-17');
    // Must NOT leak specific dev identity
    expect(md).not.toMatch(/\bdev-1\b/);
    expect(md).not.toMatch(/\bdev-2\b/);
    expect(md).not.toMatch(/\bdev-3\b/);
    expect(md).not.toMatch(/\bdev-4\b/);
  });

  it('spells out the correct merge-then-tag-on-main flow', () => {
    const md = readFileSync(contribPath, 'utf8');
    expect(md).toMatch(/git push origin HEAD:main/);
    expect(md).toMatch(/git checkout main/);
    expect(md).toMatch(/git tag v0\.1\.X/);
  });

  it('includes a pre-commit checklist for AI dev roles', () => {
    const md = readFileSync(contribPath, 'utf8');
    expect(md).toMatch(/Checklist|checklist/);
    expect(md).toMatch(/dev-\*|AI dev/);
  });
});
