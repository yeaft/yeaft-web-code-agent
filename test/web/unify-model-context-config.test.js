/**
 * test/web/unify-model-context-config.test.js
 *
 * Static source tests for task-284 UI:
 *   - UnifyPage dropdown shows context window (grey, "400k · 128k out")
 *   - UnifySettings provider protocol has openai-responses option + hint
 *   - Each model row offers ctx / maxOutput number inputs
 *   - i18n keys exist in both en.js and zh-CN.js
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const unifyPage = readFileSync(join(root, 'web/components/UnifyPage.js'), 'utf8');
const unifySettings = readFileSync(join(root, 'web/components/UnifySettings.js'), 'utf8');
const llmTab = readFileSync(join(root, 'web/components/LlmTab.js'), 'utf8');
const enI18n = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zhI18n = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('UnifyPage model dropdown — context window display', () => {
  it('renders contextWindow when available', () => {
    // Template shows context/maxOutput on each option
    expect(unifyPage).toMatch(/formatTokens|contextWindow|unify-model-option-ctx/);
  });

  it('has a formatTokens helper', () => {
    expect(unifyPage).toContain('formatTokens');
  });

  it('conditionally shows ctx info only when set (no "—" placeholder)', () => {
    // The spec explicitly says: "都没有就完全不显示（不要画 '—' 占位）"
    // We assert the template has a v-if on contextWindow for the ctx element.
    expect(unifyPage).toMatch(/v-if="m\.contextWindow/);
  });
});

describe('LlmTab — protocol options include openai-responses (task-343: moved from UnifySettings)', () => {
  it('has openai-responses as a protocol option', () => {
    expect(llmTab).toContain('openai-responses');
  });

  it('shows protocol hint below select', () => {
    expect(llmTab).toMatch(/protocolHint/);
  });
});

describe('LlmTab — per-model row with ctx/max inputs', () => {
  // task-343: LlmTab uses the simpler comma-separated textarea approach for
  // models (not the per-row rich UI the legacy UnifySettings had). The rich
  // row UI / normalizeModelForSave helper is a follow-up.
  it.todo('renders ctx and maxOutput number inputs per model row (task-343 follow-up)');
  it.todo('preserves id-only models as strings when saving (back-compat) (task-343 follow-up)');
});

describe('LlmTab — protocol hint shown', () => {
  it('has a dynamic protocol hint below select', () => {
    expect(llmTab).toContain('protocolHint');
  });
});

describe('i18n — new keys exist in both en and zh-CN', () => {
  const keys = [
    'settings.llm.protocolHint.anthropic',
    'settings.llm.protocolHint.openai',
    'settings.llm.protocolHint.openaiResponses',
    'settings.llm.protocolOpenAIResponses',
    'settings.llm.modelCtxPlaceholder',
    'settings.llm.modelMaxPlaceholder',
  ];
  for (const key of keys) {
    it(`en.js has ${key}`, () => expect(enI18n).toContain(`'${key}'`));
    it(`zh-CN.js has ${key}`, () => expect(zhI18n).toContain(`'${key}'`));
  }
});
