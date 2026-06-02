import { describe, it, expect } from 'vitest';
import { getProvider, isValidProvider, PROVIDER_NAMES, DEFAULT_PROVIDER } from '../../../agent/providers/index.js';

describe('provider registry', () => {
  it('lists claude-code and copilot', () => {
    expect(PROVIDER_NAMES).toContain('claude-code');
    expect(PROVIDER_NAMES).toContain('copilot');
  });

  it('defaults to claude-code', () => {
    expect(DEFAULT_PROVIDER).toBe('claude-code');
    const d = getProvider(undefined);
    expect(d.name).toBe('claude-code');
  });

  it('returns the copilot driver', () => {
    const d = getProvider('copilot');
    expect(d.name).toBe('copilot');
    expect(typeof d.start).toBe('function');
    expect(typeof d.sendInput).toBe('function');
    expect(typeof d.abort).toBe('function');
  });

  it('throws for unknown provider names', () => {
    expect(() => getProvider('hermes')).toThrow(/Unknown chat provider/);
  });

  it('isValidProvider only accepts known string names', () => {
    expect(isValidProvider('claude-code')).toBe(true);
    expect(isValidProvider('copilot')).toBe(true);
    expect(isValidProvider('hermes')).toBe(false);
    expect(isValidProvider(undefined)).toBe(false);
    expect(isValidProvider(null)).toBe(false);
  });
});
