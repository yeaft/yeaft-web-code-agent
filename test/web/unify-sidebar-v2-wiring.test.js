import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-341 — V2 sidebar is the ONLY sidebar.
 *
 * Legacy `<aside class="unify-sidebar">` block is deleted wholesale.
 * The feature flag is kept as a constant `true` for field backward-compat
 * but the URL/localStorage hydration is gone, the setter is a no-op stub.
 *
 * UnifyPage now mounts UnifySidebarV2 unconditionally and wires
 * toggle-sidebar / back emits back to the page's own handlers.
 */

const rootDir = join(import.meta.dirname, '..', '..');
const storeSrc = readFileSync(join(rootDir, 'web/stores/chat.js'), 'utf8');
const pageSrc = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');
const enSrc = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
const zhSrc = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');

// --- 1. Store flag (task-341: constant true, stub setter) -------------------
describe('store feature flag (task-341: constant)', () => {
  it('declares unifySidebarV2Enabled as a constant true', () => {
    expect(storeSrc).toMatch(/unifySidebarV2Enabled:\s*true/);
  });

  it('keeps setUnifySidebarV2Enabled stub for backward compat', () => {
    expect(storeSrc).toMatch(/setUnifySidebarV2Enabled\s*\(/);
  });

  it('setter sweeps the stale localStorage key', () => {
    expect(storeSrc).toMatch(/removeItem\(['"]unify-sidebar-v2-enabled['"]/);
  });
});

// --- 2. UnifyPage wiring (V2 is the only sidebar) ---------------------------
describe('UnifyPage wiring (task-341)', () => {
  it('imports UnifySidebarV2 and registers it as a component', () => {
    expect(pageSrc).toMatch(/import UnifySidebarV2 from/);
    expect(pageSrc).toMatch(/components:\s*\{[^}]*UnifySidebarV2[^}]*\}/);
  });

  it('renders UnifySidebarV2 unconditionally (no v-if / no v-else)', () => {
    expect(pageSrc).toMatch(/<UnifySidebarV2[\s\S]*?@select-thread=/);
    expect(pageSrc).not.toMatch(/<UnifySidebarV2[\s\S]*?v-if="sidebarV2Enabled"/);
    expect(pageSrc).not.toMatch(/<aside\s+class="unify-sidebar"\s+v-else/);
  });

  it('wires @toggle-sidebar and @back emits from the V2 sidebar', () => {
    expect(pageSrc).toMatch(/@toggle-sidebar="toggleSidebar"/);
    expect(pageSrc).toMatch(/@back="goBack"/);
  });

  it('legacy unify-sidebar-toggle in topbar is removed', () => {
    expect(pageSrc).not.toContain('unify-sidebar-toggle');
  });

  it('select handlers still delegate to store setters (task-315 preserved)', () => {
    expect(pageSrc).toMatch(/store\.setActiveThread/);
    expect(pageSrc).toMatch(/store\.enterTaskDetailView/);
  });
});

// --- 3. V2 sidebar header row (task-341) ------------------------------------
describe('V2 sidebar header row (task-341)', () => {
  it('declares toggle-sidebar and back in emits', () => {
    expect(componentSrc).toMatch(/emits:[\s\S]*?['"]toggle-sidebar['"]/);
    expect(componentSrc).toMatch(/emits:[\s\S]*?['"]back['"]/);
  });

  it('renders a usv2-header-row with brand + actions', () => {
    expect(componentSrc).toMatch(/class="usv2-header-row"/);
    expect(componentSrc).toMatch(/class="usv2-brand"/);
    expect(componentSrc).toMatch(/class="usv2-header-actions"/);
  });

  it('header has collapse and back buttons wired to emits', () => {
    expect(componentSrc).toMatch(/@click="\$emit\('toggle-sidebar'\)"/);
    expect(componentSrc).toMatch(/@click="\$emit\('back'\)"/);
  });

  it('header has conditional workbench button gated by canUseWorkbench', () => {
    expect(componentSrc).toMatch(/v-if="canUseWorkbench"[\s\S]*?onToggleWorkbench/);
  });

  it('exposes canUseWorkbench + agent identity computeds', () => {
    expect(componentSrc).toMatch(/canUseWorkbench\s*\(\)/);
    expect(componentSrc).toMatch(/onlineAgentCount\s*\(\)/);
    expect(componentSrc).toMatch(/currentAgentLatency\s*\(\)/);
  });

  it('exposes getLatencyClass method', () => {
    expect(componentSrc).toMatch(/getLatencyClass\s*\(latency\)/);
  });
});

// --- 4. Component i18n polish (preserved) -----------------------------------
describe('sidebar v2 i18n polish', () => {
  it('placeholder binds to placeholderText computed (i18n-aware)', () => {
    expect(componentSrc).toMatch(/:placeholder="placeholderText"/);
    expect(componentSrc).toMatch(/placeholderText\s*\(\)\s*\{[\s\S]*?unify\.sidebar\.searchPlaceholder/);
  });

  it('"main" thread rows use threadDisplayName returning Inbox label', () => {
    expect(componentSrc).toMatch(/threadDisplayName\s*\(t\)\s*\{[\s\S]*?id === 'main'[\s\S]*?unify\.inbox/);
    const usages = componentSrc.match(/threadDisplayName\(t\)/g) || [];
    expect(usages.length).toBeGreaterThanOrEqual(3);
  });

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

// --- 5. i18n dictionaries ---------------------------------------------------
describe('i18n dictionaries', () => {
  it('en.js has unify.inbox = "Inbox"', () => {
    expect(enSrc).toMatch(/'unify\.inbox':\s*'Inbox'/);
  });

  it('zh-CN.js has unify.inbox = "收件箱"', () => {
    expect(zhSrc).toMatch(/'unify\.inbox':\s*'收件箱'/);
  });

  it('placeholder key hints at # prefix syntax (en)', () => {
    expect(enSrc).toMatch(/'unify\.sidebar\.searchPlaceholder':\s*'[^']*#name[^']*'/);
  });

  it('placeholder key hints at # prefix syntax (zh)', () => {
    expect(zhSrc).toMatch(/'unify\.sidebar\.searchPlaceholder':\s*'[^']*#名称[^']*'/);
  });
});
