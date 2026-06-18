/**
 * Unit tests for the LLM retry helpers in agent/yeaft/llm/adapter.js and
 * the backoff math in agent/yeaft/engine.js.
 *
 * These run in milliseconds — they don't talk to a network or build a real
 * Engine; they're guard-rails on the math + parsing so adapter
 * regressions show up here instead of in flaky end-to-end tests.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRetryAfterMs,
  retryAfterFromResponse,
  classifyFetchError,
  readStreamChunkWithIdleTimeout,
  LLMRateLimitError,
  LLMServerError,
  LLMAuthError,
  LLMContextError,
  LLMAbortError,
  LLMStreamIdleTimeoutError,
} from '../../../agent/yeaft/llm/adapter.js';
import { computeBackoffDelay } from '../../../agent/yeaft/engine.js';
import { normalizeLlmRetry } from '../../../agent/yeaft/config.js';

describe('parseRetryAfterMs', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses fractional seconds', () => {
    expect(parseRetryAfterMs('1.5')).toBe(1_500);
  });

  it('parses HTTP-date in the future', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5_000);
  });

  it('returns null for past HTTP-date', () => {
    const past = new Date(Date.now() - 5_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });
});

describe('retryAfterFromResponse', () => {
  it('reads from Headers instance', () => {
    const headers = new Headers({ 'retry-after': '12' });
    expect(retryAfterFromResponse({ headers })).toBe(12_000);
  });

  it('reads from plain object case-insensitively', () => {
    expect(retryAfterFromResponse({ headers: { 'Retry-After': '7' } })).toBe(7_000);
    expect(retryAfterFromResponse({ headers: { RETRY_AFTER: '5' } })).toBeNull(); // wrong key
  });

  it('returns null when missing', () => {
    expect(retryAfterFromResponse({ headers: {} })).toBeNull();
    expect(retryAfterFromResponse(null)).toBeNull();
    expect(retryAfterFromResponse({})).toBeNull();
  });
});

describe('classifyFetchError', () => {
  it('passes through abort errors', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const out = classifyFetchError(err);
    expect(out).toBeInstanceOf(LLMAbortError);
  });

  it('wraps known transient error codes as LLMServerError', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET']) {
      const err = new Error(`network ${code}`);
      err.code = code;
      const out = classifyFetchError(err, { providerLabel: 'TestProvider' });
      expect(out).toBeInstanceOf(LLMServerError);
      expect(out.statusCode).toBe(0);
      expect(out.message).toContain('TestProvider');
      expect(out.message).toContain(code);
    }
  });

  it('reads cause.code from Node fetch wrapper', () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    const out = classifyFetchError(err);
    expect(out).toBeInstanceOf(LLMServerError);
  });

  it('wraps generic TypeError fetch failures as LLMServerError', () => {
    const err = new TypeError('fetch failed: socket hang up');
    const out = classifyFetchError(err);
    expect(out).toBeInstanceOf(LLMServerError);
  });

  it('keeps already-classified errors as-is', () => {
    const rate = new LLMRateLimitError('slow', 429, 1000);
    expect(classifyFetchError(rate)).toBe(rate);
    const ctx = new LLMContextError('too long');
    expect(classifyFetchError(ctx)).toBe(ctx);
    const auth = new LLMAuthError('nope', 401);
    expect(classifyFetchError(auth)).toBe(auth);
    const idle = new LLMStreamIdleTimeoutError('idle', 120_000);
    expect(classifyFetchError(idle)).toBe(idle);
  });

  it('returns unknown errors unchanged', () => {
    const err = new Error('some weird thing');
    expect(classifyFetchError(err)).toBe(err);
  });
});

describe('readStreamChunkWithIdleTimeout', () => {
  it('returns stream chunks before the idle deadline', async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const reader = {
      read: async () => ({ done: false, value: chunk }),
      cancel: async () => {},
    };
    await expect(readStreamChunkWithIdleTimeout(reader, { idleMs: 50, providerLabel: 'Test' }))
      .resolves.toEqual({ done: false, value: chunk });
  });

  it('throws retryable idle timeout and cancels the reader when no chunk arrives', async () => {
    let cancelled = false;
    const reader = {
      read: () => new Promise(() => {}),
      cancel: async () => { cancelled = true; },
    };
    let caught;
    try {
      await readStreamChunkWithIdleTimeout(reader, { idleMs: 5, providerLabel: 'Test' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(caught).toBeInstanceOf(LLMServerError);
    expect(caught.idleMs).toBe(5);
    expect(caught.message).toContain('Test stream idle timeout');
    expect(cancelled).toBe(true);
  });

  it('throws abort error when caller signal aborts before a chunk arrives', async () => {
    const ctrl = new AbortController();
    const reader = {
      read: () => new Promise(() => {}),
      cancel: async () => {},
    };
    const pending = readStreamChunkWithIdleTimeout(reader, { idleMs: 1_000, signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortError);
  });
});

describe('computeBackoffDelay', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 };

  it('grows exponentially with attempt index', () => {
    expect(computeBackoffDelay(policy, 0)).toBe(100);
    expect(computeBackoffDelay(policy, 1)).toBe(200);
    expect(computeBackoffDelay(policy, 2)).toBe(400);
    expect(computeBackoffDelay(policy, 3)).toBe(800);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffDelay(policy, 20)).toBe(10_000);
  });

  it('applies jitter within bounds', () => {
    const jittered = { ...policy, jitterRatio: 0.5 };
    for (let i = 0; i < 50; i += 1) {
      const v = computeBackoffDelay(jittered, 1); // base*2 = 200, ±100
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(300);
    }
  });

  it('treats negative attempts as 0', () => {
    expect(computeBackoffDelay(policy, -5)).toBe(100);
  });
});

describe('normalizeLlmRetry', () => {
  it('returns defaults when nothing is provided', () => {
    const out = normalizeLlmRetry(null, null);
    expect(out.maxRetries).toBe(3);
    expect(out.baseDelayMs).toBe(1_000);
    expect(out.maxDelayMs).toBe(30_000);
    expect(out.jitterRatio).toBe(0.25);
  });

  it('merges fileConfig and override (override wins)', () => {
    const out = normalizeLlmRetry({ maxRetries: 1 }, { maxRetries: 7, baseDelayMs: 500 });
    expect(out.maxRetries).toBe(7);
    expect(out.baseDelayMs).toBe(500);
    expect(out.maxDelayMs).toBe(30_000); // default
  });

  it('clamps absurd values into safe ranges', () => {
    const out = normalizeLlmRetry({
      maxRetries: 9999,
      baseDelayMs: 9_999_999,
      maxDelayMs: 9_999_999,
      jitterRatio: 5,
    }, null);
    expect(out.maxRetries).toBeLessThanOrEqual(20);
    expect(out.baseDelayMs).toBeLessThanOrEqual(60_000);
    expect(out.maxDelayMs).toBeLessThanOrEqual(600_000);
    expect(out.jitterRatio).toBeLessThanOrEqual(1);
  });

  it('forces maxDelayMs >= baseDelayMs', () => {
    const out = normalizeLlmRetry({ baseDelayMs: 5_000, maxDelayMs: 100 }, null);
    expect(out.maxDelayMs).toBeGreaterThanOrEqual(out.baseDelayMs);
  });

  it('ignores negative / NaN inputs and keeps prior values', () => {
    const out = normalizeLlmRetry({ maxRetries: -1, baseDelayMs: NaN }, null);
    expect(out.maxRetries).toBe(3);
    expect(out.baseDelayMs).toBe(1_000);
  });
});
