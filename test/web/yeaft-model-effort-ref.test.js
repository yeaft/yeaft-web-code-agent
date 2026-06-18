import { describe, expect, it } from 'vitest';
import { getDefaultModelEffort, modelOptionMatchesRef, modelOptionRef, resolveSessionModelEffort, resolveSessionModelRef } from '../../web/utils/modelRefs.js';

describe('Yeaft model effort provider-qualified refs', () => {
  it('matches topbar model metadata by explicit ref or provider/id pair', () => {
    const withRef = { id: 'gpt-5.4', ref: 'github-copilot/gpt-5.4', provider: 'github-copilot' };
    const withProvider = { id: 'claude-opus-4.8', provider: 'github-copilot' };

    expect(modelOptionRef(withRef)).toBe('github-copilot/gpt-5.4');
    expect(modelOptionRef(withProvider)).toBe('github-copilot/claude-opus-4.8');
    expect(modelOptionMatchesRef(withRef, 'github-copilot/gpt-5.4')).toBe(true);
    expect(modelOptionMatchesRef(withProvider, 'github-copilot/claude-opus-4.8')).toBe(true);
    expect(modelOptionMatchesRef(withProvider, 'claude-opus-4.8')).toBe(true);
  });

  it('preserves per-model effort option counts for UI selectors', () => {
    const gpt = { id: 'gpt-5.5', provider: 'github-copilot', effortOptions: ['minimal', 'low', 'medium', 'high'] };
    const claude = { id: 'claude-opus-4.8', provider: 'github-copilot', effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'], effortProtocol: 'anthropic-adaptive' };

    expect(modelOptionMatchesRef(gpt, 'github-copilot/gpt-5.5')).toBe(true);
    expect(gpt.effortOptions).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(modelOptionMatchesRef(claude, 'github-copilot/claude-opus-4.8')).toBe(true);
    expect(claude.effortOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(gpt.effortOptions).not.toContain('max');
  });

  it('resolves topbar model and effort from the active Session before agent defaults', () => {
    const sessionA = { id: 'session-a', config: { model: 'github-copilot/gpt-5.5', modelEffort: 'minimal' } };
    const sessionB = { id: 'session-b', config: { model: 'github-copilot/claude-opus-4.8', modelEffort: 'max' } };
    const unset = { id: 'session-c', config: {} };

    expect(resolveSessionModelRef(sessionA, 'proxy/gpt-5')).toBe('github-copilot/gpt-5.5');
    expect(resolveSessionModelEffort(sessionA, 'medium')).toBe('minimal');
    expect(resolveSessionModelRef(sessionB, 'proxy/gpt-5')).toBe('github-copilot/claude-opus-4.8');
    expect(resolveSessionModelEffort(sessionB, 'medium')).toBe('max');
    expect(resolveSessionModelRef(unset, 'proxy/gpt-5')).toBe('proxy/gpt-5');
    expect(resolveSessionModelEffort(unset, 'medium')).toBe('medium');
  });
});

describe('Yeaft model selector popover contract', () => {
  it('applies model choice immediately without Apply or Cancel actions', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../../web/components/YeaftPage.js', import.meta.url), 'utf8');

    expect(source).toContain('@click="selectModel(modelOptionRef(m))"');
    expect(source).toContain('@click="selectEffort(effort)"');
    expect(source).toContain('yeaft-model-option-main');
    expect(source).toContain('yeaft-model-option-meta');
    expect(source).not.toContain('selectPendingModel');
    expect(source).not.toContain('selectPendingEffort');
    expect(source).not.toContain('applyModelSelection');
    expect(source).not.toContain('cancelModelSelection');
  });

  it('uses a fixed bottom controls layout with only the model list scrolling', async () => {
    const { readFileSync } = await import('fs');
    const css = readFileSync(new URL('../../web/styles/yeaft.css', import.meta.url), 'utf8');

    expect(css).toContain('.yeaft-model-selector-body {\n  display: flex;\n  flex-direction: column;');
    expect(css).toContain('.yeaft-model-list {\n  min-width: 0;\n  max-height: 220px;\n  overflow-y: auto;');
    expect(css).toContain('.yeaft-model-fixed-controls {\n  flex-shrink: 0;');
    expect(css).toContain('.yeaft-model-dropdown {\n  background: var(--bg-main);');
    expect(css).toContain('overflow: hidden;');
    expect(css).not.toContain('grid-template-columns: minmax(0, 1fr) 180px;');
  });

  it('defaults reasoning effort to the second-highest option', () => {
    expect(getDefaultModelEffort(['minimal', 'low', 'medium', 'high'])).toBe('medium');
    expect(getDefaultModelEffort(['low', 'medium', 'high'])).toBe('medium');
    expect(getDefaultModelEffort(['low', 'high'])).toBe('low');
    expect(getDefaultModelEffort(['low', 'medium', 'high', 'xhigh'])).toBe('high');
  });
});
