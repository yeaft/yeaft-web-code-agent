/**
 * Static source analysis tests for Unify Settings panel (task-275, task-343).
 *
 * task-343 refactor: UnifySettings is now a two-column tabbed dialog.
 *   - Tab 1 (LLM)  delegates provider CRUD to LlmTab (context="unify")
 *   - Tab 2 (VP)   renders VpCrudPanel
 *   - Reuses .settings-* class tokens from SettingsPanel for size parity
 *   - `unify_reset` is dispatched from the host in response to LlmTab's
 *     `saved` emit (LlmTab stays context-agnostic)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');

const unifySettings = readFileSync(join(root, 'web/components/UnifySettings.js'), 'utf8');
const llmTab        = readFileSync(join(root, 'web/components/LlmTab.js'), 'utf8');
const vpCrudPanel   = readFileSync(join(root, 'web/components/VpCrudPanel.js'), 'utf8');
const unifyPage     = readFileSync(join(root, 'web/components/UnifyPage.js'), 'utf8');
const enI18n        = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zhI18n        = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');
const chatStore     = readFileSync(join(root, 'web/stores/chat.js'), 'utf8');

describe('UnifySettings — task-343 two-column tab shell', () => {
  it('exports a Vue component with name UnifySettings', () => {
    expect(unifySettings).toContain("name: 'UnifySettings'");
  });

  it('emits close and saved events', () => {
    expect(unifySettings).toContain("emits: ['close', 'saved']");
  });

  it('declares initialTab prop (default llm)', () => {
    expect(unifySettings).toMatch(/initialTab:\s*\{\s*type:\s*String,\s*default:\s*['"]llm['"]/);
  });

  it('registers LlmTab and VpCrudPanel in components', () => {
    expect(unifySettings).toMatch(/components:\s*\{\s*LlmTab,\s*VpCrudPanel/);
  });

  it('uses SettingsPanel .settings-* class tokens (no unify-settings-* mirror)', () => {
    expect(unifySettings).toContain('class="settings-overlay"');
    expect(unifySettings).toContain('class="settings-dialog"');
    expect(unifySettings).toContain('class="settings-nav"');
    expect(unifySettings).toContain('class="settings-content"');
    expect(unifySettings).toContain('class="settings-pane"');
  });

  it('embeds LlmTab with context="unify" and listens to @saved', () => {
    expect(unifySettings).toMatch(/<LlmTab\s+context="unify"[\s\S]*@saved=/);
  });

  it('dispatches unify_reset from the host when LlmTab emits saved', () => {
    expect(unifySettings).toContain("type: 'unify_reset'");
    expect(unifySettings).toContain('function onLlmSaved');
  });

  it('renders VpCrudPanel inside the vp tab pane', () => {
    expect(unifySettings).toMatch(/<div v-show="activeTab === 'vp'"[\s\S]*<VpCrudPanel/);
  });
});

describe('LlmTab — task-343 context-aware agent scoping', () => {
  it('accepts context prop (default chat)', () => {
    expect(llmTab).toMatch(/context:\s*\{\s*type:\s*String,\s*default:\s*['"]chat['"]/);
  });

  it('exposes effectiveAgentId computed that swaps to unifyAgentId when context=unify', () => {
    expect(llmTab).toContain('effectiveAgentId');
    expect(llmTab).toMatch(/unifyAgentId/);
  });

  it('emits "saved" on successful save (for host unify_reset hand-off)', () => {
    expect(llmTab).toMatch(/emits:\s*\[[^\]]*['"]saved['"]/);
    expect(llmTab).toContain("this.$emit('saved')");
  });
});

describe('VpCrudPanel — task-343 extracted from VpCrudModal', () => {
  it('exports component named VpCrudPanel', () => {
    expect(vpCrudPanel).toContain("name: 'VpCrudPanel'");
  });

  it('has no modal overlay chrome (no .vp-crud-overlay wrapper, no close emit)', () => {
    expect(vpCrudPanel).not.toContain('vp-crud-overlay');
    expect(vpCrudPanel).not.toContain("$emit('close')");
  });

  it('preserves CRUD methods from VpCrudModal (startCreate/startEdit/confirmDelete/onSubmit)', () => {
    expect(vpCrudPanel).toContain('startCreate');
    expect(vpCrudPanel).toContain('startEdit');
    expect(vpCrudPanel).toContain('confirmDelete');
    expect(vpCrudPanel).toContain('onSubmit');
  });
});

describe('UnifyPage — task-343 VP via Settings-tab wiring', () => {
  it('imports UnifySettings component', () => {
    expect(unifyPage).toContain("import UnifySettings from './UnifySettings.js'");
  });

  it('passes :initial-tab to UnifySettings', () => {
    expect(unifyPage).toMatch(/:initial-tab=["']settingsInitialTab["']/);
  });

  it('declares settingsInitialTab ref (seeded to llm)', () => {
    expect(unifyPage).toMatch(/settingsInitialTab\s*=\s*Vue\.ref\(['"]llm['"]\)/);
  });

  it('does NOT import deleted VpCrudModal / VpLibraryLink', () => {
    expect(unifyPage).not.toContain("from './VpCrudModal.js'");
    expect(unifyPage).not.toContain("from './VpLibraryLink.js'");
  });

  it('exposes openSettings helper that routes to vp tab', () => {
    expect(unifyPage).toContain('const openSettings');
    expect(unifyPage).toMatch(/openSettings\(\s*\{\s*initialTab:\s*['"]vp['"]/);
  });

  it('has onSettingsSaved handler that closes settings', () => {
    expect(unifyPage).toContain('const onSettingsSaved');
    expect(unifyPage).toContain('@saved="onSettingsSaved"');
  });

  it('no residual vpLibraryOpen / onOpenVpLibrary state after cleanup', () => {
    expect(unifyPage).not.toContain('vpLibraryOpen');
    expect(unifyPage).not.toContain('onOpenVpLibrary');
  });
});

describe('UnifySettings — i18n', () => {
  it('has unify.settings.title in both locales', () => {
    expect(enI18n).toContain("'unify.settings.title'");
    expect(zhI18n).toContain("'unify.settings.title'");
  });

  it('has tab labels unify.settings.tabs.llm / .vp in both locales', () => {
    expect(enI18n).toContain("'unify.settings.tabs.llm'");
    expect(enI18n).toContain("'unify.settings.tabs.vp'");
    expect(zhI18n).toContain("'unify.settings.tabs.llm'");
    expect(zhI18n).toContain("'unify.settings.tabs.vp'");
  });

  it('preserves existing settings.llm.* keys (still owned by LlmTab)', () => {
    expect(enI18n).toContain("'settings.llm.providersTitle'");
    expect(enI18n).toContain("'settings.llm.save'");
  });
});

describe('UnifySettings — Store compatibility', () => {
  it('store has llmConfig state object', () => {
    expect(chatStore).toContain('llmConfig: {}');
  });
});
