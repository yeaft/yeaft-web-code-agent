import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-342 — Sidebar bottom row (Settings entry + version badge).
 *
 * Mirrors ChatPage's .sidebar-bottom pattern:
 *   .sidebar-bottom > .sidebar-nav-item [svg + label + .sidebar-version]
 *
 * The V2 component emits 'open-settings' on click; UnifyPage wires it
 * to its existing toggleSettings handler. HARD RULE from project
 * conventions: no border-top / border-bottom anywhere on the new rows.
 */

const rootDir = join(import.meta.dirname, '..', '..');
const v2Src = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');
const pageSrc = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const v2Css = readFileSync(join(rootDir, 'web/styles/unify-sidebar-v2.css'), 'utf8');
const indexCss = readFileSync(join(rootDir, 'web/styles/index.css'), 'utf8');

describe('task-342: V2 sidebar bottom row', () => {
  it('template has .sidebar-bottom containing a .sidebar-nav-item', () => {
    expect(v2Src).toMatch(/class="sidebar-bottom"/);
    expect(v2Src).toMatch(/class="sidebar-nav-item"/);
  });

  it('settings click emits open-settings', () => {
    expect(v2Src).toMatch(/@click="\$emit\('open-settings'\)"/);
  });

  it('declares open-settings in emits', () => {
    expect(v2Src).toMatch(/emits:[\s\S]*?['"]open-settings['"]/);
  });

  it('renders .sidebar-version when serverVersion is set', () => {
    expect(v2Src).toMatch(/v-if="serverVersion"\s+class="sidebar-version"/);
    expect(v2Src).toMatch(/\{\{\s*serverVersion\s*\}\}/);
  });

  it('component has serverVersion data and fetches /api/version', () => {
    expect(UnifySidebarV2.data).toBeTypeOf('function');
    const d = UnifySidebarV2.data.call({});
    expect(d.serverVersion).toBe('');
    expect(v2Src).toMatch(/fetch\(['"]\/api\/version['"]\)/);
  });
});

describe('task-342: UnifyPage wiring', () => {
  it('listens for @open-settings and opens settings via toggleSettings', () => {
    expect(pageSrc).toMatch(/@open-settings="toggleSettings"/);
  });

  it('legacy sidebar entries stay deleted (task-341 invariant)', () => {
    expect(pageSrc).not.toContain('unify-settings-btn');
    expect(pageSrc).not.toContain('unify-sidebar-footer');
  });
});

describe('task-342: CSS', () => {
  it('unify-sidebar-v2.css scopes .sidebar-bottom under .unify-sidebar-v2', () => {
    expect(v2Css).toMatch(/\.unify-sidebar-v2\s+\.sidebar-bottom\s*\{[^}]*margin-top:\s*auto/);
  });

  it('scopes .sidebar-version inside .unify-sidebar-v2', () => {
    expect(v2Css).toMatch(/\.unify-sidebar-v2\s+\.sidebar-version\s*\{/);
  });

  it('no border-top / border-bottom on sidebar-bottom rules (hard rule)', () => {
    const bottomBlock = v2Css.match(/\.unify-sidebar-v2\s+\.sidebar-bottom[\s\S]*?\}/);
    expect(bottomBlock).not.toBeNull();
    expect(bottomBlock[0]).not.toMatch(/border-top|border-bottom/);
  });

  it('unify-sidebar-v2.css is imported by index.css', () => {
    expect(indexCss).toContain("@import './unify-sidebar-v2.css'");
  });
});
