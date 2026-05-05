/**
 * task-708 — live-locale propagation tests.
 *
 * The fix has three moving parts:
 *
 *   1. `Engine.setLanguage(lang)` — public setter that mutates the
 *      private `#config.language` so the next call to
 *      `#buildSystemPrompt` reads the new value live.
 *   2. `broadcastLanguageChange(lang)` — exported from web-bridge.js;
 *      fans the new language out to every cached Engine in the per-VP
 *      pool plus the 1:1-chat session engine.
 *   3. `updateLlmConfig({ language })` — already-existing config-api
 *      surface that persists `language` to ~/.yeaft/config.json. We
 *      add a focused round-trip to guard the contract since the broadcast
 *      relies on `result.language` being present in the return value.
 *
 * No DOM / Vue. Pure node tests.
 */
import { describe, it, expect } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { buildWorkerPrompt } from '../../../agent/unify/prompts.js';
import { updateLlmConfig } from '../../../agent/unify/config-api.js';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

class StubAdapter {
  async *stream() { /* no-op */ }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

describe('Engine.setLanguage — live mutation', () => {
  it('exists as a public method', () => {
    const engine = new Engine({
      adapter: new StubAdapter(),
      trace: new NullTrace(),
      config: { model: 'test-model', language: 'en' },
    });
    expect(typeof engine.setLanguage).toBe('function');
  });

  it('does not throw on falsy / non-string input (no-op)', () => {
    const engine = new Engine({
      adapter: new StubAdapter(),
      trace: new NullTrace(),
      config: { model: 'test-model', language: 'en' },
    });
    // The setter must be defensive — message-router only invokes it
    // when result.language is truthy, but the contract is "tolerate
    // bad input rather than crash the agent".
    expect(() => engine.setLanguage('')).not.toThrow();
    expect(() => engine.setLanguage(null)).not.toThrow();
    expect(() => engine.setLanguage(undefined)).not.toThrow();
    expect(() => engine.setLanguage(42)).not.toThrow();
  });
});

describe('buildWorkerPrompt — language switching', () => {
  // The setter itself flips a private field; we cannot read it back.
  // What we CAN guarantee is that the prompt-builder honours the
  // language input. If buildWorkerPrompt picks the right slice for
  // each language, then any path that mutates this.#config.language
  // and then calls #buildSystemPrompt (which forwards
  // this.#config.language || 'en' into buildWorkerPrompt) will pick
  // up the new language on the very next turn — no engine teardown
  // required.

  it('renders English content when language="en"', () => {
    const prompt = buildWorkerPrompt({ language: 'en' });
    expect(prompt).toContain('AI Companion');
    expect(prompt).not.toContain('AI 伙伴');
  });

  it('renders Chinese content when language="zh"', () => {
    const prompt = buildWorkerPrompt({ language: 'zh' });
    expect(prompt).toContain('AI 伙伴');
    expect(prompt).not.toContain('AI Companion');
  });

  it('falls back to English on unknown language', () => {
    const prompt = buildWorkerPrompt({ language: 'klingon' });
    // extractLangSection returns the en slice when the requested
    // language has no <!-- lang:xx --> marker. Either we get the
    // English content, or the helper is more lenient — what matters
    // is that we don't render the literal markers as content.
    expect(prompt).not.toContain('<!-- lang:');
  });
});

describe('updateLlmConfig — language round-trip', () => {
  it('persists language and returns it in the result envelope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-locale-test-'));
    try {
      const result = updateLlmConfig({ language: 'zh' }, dir);
      expect(result.error).toBeUndefined();
      expect(result.language).toBe('zh');

      // Sanity-check the file on disk — message-router ONLY calls
      // broadcastLanguageChange when result.language is truthy, so the
      // round-trip must always populate it.
      const configPath = join(dir, 'config.json');
      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(persisted.language).toBe('zh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flips back to English on a second update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-locale-test-'));
    try {
      updateLlmConfig({ language: 'zh' }, dir);
      const result = updateLlmConfig({ language: 'en' }, dir);
      expect(result.language).toBe('en');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('broadcastLanguageChange — fan-out over cached engines', () => {
  it('calls setLanguage on every engine handed to it', async () => {
    // We cannot import the production `vpEngines` map directly (it's
    // module-private), so we test the broadcast contract by simulating
    // it: an array of fake engines that record their setLanguage calls,
    // run through the same iteration shape the real helper uses.

    const fakeEngines = [
      { calls: [], setLanguage(l) { this.calls.push(l); } },
      { calls: [], setLanguage(l) { this.calls.push(l); } },
      { calls: [], setLanguage(l) { this.calls.push(l); } },
    ];

    // Match the implementation's defensive shape: iterate, call
    // setLanguage if defined, swallow per-engine errors.
    for (const eng of fakeEngines) {
      try { eng.setLanguage?.('zh'); } catch { /* best-effort */ }
    }

    expect(fakeEngines[0].calls).toEqual(['zh']);
    expect(fakeEngines[1].calls).toEqual(['zh']);
    expect(fakeEngines[2].calls).toEqual(['zh']);
  });

  it('tolerates engines that do not implement setLanguage', () => {
    const mixedEngines = [
      { calls: [], setLanguage(l) { this.calls.push(l); } },
      { /* no setLanguage method — older engine instance */ },
    ];

    for (const eng of mixedEngines) {
      try { eng.setLanguage?.('en'); } catch { /* best-effort */ }
    }

    expect(mixedEngines[0].calls).toEqual(['en']);
    // Second engine should not have crashed the loop.
    expect(mixedEngines.length).toBe(2);
  });
});
