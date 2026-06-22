/**
 * Unit tests for SseLineBuffer — the incremental O(n) SSE line splitter that
 * replaced the per-adapter `buffer += chunk; buffer.split('\n')` pattern.
 *
 * Why this exists: the old pattern was O(n²) on a long un-terminated line
 * (`string += chunk` reallocates the whole growing tail every chunk). On a
 * malfunctioning gateway that emitted a multi-MiB newline-less run, that froze
 * the event loop for tens of seconds — long enough to starve the WS heartbeat
 * `setInterval` and the `ws.on('pong')` handler, after which the agent saw
 * "No pong" and terminated its own healthy connection. These tests pin both
 * the correctness (must behave exactly like split('\n')) and the performance
 * (must stay linear) so the bug can't silently regress.
 */
import { describe, expect, it } from 'vitest';
import { SseLineBuffer, DEFAULT_SSE_MAX_LINE_BYTES, LLMServerError } from '../../../agent/yeaft/llm/adapter.js';

/** Drive a buffer with a list of chunks, collecting all emitted lines. */
function feed(chunks, opts) {
  const buf = new SseLineBuffer(opts);
  const lines = [];
  for (const c of chunks) lines.push(...buf.push(c));
  return { lines, pending: buf.pending };
}

/**
 * Reference: how the OLD code split a fully-received stream. The buffer's
 * emitted lines + final `pending` must reconstruct exactly this.
 */
function referenceSplit(full) {
  const parts = full.split('\n');
  const pending = parts.pop(); // trailing partial (old code's leftover buffer)
  return { lines: parts, pending };
}

describe('SseLineBuffer — correctness', () => {
  it('splits simple newline-delimited lines, buffering the trailing partial', () => {
    const { lines, pending } = feed(['a\nb\nc']);
    expect(lines).toEqual(['a', 'b']);
    expect(pending).toBe('c');
  });

  it('reassembles a line split across many chunks', () => {
    const { lines, pending } = feed(['he', 'll', 'o wor', 'ld\n', 'next']);
    expect(lines).toEqual(['hello world']);
    expect(pending).toBe('next');
  });

  it('emits empty strings for blank lines (SSE event separators)', () => {
    const { lines } = feed(['data: x\n', '\n', 'data: y\n']);
    expect(lines).toEqual(['data: x', '', 'data: y']);
  });

  it('handles a chunk that is exactly one newline', () => {
    const { lines, pending } = feed(['a', '\n', 'b']);
    expect(lines).toEqual(['a']);
    expect(pending).toBe('b');
  });

  it('handles multiple newlines in a single chunk', () => {
    const { lines, pending } = feed(['a\nb\nc\n']);
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(pending).toBe('');
  });

  it('preserves \\r (CRLF stays as trailing \\r, matching split("\\n"))', () => {
    const { lines } = feed(['data: x\r\ndata: y\r\n']);
    expect(lines).toEqual(['data: x\r', 'data: y\r']);
  });

  it('ignores empty chunks', () => {
    const { lines, pending } = feed(['a', '', 'b\n', '']);
    expect(lines).toEqual(['ab']);
    expect(pending).toBe('');
  });
});

describe('SseLineBuffer — equivalence with split("\\n")', () => {
  // The buffer must be a drop-in replacement for the old code. For arbitrary
  // chunkings of arbitrary payloads, emitted lines + pending must match
  // exactly what `full.split('\n')` (pop the partial) produced.
  const payloads = [
    'data: {"a":1}\n\ndata: {"b":2}\n',
    'no-newline-at-all',
    '\n\n\n',
    'trailing\npartial',
    'data: [DONE]\n',
    '',
  ];
  // Deterministic chunkings (no RNG — repo bans Math.random in some contexts,
  // and fixed splits make failures reproducible).
  const chunkSizes = [1, 2, 3, 5, 7, 1000];

  for (const payload of payloads) {
    for (const size of chunkSizes) {
      it(`payload ${JSON.stringify(payload).slice(0, 24)} @chunk=${size}`, () => {
        const chunks = [];
        for (let i = 0; i < payload.length; i += size) chunks.push(payload.slice(i, i + size));
        const got = feed(chunks);
        const want = referenceSplit(payload);
        expect(got.lines).toEqual(want.lines);
        expect(got.pending).toBe(want.pending);
      });
    }
  }
});

describe('SseLineBuffer — performance (regression guard for the heartbeat freeze)', () => {
  it('stays linear on a multi-MiB un-terminated line (old code: ~35s at 40MiB)', () => {
    // 40 MiB delivered as 16 KiB chunks with NO newline — the exact shape that
    // froze the event loop. O(n²) would be tens of seconds; O(n) is a few ms.
    // Assert a generous ceiling (2s) so the test is robust on slow CI but still
    // fails hard if the O(n²) `+=`/split pattern ever comes back.
    const chunk = 'x'.repeat(16 * 1024);
    const nChunks = (40 * 1024 * 1024) / chunk.length;
    const buf = new SseLineBuffer({ maxLineBytes: 1024 * 1024 * 1024 });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < nChunks; i++) buf.push(chunk);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(elapsedMs).toBeLessThan(2000);
    // The whole thing is still one un-terminated line:
    expect(buf.pending.length).toBe(40 * 1024 * 1024);
  });
});

describe('SseLineBuffer — malformed-stream cap', () => {
  it('throws a retryable LLMServerError when an un-terminated line exceeds the cap', () => {
    const buf = new SseLineBuffer({ maxLineBytes: 1024 });
    let thrown = null;
    try {
      // 2 KiB with no newline > 1 KiB cap.
      for (let i = 0; i < 4; i++) buf.push('y'.repeat(512));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LLMServerError);
    // engine.js retries on `instanceof LLMServerError`, so the class itself is
    // the retryable contract — no separate `.retryable` flag on the throw path.
    expect(thrown.message).toMatch(/exceeded .* bytes without a newline/);
  });

  it('does NOT throw when newlines keep the live line under the cap', () => {
    const buf = new SseLineBuffer({ maxLineBytes: 1024 });
    // Each line is small; total bytes >> cap but no single line exceeds it.
    expect(() => {
      for (let i = 0; i < 100; i++) buf.push('z'.repeat(500) + '\n');
    }).not.toThrow();
  });

  it('defaults to a large but finite cap', () => {
    expect(DEFAULT_SSE_MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });
});
