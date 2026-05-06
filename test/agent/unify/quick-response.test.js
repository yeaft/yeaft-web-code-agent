/**
 * Tests for `quick-response.js` — Track A of the Unify dual-track turn.
 *
 * Covers:
 *   - parseQuickJson: bare JSON, fenced JSON, leading-prose JSON, garbage.
 *   - buildQuickSystem: bilingual selection by `language`.
 *   - runQuickResponse: success, retry-once on first parse fail, retry
 *     ONLY once (second failure → null), abort short-circuits, missing
 *     adapter / model / prompt → null.
 *
 * Adapter is mocked as an async generator that yields the wired-in
 * sequence of events. We never hit the network.
 */

import { describe, it, expect } from 'vitest';
import { runQuickResponse, __test } from '../../../agent/unify/quick-response.js';

const { parseQuickJson, buildQuickSystem, PREVIEW_MAX_CHARS } = __test;

/**
 * Build a mock adapter where each `.stream(...)` call shifts one batch
 * off `responses`. A batch is an array of events that the generator
 * yields in order. After the list is exhausted further calls throw to
 * make accidental over-calls visible.
 */
function makeAdapter(responses) {
  const queue = [...responses];
  return {
    calls: [],
    async *stream(args) {
      this.calls.push(args);
      if (queue.length === 0) throw new Error('adapter called more times than scripted');
      const batch = queue.shift();
      for (const evt of batch) yield evt;
    },
  };
}

const td = (text) => ({ type: 'text_delta', text });

describe('parseQuickJson', () => {
  it('parses bare JSON', () => {
    expect(parseQuickJson('{"intent":"quick","preview":"hi there"}'))
      .toEqual({ intent: 'quick', preview: 'hi there' });
  });

  it('parses fenced JSON with json language tag', () => {
    const raw = '```json\n{"intent":"feature","preview":"do work"}\n```';
    expect(parseQuickJson(raw)).toEqual({ intent: 'feature', preview: 'do work' });
  });

  it('parses fenced JSON without language tag', () => {
    const raw = '```\n{"intent":"quick","preview":"yo"}\n```';
    expect(parseQuickJson(raw)).toEqual({ intent: 'quick', preview: 'yo' });
  });

  it('extracts JSON from leading prose', () => {
    const raw = 'Sure thing! {"intent":"feature","preview":"grep the auth code"} done.';
    expect(parseQuickJson(raw)).toEqual({ intent: 'feature', preview: 'grep the auth code' });
  });

  it('coerces unknown intent to "quick"', () => {
    expect(parseQuickJson('{"intent":"weird","preview":"x"}'))
      .toEqual({ intent: 'quick', preview: 'x' });
  });

  it('returns null for unparseable input', () => {
    expect(parseQuickJson('totally not json')).toBeNull();
    expect(parseQuickJson('')).toBeNull();
    expect(parseQuickJson(null)).toBeNull();
  });

  it('returns null for missing preview', () => {
    expect(parseQuickJson('{"intent":"quick"}')).toBeNull();
    expect(parseQuickJson('{"intent":"quick","preview":""}')).toBeNull();
    expect(parseQuickJson('{"intent":"quick","preview":"   "}')).toBeNull();
  });

  it('truncates a long preview to PREVIEW_MAX_CHARS', () => {
    const longText = 'a'.repeat(PREVIEW_MAX_CHARS + 50);
    const out = parseQuickJson(`{"intent":"quick","preview":"${longText}"}`);
    expect(out.preview.length).toBe(PREVIEW_MAX_CHARS);
  });
});

describe('buildQuickSystem', () => {
  it('uses English wording by default', () => {
    const sys = buildQuickSystem();
    expect(sys).toMatch(/strict JSON/);
    expect(sys).toMatch(/at most 80 chars/);
  });

  it('switches to Chinese when language is zh', () => {
    const sys = buildQuickSystem({ language: 'zh' });
    expect(sys).toMatch(/不超过 80 个字符/);
    expect(sys).toMatch(/intent 规则/);
  });

  it('honours zh-CN, zh-TW etc. (any zh* prefix)', () => {
    expect(buildQuickSystem({ language: 'zh-CN' })).toMatch(/不超过 80 个字符/);
    expect(buildQuickSystem({ language: 'zh-TW' })).toMatch(/不超过 80 个字符/);
  });

  it('embeds the VP display name', () => {
    const sys = buildQuickSystem({ vpDisplayName: 'Alice' });
    expect(sys).toMatch(/Alice/);
  });
});

describe('runQuickResponse', () => {
  const baseArgs = {
    model: 'primary/test-model',
    prompt: 'investigate the auth bug',
    language: 'en',
    vpDisplayName: 'Alice',
  };

  it('returns null when adapter is missing', async () => {
    expect(await runQuickResponse({ ...baseArgs, adapter: null })).toBeNull();
  });

  it('returns null when prompt is empty', async () => {
    const adapter = makeAdapter([[td('{"intent":"quick","preview":"x"}')]]);
    expect(await runQuickResponse({ ...baseArgs, adapter, prompt: '' })).toBeNull();
    expect(await runQuickResponse({ ...baseArgs, adapter, prompt: '   ' })).toBeNull();
  });

  it('returns null when model is missing', async () => {
    const adapter = makeAdapter([[td('{"intent":"quick","preview":"x"}')]]);
    expect(await runQuickResponse({ ...baseArgs, adapter, model: null })).toBeNull();
  });

  it('returns parsed result on a one-shot success', async () => {
    const adapter = makeAdapter([
      [td('{"intent":"feature","preview":"will grep code"}')],
    ]);
    const result = await runQuickResponse({ ...baseArgs, adapter });
    expect(result).toEqual({ intent: 'feature', preview: 'will grep code' });
    expect(adapter.calls.length).toBe(1);
  });

  it('retries once when first response is unparseable', async () => {
    const adapter = makeAdapter([
      [td('garbage prose, no JSON here')],
      [td('{"intent":"quick","preview":"second try worked"}')],
    ]);
    const result = await runQuickResponse({ ...baseArgs, adapter });
    expect(result).toEqual({ intent: 'quick', preview: 'second try worked' });
    expect(adapter.calls.length).toBe(2);
  });

  it('returns null after both attempts fail to parse', async () => {
    const adapter = makeAdapter([
      [td('not json')],
      [td('still not json')],
    ]);
    expect(await runQuickResponse({ ...baseArgs, adapter })).toBeNull();
    expect(adapter.calls.length).toBe(2);
  });

  it('does not retry on AbortError', async () => {
    // Adapter throws AbortError on first call. Second batch is present
    // to assert it is NEVER consumed.
    const adapter = {
      calls: [],
      callCount: 0,
      async *stream(args) {
        this.calls.push(args);
        this.callCount += 1;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const result = await runQuickResponse({ ...baseArgs, adapter });
    expect(result).toBeNull();
    expect(adapter.callCount).toBe(1);
  });

  it('respects an externally-aborted signal pre-call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const adapter = makeAdapter([[td('{"intent":"quick","preview":"x"}')]]);
    const result = await runQuickResponse({ ...baseArgs, adapter, signal: ctrl.signal });
    expect(result).toBeNull();
    expect(adapter.calls.length).toBe(0);
  });

  it('passes maxTokens and a (composite) signal to the adapter', async () => {
    const adapter = makeAdapter([
      [td('{"intent":"quick","preview":"x"}')],
    ]);
    await runQuickResponse({ ...baseArgs, adapter });
    const args = adapter.calls[0];
    expect(args.maxTokens).toBeTypeOf('number');
    expect(args.signal).toBeDefined();
    expect(typeof args.signal.aborted).toBe('boolean');
    expect(Array.isArray(args.messages)).toBe(true);
    expect(args.messages[0]).toEqual({ role: 'user', content: baseArgs.prompt });
  });
});
