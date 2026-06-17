import { describe, expect, it } from 'vitest';
import { modelOptionMatchesRef, modelOptionRef, resolveSessionModelEffort, resolveSessionModelRef } from '../../web/utils/modelRefs.js';

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
  it('keeps model choice pending until Apply and exposes Cancel', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../../web/components/YeaftPage.js', import.meta.url), 'utf8');

    expect(source).toContain('@click="selectPendingModel(modelOptionRef(m))"');
    expect(source).toContain('@click="selectPendingEffort(effort)"');
    expect(source).toContain('@click="applyModelSelection"');
    expect(source).toContain('@click="cancelModelSelection"');
    expect(source).not.toContain('@click="selectModel(modelOptionRef(m))"');
    expect(source).not.toContain('@click="selectEffort(effort)"');
  });
});
