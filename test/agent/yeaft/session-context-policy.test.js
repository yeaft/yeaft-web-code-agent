import { describe, it, expect } from 'vitest';
import {
  GROUP_CONTEXT_PRESSURE_RATIO,
  shouldAllowGroupReflection,
} from '../../../agent/yeaft/engine.js';
import { resolveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';

function messagesWithTokens(approxTokenCount, turns = 1) {
  const charsPerTurn = Math.max(4, Math.ceil((approxTokenCount * 4) / turns));
  const ms = [];
  for (let i = 0; i < turns; i++) {
    ms.push({ role: 'user', content: `q${i} ${'x'.repeat(charsPerTurn)}` });
    ms.push({ role: 'assistant', content: `a${i}` });
  }
  return ms;
}

describe('group context policy', () => {
  it('does not allow group reflection below 80% context pressure', () => {
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: messagesWithTokens(60_000, 6),
      model: 'unknown-model-for-test',
      config: { maxContextTokens: 100_000 },
      sessionId: 'grp-a',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.threshold).toBe(80_000);
    expect(gate.ratio).toBe(GROUP_CONTEXT_PRESSURE_RATIO);
    expect(gate.compactAllowed).toBe(true);
  });

  it('allows group reflection at or above 80% context pressure', () => {
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: messagesWithTokens(82_000, 6),
      model: 'unknown-model-for-test',
      config: { maxContextTokens: 100_000 },
      sessionId: 'grp-a',
    });

    expect(gate.allowed).toBe(true);
    expect(gate.tokenEstimate).toBeGreaterThanOrEqual(gate.threshold);
  });

  it('protects fewer than 5 turns from compact below 80% pressure', () => {
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: messagesWithTokens(60_000, 4),
      model: 'unknown-model-for-test',
      config: { maxContextTokens: 100_000 },
      sessionId: 'grp-a',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.compactAllowed).toBe(false);
    expect(gate.turnCount).toBe(4);
  });

  it('uses fallback max context metadata for unknown models', () => {
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: [],
      model: 'definitely-not-in-registry',
      config: {},
      sessionId: 'grp-a',
    });

    expect(gate.contextWindow).toBe(200_000);
    expect(gate.threshold).toBe(160_000);
    expect(gate.usedFallbackContextWindow).toBe(true);
  });

  it('uses the effective per-group model override for registry context windows', () => {
    const effectiveConfig = resolveSessionConfig(
      { model: 'gpt-4.1', primaryModel: 'gpt-4.1' },
      { model: 'claude-sonnet-4-20250514' },
    );
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: messagesWithTokens(220_000, 6),
      model: effectiveConfig.model,
      config: effectiveConfig,
      sessionId: 'grp-a',
    });

    expect(effectiveConfig.model).toBe('claude-sonnet-4-20250514');
    expect(gate.contextWindow).toBe(200_000);
    expect(gate.threshold).toBe(160_000);
    expect(gate.allowed).toBe(true);
  });

  it('uses the effective per-group model before user model context metadata', () => {
    const effectiveConfig = resolveSessionConfig(
      { model: 'claude-sonnet-4-20250514', primaryModel: 'claude-sonnet-4-20250514' },
      { model: 'gpt-4.1' },
    );
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: messagesWithTokens(220_000, 6),
      model: effectiveConfig.model,
      config: effectiveConfig,
      sessionId: 'grp-a',
    });

    expect(effectiveConfig.model).toBe('gpt-4.1');
    expect(gate.contextWindow).toBe(1047576);
    expect(gate.threshold).toBe(Math.floor(1047576 * GROUP_CONTEXT_PRESSURE_RATIO));
    expect(gate.allowed).toBe(false);
  });

  it('leaves non-group reflection behavior enabled', () => {
    const gate = shouldAllowGroupReflection({
      system: '',
      messages: [],
      model: 'unknown-model-for-test',
      config: {},
      sessionId: null,
    });

    expect(gate.allowed).toBe(true);
    expect(gate.compactAllowed).toBe(true);
    expect(gate.usedFallbackContextWindow).toBe(false);
  });
});
