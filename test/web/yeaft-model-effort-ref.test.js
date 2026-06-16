import { describe, expect, it } from 'vitest';
import { modelOptionMatchesRef, modelOptionRef } from '../../web/utils/modelRefs.js';

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
    const claude = { id: 'claude-opus-4.8', provider: 'github-copilot', effortOptions: ['low', 'medium', 'high'] };

    expect(modelOptionMatchesRef(gpt, 'github-copilot/gpt-5.5')).toBe(true);
    expect(gpt.effortOptions).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(modelOptionMatchesRef(claude, 'github-copilot/claude-opus-4.8')).toBe(true);
    expect(claude.effortOptions).toEqual(['low', 'medium', 'high']);
  });
});
