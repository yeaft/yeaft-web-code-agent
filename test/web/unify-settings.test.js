/**
 * Static source analysis tests for Unify Settings panel (task-275).
 *
 * Verifies the full pipeline:
 *   UnifySettings.js component → UnifyPage.js integration → CSS → i18n
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');

const unifySettings = readFileSync(join(root, 'web/components/UnifySettings.js'), 'utf8');
const unifyPage = readFileSync(join(root, 'web/components/UnifyPage.js'), 'utf8');
const unifyCss = readFileSync(join(root, 'web/styles/unify.css'), 'utf8');
const enI18n = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zhI18n = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');
const chatStore = readFileSync(join(root, 'web/stores/chat.js'), 'utf8');

describe('Unify Settings — UnifySettings.js component', () => {
  it('exports a Vue component with name UnifySettings', () => {
    expect(unifySettings).toContain("name: 'UnifySettings'");
  });

  it('emits close and saved events', () => {
    expect(unifySettings).toContain("emits: ['close', 'saved']");
  });

  it('sends get_llm_config with unifyAgentId', () => {
    expect(unifySettings).toContain("type: 'get_llm_config'");
    expect(unifySettings).toContain('store.unifyAgentId');
  });

  it('sends update_llm_config on save', () => {
    expect(unifySettings).toContain("type: 'update_llm_config'");
  });

  it('sends unify_reset after save to refresh Engine config', () => {
    expect(unifySettings).toContain("type: 'unify_reset'");
  });

  it('has provider CRUD: add, remove, protocol change', () => {
    expect(unifySettings).toContain('function addProvider');
    expect(unifySettings).toContain('function removeProvider');
    expect(unifySettings).toContain('function onProtocolChange');
  });

  it('has model selection (primaryModel, fastModel)', () => {
    expect(unifySettings).toContain('localPrimaryModel');
    expect(unifySettings).toContain('localFastModel');
  });

  it('watches store.llmConfig for config updates', () => {
    expect(unifySettings).toContain('store.llmConfig');
  });

  it('has API key toggle for security', () => {
    expect(unifySettings).toContain('function toggleApiKey');
    expect(unifySettings).toContain('showApiKey');
  });
});

describe('Unify Settings — UnifyPage.js integration', () => {
  it('imports UnifySettings component', () => {
    expect(unifyPage).toContain("import UnifySettings from './UnifySettings.js'");
  });

  it('registers UnifySettings in components', () => {
    expect(unifyPage).toContain('UnifySettings');
  });

  it('has showSettings ref', () => {
    expect(unifyPage).toContain('showSettings');
  });

  it('has settings panel wiring via toggleSettings (task-341: button migrated out of sidebar)', () => {
    expect(unifyPage).toContain('toggleSettings');
    expect(unifyPage).toContain('showSettings');
  });

  it('conditionally renders MessageList vs UnifySettings', () => {
    expect(unifyPage).toContain('v-if="!showSettings"');
    expect(unifyPage).toContain('v-if="showSettings"');
  });

  it('has toggleSettings function', () => {
    expect(unifyPage).toContain('const toggleSettings');
  });

  it('has onSettingsSaved handler that closes settings', () => {
    expect(unifyPage).toContain('const onSettingsSaved');
    expect(unifyPage).toContain('@saved="onSettingsSaved"');
  });
});

describe('Unify Settings — CSS', () => {
  it('has .unify-settings-btn class', () => {
    expect(unifyCss).toContain('.unify-settings-btn');
  });

  it('has .unify-settings class for panel', () => {
    expect(unifyCss).toContain('.unify-settings {');
  });

  it('has .unify-settings-provider class', () => {
    expect(unifyCss).toContain('.unify-settings-provider');
  });

  it('has .unify-settings-save-btn class', () => {
    expect(unifyCss).toContain('.unify-settings-save-btn');
  });

  it('has .unify-settings-field input styling', () => {
    expect(unifyCss).toContain('.unify-settings-field input');
  });
});

describe('Unify Settings — i18n', () => {
  it('has unify.settings.title in English', () => {
    expect(enI18n).toContain("'unify.settings.title'");
  });

  it('has unify.settings.title in Chinese', () => {
    expect(zhI18n).toContain("'unify.settings.title'");
  });

  // Reuses existing settings.llm.* keys — verify they exist
  it('has settings.llm.providersTitle in English', () => {
    expect(enI18n).toContain("'settings.llm.providersTitle'");
  });

  it('has settings.llm.save in English', () => {
    expect(enI18n).toContain("'settings.llm.save'");
  });
});

describe('Unify Settings — Store compatibility', () => {
  it('store has llmConfig state object', () => {
    expect(chatStore).toContain('llmConfig: {}');
  });
});
