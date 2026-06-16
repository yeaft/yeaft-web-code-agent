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
});
