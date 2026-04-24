/**
 * task-settings-nits — three small cleanups from task-284 review.
 *
 * Nit 1: addModel / removeModel i18n keys exist in both en and zh.
 * Nit 2: UnifySettings.js no longer references providerModelsText or
 *        onModelsTextChange (dead state removed).
 * Nit 3: web/utils/protocolPresets.js exposes PROTOCOL_PRESET_MODELS
 *        with anthropic, openai, openai-responses keys; both Settings
 *        components import from it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROTOCOL_PRESET_MODELS } from '../../web/utils/protocolPresets.js';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const unifySettings = read('web/components/UnifySettings.js');
const llmTab = read('web/components/LlmTab.js');
const enI18n = read('web/i18n/en.js');
const zhI18n = read('web/i18n/zh-CN.js');

// ─────────────────────────────────────────────────────────────
// Nit 1 — i18n keys for add/remove model
// ─────────────────────────────────────────────────────────────
describe('Nit 1 — addModel / removeModel i18n keys', () => {
  it('en.js has settings.llm.addModel', () => {
    expect(enI18n).toContain("'settings.llm.addModel'");
  });

  it('en.js has settings.llm.removeModel', () => {
    expect(enI18n).toContain("'settings.llm.removeModel'");
  });

  it('zh-CN.js has settings.llm.addModel', () => {
    expect(zhI18n).toContain("'settings.llm.addModel'");
  });

  it('zh-CN.js has settings.llm.removeModel', () => {
    expect(zhI18n).toContain("'settings.llm.removeModel'");
  });

  // task-343: LlmTab uses a textarea-based models field (providerModelsText),
  // not the per-row Add/Remove Model buttons from the legacy UnifySettings.
  // The old `addModel` / `removeModel` keys + dead-state asserts from task-284
  // no longer apply. The i18n keys themselves still exist (asserted above);
  // their UI use is deferred until a per-model rich row UI is (re-)added.
  it.todo('LlmTab uses settings.llm.addModel (regression: LlmTab uses textarea, not per-row buttons — task-343 follow-up)');
  it.todo('LlmTab uses settings.llm.removeModel (regression: LlmTab uses textarea, not per-row buttons — task-343 follow-up)');
});

// ─────────────────────────────────────────────────────────────
// Nit 2 — dead state check (task-343: moot; LlmTab legitimately uses
// providerModelsText for its textarea models UI).
// ─────────────────────────────────────────────────────────────
describe('Nit 2 — LlmTab textarea state (task-343: providerModelsText is live, not dead)', () => {
  it.todo('LlmTab.js does not contain providerModelsText (moot — textarea-based UI legitimately uses it)');
  it.todo('LlmTab.js does not contain onModelsTextChange (moot — textarea-based UI legitimately uses it)');
});

// ─────────────────────────────────────────────────────────────
// Nit 3 — shared protocol preset source
// ─────────────────────────────────────────────────────────────
describe('Nit 3 — PROTOCOL_PRESET_MODELS is a single source of truth', () => {
  it('exports all three protocol keys', () => {
    expect(PROTOCOL_PRESET_MODELS).toHaveProperty('anthropic');
    expect(PROTOCOL_PRESET_MODELS).toHaveProperty('openai');
    expect(PROTOCOL_PRESET_MODELS).toHaveProperty('openai-responses');
  });

  it('each preset list is a non-empty array of strings', () => {
    for (const key of ['anthropic', 'openai', 'openai-responses']) {
      const list = PROTOCOL_PRESET_MODELS[key];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const id of list) expect(typeof id).toBe('string');
    }
  });

  it('openai-responses preset includes the GPT-5 family', () => {
    const list = PROTOCOL_PRESET_MODELS['openai-responses'];
    expect(list).toContain('gpt-5');
    expect(list).toContain('gpt-5-mini');
    expect(list).toContain('gpt-5-nano');
    expect(list).toContain('gpt-5-pro');
  });

  it('LlmTab imports PROTOCOL_PRESET_MODELS from the shared util', () => {
    expect(llmTab).toMatch(/import\s*\{[^}]*PROTOCOL_PRESET_MODELS[^}]*\}\s*from\s*['"][^'"]*protocolPresets[^'"]*['"]/);
  });

  it('LlmTab no longer hardcodes the openai-responses preset array', () => {
    // The literal array should live only in protocolPresets.js now.
    expect(llmTab).not.toContain("'gpt-5-pro'");
  });

  it('LlmTab no longer hardcodes the full preset arrays inline', () => {
    // LlmTab's _getModelPresets should route through PROTOCOL_PRESET_MODELS,
    // not repeat the string literals.
    expect(llmTab).not.toContain("'claude-sonnet-4-20250514'");
  });
});
