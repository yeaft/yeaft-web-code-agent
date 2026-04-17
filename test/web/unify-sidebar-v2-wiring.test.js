import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-301 Part 1 — feature-flag wiring + i18n polish.
 *
 * Part 2 (store-driven threads/tasks) lands after task-299 dev-3 commit;
 * those assertions are added then. Current coverage:
 *   1. Store exposes feature-flag state + setter
 *   2. UnifyPage renders UnifySidebarV2 only when flag is on
 *   3. Legacy sidebar renders only when flag is off (mutual exclusion)
 *   4. onSelectThreadV2 / onSelectTaskV2 delegate to store setters
 *   5. "main" thread shows localized Inbox label (en + zh)
 *   6. Search placeholder reads from i18n key
 *   7. i18n keys present in both en and zh
 */

const rootDir = join(import.meta.dirname, '..', '..');
const storeSrc = readFileSync(join(rootDir, 'web/stores/chat.js'), 'utf8');
const pageSrc = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');
const enSrc = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
const zhSrc = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');

// --- 1. Store flag ----------------------------------------------------------
describe('store feature flag', () => {
  it('declares unifySidebarV2Enabled in state with localStorage hydration', () => {
    expect(storeSrc).toMatch(/unifySidebarV2Enabled/);
    expect(storeSrc).toMatch(/unify-sidebar-v2-enabled/);
  });

  it('exposes setUnifySidebarV2Enabled action that writes localStorage', () => {
    expect(storeSrc).toMatch(/setUnifySidebarV2Enabled\s*\(/);
    expect(storeSrc).toMatch(/setItem\(['"]unify-sidebar-v2-enabled['"]/);
  });

  it('honors ?sidebarV2=1 URL query', () => {
    expect(storeSrc).toMatch(/sidebarV2/);
    expect(storeSrc).toMatch(/URLSearchParams/);
  });
});

// --- 2. UnifyPage mutual-exclusion wiring -----------------------------------
describe('UnifyPage wiring', () => {
  it('imports UnifySidebarV2 and registers it as a component', () => {
    expect(pageSrc).toMatch(/import UnifySidebarV2 from/);
    expect(pageSrc).toMatch(/components:\s*\{[^}]*UnifySidebarV2[^}]*\}/);
  });

  it('renders UnifySidebarV2 only when flag is on (v-if), legacy only when off (v-else)', () => {
    // v-if on V2
    expect(pageSrc).toMatch(/<UnifySidebarV2[\s\S]*?v-if="sidebarV2Enabled"/);
    // v-else on legacy aside (attribute order is class then v-else)
    expect(pageSrc).toMatch(/<aside\s+class="unify-sidebar"\s+v-else/);
  });

  it('exposes sidebarV2Enabled + select handlers from setup()', () => {
    expect(pageSrc).toMatch(/sidebarV2Enabled\s*=\s*Vue\.computed\(/);
    expect(pageSrc).toMatch(/onSelectThreadV2\s*=/);
    expect(pageSrc).toMatch(/onSelectTaskV2\s*=/);
    // returned to template
    expect(pageSrc).toMatch(/sidebarV2Enabled,\s*\n\s*onSelectThreadV2,/);
  });

  it('select handlers delegate to store setters (guarded for part-1 stub)', () => {
    expect(pageSrc).toMatch(/store\.setActiveThread/);
    expect(pageSrc).toMatch(/store\.setActiveTaskUi/);
  });
});

// --- 3. Component i18n polish (task-300 nits) -------------------------------
describe('sidebar v2 i18n polish', () => {
  it('placeholder binds to placeholderText computed (i18n-aware)', () => {
    expect(componentSrc).toMatch(/:placeholder="placeholderText"/);
    expect(componentSrc).toMatch(/placeholderText\s*\(\)\s*\{[\s\S]*?unify\.sidebar\.searchPlaceholder/);
  });

  it('"main" thread rows use threadDisplayName returning Inbox label', () => {
    expect(componentSrc).toMatch(/threadDisplayName\s*\(t\)\s*\{[\s\S]*?id === 'main'[\s\S]*?unify\.inbox/);
    // all three group rows use the helper (not raw t.name)
    const usages = componentSrc.match(/threadDisplayName\(t\)/g) || [];
    expect(usages.length).toBeGreaterThanOrEqual(3);
  });

  // Behavioral check on threadDisplayName directly.
  it('threadDisplayName returns "Inbox" literal when $t absent and id is main', () => {
    const ctx = { threads: [], $t: null };
    const out = UnifySidebarV2.methods.threadDisplayName.call(ctx, { id: 'main', name: 'main' });
    expect(out).toBe('Inbox');
  });

  it('threadDisplayName returns localized value when $t is injected', () => {
    const ctx = { threads: [], $t: (k) => (k === 'unify.inbox' ? '收件箱' : k) };
    const out = UnifySidebarV2.methods.threadDisplayName.call(ctx, { id: 'main', name: 'main' });
    expect(out).toBe('收件箱');
  });

  it('threadDisplayName passes through name for non-main threads', () => {
    const ctx = { threads: [], $t: (k) => k };
    const out = UnifySidebarV2.methods.threadDisplayName.call(ctx, { id: 't-design', name: 'design' });
    expect(out).toBe('design');
  });
});

// --- 4. i18n dictionaries ---------------------------------------------------
describe('i18n dictionaries', () => {
  it('en.js has unify.inbox = "Inbox"', () => {
    expect(enSrc).toMatch(/'unify\.inbox':\s*'Inbox'/);
  });

  it('zh-CN.js has unify.inbox = "收件箱"', () => {
    expect(zhSrc).toMatch(/'unify\.inbox':\s*'收件箱'/);
  });

  it('placeholder key hints at # prefix syntax (en)', () => {
    expect(enSrc).toMatch(/'unify\.sidebar\.searchPlaceholder':\s*'[^']*\(#name for threads\)/);
  });

  it('placeholder key hints at # prefix syntax (zh)', () => {
    expect(zhSrc).toMatch(/'unify\.sidebar\.searchPlaceholder':\s*'[^']*#名称[^']*'/);
  });
});
