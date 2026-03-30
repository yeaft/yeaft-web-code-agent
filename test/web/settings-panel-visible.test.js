import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #397 — Fix Settings panel not showing in split-pane mode.
 *
 * Root cause: GlobalSidebar rendered SettingsPanel with `v-if="settingsOpen"`
 * which mounts/unmounts the component but never passes the `visible` prop.
 * SettingsPanel's template uses `v-if="visible"` internally, so visible was
 * undefined → panel never rendered.
 *
 * Fix: Change to `:visible="settingsOpen"` (same pattern as ChatPage).
 *
 * Covers 4 areas:
 * 1. GlobalSidebar — passes :visible prop to SettingsPanel
 * 2. GlobalSidebar — @close handler still wired
 * 3. ChatPage regression — still uses :visible pattern
 * 4. SettingsPanel — declares visible as a Boolean prop
 */

let globalSidebarSource;
let chatPageSource;
let settingsPanelSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web/components');
  globalSidebarSource = readFileSync(resolve(base, 'GlobalSidebar.js'), 'utf-8');
  chatPageSource = readFileSync(resolve(base, 'ChatPage.js'), 'utf-8');
  settingsPanelSource = readFileSync(resolve(base, 'SettingsPanel.js'), 'utf-8');
});

// =====================================================================
// 1. GlobalSidebar — passes :visible prop to SettingsPanel
// =====================================================================
describe('GlobalSidebar — SettingsPanel :visible prop', () => {
  it('should pass :visible="settingsOpen" to SettingsPanel', () => {
    expect(globalSidebarSource).toContain(':visible="settingsOpen"');
  });

  it('should NOT use v-if="settingsOpen" on SettingsPanel (the old bug)', () => {
    // The old code was: <SettingsPanel v-if="settingsOpen" ...>
    // After fix, v-if is gone, replaced by :visible
    // Check that v-if="settingsOpen" does NOT appear on the SettingsPanel line
    const panelLine = globalSidebarSource
      .split('\n')
      .find(line => line.includes('<SettingsPanel'));
    expect(panelLine).toBeDefined();
    expect(panelLine).not.toContain('v-if="settingsOpen"');
    expect(panelLine).toContain(':visible="settingsOpen"');
  });

  it('should import SettingsPanel component', () => {
    expect(globalSidebarSource).toContain("import SettingsPanel from './SettingsPanel.js'");
  });

  it('should register SettingsPanel in components', () => {
    expect(globalSidebarSource).toContain('components: { SettingsPanel }');
  });

  it('should initialize settingsOpen as a ref', () => {
    expect(globalSidebarSource).toContain('settingsOpen = Vue.ref(false)');
  });

  it('should have a settings button that sets settingsOpen to true', () => {
    expect(globalSidebarSource).toContain('settingsOpen = true');
  });
});

// =====================================================================
// 2. GlobalSidebar — @close handler still wired
// =====================================================================
describe('GlobalSidebar — SettingsPanel @close handler', () => {
  it('should wire @close to set settingsOpen to false', () => {
    const panelLine = globalSidebarSource
      .split('\n')
      .find(line => line.includes('<SettingsPanel'));
    expect(panelLine).toContain('@close="settingsOpen = false"');
  });

  it('should return settingsOpen from setup for template access', () => {
    // The return block should include settingsOpen
    const returnBlock = globalSidebarSource.substring(
      globalSidebarSource.indexOf('return {'),
      globalSidebarSource.indexOf('}', globalSidebarSource.indexOf('return {') + 8) + 1
    );
    expect(returnBlock).toContain('settingsOpen');
  });
});

// =====================================================================
// 3. ChatPage regression — still uses :visible pattern
// =====================================================================
describe('ChatPage regression — SettingsPanel usage', () => {
  it('should use :visible prop on SettingsPanel (not v-if)', () => {
    const panelLine = chatPageSource
      .split('\n')
      .find(line => line.includes('<SettingsPanel'));
    expect(panelLine).toBeDefined();
    expect(panelLine).toContain(':visible=');
  });

  it('should wire @close handler on SettingsPanel', () => {
    const panelLine = chatPageSource
      .split('\n')
      .find(line => line.includes('<SettingsPanel'));
    expect(panelLine).toContain('@close=');
  });

  it('both GlobalSidebar and ChatPage should use the same prop pattern', () => {
    // Both should use :visible="..." @close="..." — extract the prop names
    const gsLine = globalSidebarSource.split('\n').find(l => l.includes('<SettingsPanel'));
    const cpLine = chatPageSource.split('\n').find(l => l.includes('<SettingsPanel'));
    // Both must have :visible and @close
    expect(gsLine).toContain(':visible=');
    expect(gsLine).toContain('@close=');
    expect(cpLine).toContain(':visible=');
    expect(cpLine).toContain('@close=');
  });
});

// =====================================================================
// 4. SettingsPanel — declares visible as a Boolean prop
// =====================================================================
describe('SettingsPanel — visible prop declaration', () => {
  it('should declare visible as a prop', () => {
    expect(settingsPanelSource).toContain('visible');
  });

  it('should declare visible with Boolean type', () => {
    // The props block should have: visible: Boolean
    const propsBlock = settingsPanelSource.substring(
      settingsPanelSource.indexOf('props:'),
      settingsPanelSource.indexOf('}', settingsPanelSource.indexOf('props:')) + 1
    );
    expect(propsBlock).toContain('visible');
    expect(propsBlock).toContain('Boolean');
  });

  it('should use visible prop in template for conditional rendering', () => {
    // SettingsPanel template should reference props.visible or just visible
    // The template uses v-if="visible" to control rendering
    expect(settingsPanelSource).toContain('visible');
  });
});
