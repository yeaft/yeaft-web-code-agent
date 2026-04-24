/**
 * unify-five-bugs.test.js — regression tests for the five Unify UX bugs
 * fixed in the `fix-unify-five-bugs` worktree. Each block targets one
 * bug and asserts the fix remains in place.
 *
 *   A) Group wizard confirm step removed (2 steps, not 3).
 *   B) Bilingual VP: displayNameZh on wire + pinyin alias matching.
 *   C) Group-create error i18n interpolates {message}.
 *   D) UserMemoryPage has scope-tree UI + CSS wired up.
 *   E) Inbox (main thread) has a clarifying tooltip.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

// ─── Bug A: 2-step wizard (no confirm) ──────────────────────────

describe('Bug A: GroupCreateWizard is 2-step', () => {
  const src = read('web/components/GroupCreateWizard.js');
  it('only lists two step tabs in the tablist', () => {
    const tabMatches = src.match(/class="group-wizard-step"/g) || [];
    expect(tabMatches.length).toBe(2);
  });
  it('has no confirm/summary block', () => {
    expect(src).not.toContain('group-wizard-summary');
    expect(src).not.toMatch(/v-else-if="step === 2"/);
  });
  it('step 2 name input submits via Enter', () => {
    expect(src).toMatch(/@keydown\.enter\.prevent="onSubmit"/);
  });
});

// ─── Bug B: bilingual VP + pinyin ──────────────────────────────

describe('Bug B: bilingual VP + pinyin mentions', () => {
  it('serializeVpForWire includes displayNameZh and aliases', () => {
    const bridge = read('agent/unify/vp/vp-bridge.js');
    expect(bridge).toContain('displayNameZh');
    expect(bridge).toContain('aliases');
  });
  it('seed defaults carry nameZh and pinyin aliases', () => {
    const seed = read('agent/unify/vp/seed-defaults.js');
    expect(seed).toContain('displayNameZh');
    // Check a couple of signature pinyin entries to prove seed was updated.
    expect(seed).toMatch(/qiaobusi|shidifu/);
    expect(seed).toMatch(/tuowazi|linasi/);
  });
  it('filterVpMentions matches on pinyin aliases (structural)', () => {
    // Importing VpMentionAutocomplete.js drags in the Pinia-backed
    // VpAvatar → vp store chain, so we assert on source instead.
    const src = read('web/components/VpMentionAutocomplete.js');
    expect(src).toContain('aliasPrefix');
    expect(src).toMatch(/for \(const alias of aliases\)/);
    expect(src).toContain('displayNameZh');
  });
  it('vpLabel reads displayNameZh for zh locale', () => {
    const store = read('web/stores/vp.js');
    expect(store).toContain('displayNameZh');
    expect(store).toMatch(/locale\.startsWith\(['"]zh['"]\)/);
  });
});

// ─── Bug C: i18n {message} interpolation ───────────────────────

describe('Bug C: group-create error i18n passes {message}', () => {
  const src = read('web/components/GroupCreateWizard.js');
  it('passes { message } to $t for the mapped error key', () => {
    expect(src).toMatch(/\$t\(msgKey,\s*\{\s*message\s*\}\)/);
  });
  it('falls back to unknown with message when key is missing', () => {
    expect(src).toMatch(/unify\.group\.error\.unknown/);
    expect(src).toMatch(/translated === msgKey/);
  });
});

// ─── Bug D: UserMemoryPage scope-tree + CSS ────────────────────

describe('Bug D: UserMemoryPage scope-tree + CSS', () => {
  it('UserMemoryPage has scope-tree template + handlers', () => {
    const src = read('web/components/UserMemoryPage.js');
    expect(src).toContain('um-scope-section');
    expect(src).toContain('toggleEntry');
    expect(src).toContain('openEntry');
    expect(src).toContain('fullBody');
    expect(src).toContain('refreshScope');
  });
  it('stylesheet exists and is imported', () => {
    expect(existsSync(path.join(repoRoot, 'web/styles/unify-user-memory.css'))).toBe(true);
    const index = read('web/styles/index.css');
    expect(index).toContain("@import './unify-user-memory.css';");
  });
  it('stylesheet defines the key um-scope classes', () => {
    const css = read('web/styles/unify-user-memory.css');
    expect(css).toContain('.um-scope-section');
    expect(css).toContain('.um-scope-folder');
    expect(css).toContain('.um-scope-entry');
    expect(css).toContain('.um-scope-entry.is-open');
  });
});

// ─── Bug E: Inbox tooltip ──────────────────────────────────────

describe('Bug E: Inbox has clarifying tooltip', () => {
  it('sidebar V2 has threadTooltip method + :title binding', () => {
    const src = read('web/components/UnifySidebarV2.js');
    expect(src).toContain('threadTooltip');
    expect(src).toMatch(/:title="threadTooltip\(t\)"/);
  });
  it('i18n has unify.inbox.tooltip in EN and ZH', () => {
    expect(read('web/i18n/en.js')).toContain('unify.inbox.tooltip');
    expect(read('web/i18n/zh-CN.js')).toContain('unify.inbox.tooltip');
  });
});
