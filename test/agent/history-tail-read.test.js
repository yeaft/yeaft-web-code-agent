// feat-chat-load-perf: regression test for loadSessionHistory tail-read.
//
// Pre-fix, loadSessionHistory(workDir, sessionId, 500) called
// `readFileSync(jsonl)` which slurped the entire ~42 MB session JSONL
// into memory and ran JSON.parse on every line (~100k calls) just to
// return the last 500 user/assistant entries. The fast path now reads
// 256 KB chunks backwards from EOF and stops as soon as `limit` rows
// have been collected.
//
// This test:
//   1. Synthesizes a ~10 MB JSONL with a known tail (smaller than a
//      real session because temp-file IO in CI is the slow part, not
//      the prod read path we're optimizing).
//   2. Asserts loadSessionHistory returns exactly the last 500
//      user/assistant rows in chronological order.
//   3. Asserts wall time stays under a generous budget (1s — pre-fix
//      this is comfortably over 1s for a 10 MB file in CI).
//
// We use a real temp directory under ~/.claude/projects/<folder>/ so
// the production path-derivation logic (pathToProjectFolder) sees the
// same folder name the agent does. The file is cleaned up in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  loadSessionHistory,
  pathToProjectFolder,
  _TAIL_CHUNK_SIZE_FOR_TESTS,
} from '../../agent/history.js';

const TEST_WORK_DIR = '/tmp/feat-chat-load-perf-test-workdir';
const TEST_SESSION_ID = 'feat-chat-load-perf-tail-read-session';
const UTF8_BOUNDARY_SESSION_ID = 'feat-chat-load-perf-utf8-boundary-session';

let projectFolderPath;
let sessionFilePath;
const cleanupPaths = [];

beforeAll(() => {
  const folder = pathToProjectFolder(TEST_WORK_DIR);
  projectFolderPath = join(homedir(), '.claude', 'projects', folder);
  sessionFilePath = join(projectFolderPath, `${TEST_SESSION_ID}.jsonl`);
  cleanupPaths.push(sessionFilePath);

  if (!existsSync(projectFolderPath)) {
    mkdirSync(projectFolderPath, { recursive: true });
  }

  // Build a synthetic JSONL. Each line is a valid JSON message; padding
  // grows the file to ~10 MB so the tail-read path actually has to skip
  // chunks before reaching the limit.
  // Layout: 50 leading 'system' (non-counted) entries with ~1 KB padding
  // each so we can prove they get skipped, then 10000 user/assistant
  // alternating entries (the last 500 of which are what we'll assert).
  const lines = [];
  const padding = 'x'.repeat(900); // ~1 KB filler per line

  for (let i = 0; i < 50; i++) {
    lines.push(JSON.stringify({
      type: 'summary', // not 'user' or 'assistant' — should be ignored
      summary: `early summary ${i}`,
      padding
    }));
  }
  for (let i = 0; i < 10_000; i++) {
    const type = i % 2 === 0 ? 'user' : 'assistant';
    if (type === 'user') {
      lines.push(JSON.stringify({
        type: 'user',
        message: { content: `u${i}` },
        timestamp: new Date(1_700_000_000_000 + i).toISOString(),
        padding
      }));
    } else {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `a${i}` }] },
        timestamp: new Date(1_700_000_000_000 + i).toISOString(),
        padding
      }));
    }
  }
  writeFileSync(sessionFilePath, lines.join('\n') + '\n');
});

afterAll(() => {
  for (const p of cleanupPaths) {
    try { rmSync(p); } catch {}
  }
});

describe('feat-chat-load-perf: loadSessionHistory tail-read', () => {
  it('returns exactly the last 500 user/assistant rows in chronological order', () => {
    const messages = loadSessionHistory(TEST_WORK_DIR, TEST_SESSION_ID, 500);
    expect(messages.length).toBe(500);

    // Tail of a 10000-message run with the LAST 500 entries = indices
    // 9500..9999 in our synthesized stream. The 9500th entry is
    // assistant (9500 is even... wait: i%2==0 -> user, so i=9500 is
    // user). Let's just check the boundary values.
    const first = messages[0];
    const last = messages[messages.length - 1];

    expect(first.type).toBe('user');
    expect(first.message.content).toBe('u9500');
    expect(last.type).toBe('assistant');
    expect(last.message.content[0].text).toBe('a9999');

    // None of the leading 'summary' rows should leak in.
    for (const m of messages) {
      expect(['user', 'assistant']).toContain(m.type);
    }
  });

  it('completes within 1 second for a ~10 MB JSONL', () => {
    const start = Date.now();
    const messages = loadSessionHistory(TEST_WORK_DIR, TEST_SESSION_ID, 500);
    const elapsed = Date.now() - start;
    expect(messages.length).toBe(500);
    // Budget is generous so it passes on slow CI runners but still
    // catches a regression back to "read the whole file".
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns empty array when session file is missing', () => {
    const result = loadSessionHistory(TEST_WORK_DIR, 'nonexistent-session-xyz', 500);
    expect(result).toEqual([]);
  });

  it('handles limit larger than available rows by returning all rows', () => {
    // We have 10000 user/assistant rows; asking for 20000 should return
    // all 10000.
    const all = loadSessionHistory(TEST_WORK_DIR, TEST_SESSION_ID, 20_000);
    expect(all.length).toBe(10_000);
    expect(all[0].type).toBe('user');
    expect(all[0].message.content).toBe('u0');
    expect(all[all.length - 1].message.content[0].text).toBe('a9999');
  });
});

// feat-chat-load-perf: UTF-8 boundary regression test for readTailMessages.
//
// The pre-fix tail-reader did `chunk.toString('utf-8')` per chunk and
// concatenated those strings, which substitutes U+FFFD for any multi-byte
// character split across a chunk boundary. JSON.parse happily accepts
// U+FFFD as valid string content, so corruption was silent — the LLM
// got fed mangled prior turns and there was no signal upstream.
//
// This test constructs a JSONL where a 3-byte Chinese character (前 =
// E5 89 8D) lands exactly across the TAIL_CHUNK_SIZE byte boundary
// (measured from EOF). With the byte-level carry, the round-tripped
// content must be the exact string '前面有汉字' with NO replacement
// characters. With the buggy string-level carry, the first byte of 前
// would survive as U+FFFD and the assertion would fail.

import { Buffer } from 'buffer';

const UTF8_TEST_WORK_DIR = '/tmp/feat-chat-load-perf-utf8-test-workdir';
let utf8ProjectFolderPath;
let utf8SessionFilePath;
const utf8CleanupPaths = [];

describe('feat-chat-load-perf: UTF-8 byte-boundary safety', () => {
  beforeAll(() => {
    const folder = pathToProjectFolder(UTF8_TEST_WORK_DIR);
    utf8ProjectFolderPath = join(homedir(), '.claude', 'projects', folder);
    utf8SessionFilePath = join(utf8ProjectFolderPath, `${UTF8_BOUNDARY_SESSION_ID}.jsonl`);
    utf8CleanupPaths.push(utf8SessionFilePath);

    if (!existsSync(utf8ProjectFolderPath)) {
      mkdirSync(utf8ProjectFolderPath, { recursive: true });
    }

    // Reader walks backwards in TAIL_CHUNK_SIZE chunks. With file size
    // exactly 2 * TAIL_CHUNK_SIZE:
    //   - first iteration reads bytes [TAIL_CHUNK_SIZE, 2*TAIL_CHUNK_SIZE)
    //   - second iteration reads bytes [0, TAIL_CHUNK_SIZE)
    // The seam is at file-offset TAIL_CHUNK_SIZE. To split a 3-byte
    // character (前 = E5 89 8D) across it, byte E5 lands at offset
    // TAIL_CHUNK_SIZE - 1 (last byte of the head chunk), byte 89 at
    // offset TAIL_CHUNK_SIZE (first byte of the EOF chunk), byte 8D at
    // offset TAIL_CHUNK_SIZE + 1.
    //
    // Layout (file bytes):
    //   [0 .. seam-1]       prefix padding line ('A' filler + JSON wrapper),
    //                       followed by the start of the Chinese-content line
    //                       — pad so that the E5 byte of 前 lands at offset
    //                       TAIL_CHUNK_SIZE - 1.
    //   [seam .. seam+1]    bytes 89 8D of 前 (start of EOF chunk).
    //   [seam+2 .. EOF]     rest of Chinese line + 50 ASCII tail rows.
    const CHUNK = _TAIL_CHUNK_SIZE_FOR_TESTS;
    const SEAM_BYTE = CHUNK; // first byte of the EOF chunk

    const chineseLine = JSON.stringify({
      type: 'user',
      message: { content: '前面有汉字' },
      timestamp: new Date(1_700_000_000_000).toISOString(),
    });
    const chineseLineBytes = Buffer.from(chineseLine, 'utf-8');
    // Locate the first E5 byte (start of 前) within the encoded line.
    let qianStartInLine = -1;
    for (let i = 0; i < chineseLineBytes.length - 2; i++) {
      if (chineseLineBytes[i] === 0xe5 && chineseLineBytes[i + 1] === 0x89 && chineseLineBytes[i + 2] === 0x8d) {
        qianStartInLine = i;
        break;
      }
    }
    if (qianStartInLine === -1) {
      throw new Error('test setup: 前 not found in encoded JSON — JSON.stringify may have changed escaping');
    }

    // We want file-offset(E5) = SEAM_BYTE - 1
    //   => prefixPaddingBytes + qianStartInLine = SEAM_BYTE - 1
    //   => prefixPaddingBytes = SEAM_BYTE - 1 - qianStartInLine
    const prefixPaddingBytes = SEAM_BYTE - 1 - qianStartInLine;
    if (prefixPaddingBytes < 0) {
      throw new Error(`test setup: SEAM_BYTE ${SEAM_BYTE} too small for qianStartInLine ${qianStartInLine}`);
    }
    // Prefix padding lives on its own JSON line (a 'summary' that the
    // tail-reader will skip) so the JSONL stays parseable. We size the
    // ASCII filler so total prefix line bytes == prefixPaddingBytes.
    const prefixWrapperPrefix = `{"type":"summary","summary":"`;
    const prefixWrapperSuffix = `"}\n`;
    const fillerBytesNeeded = prefixPaddingBytes
      - Buffer.byteLength(prefixWrapperPrefix, 'utf-8')
      - Buffer.byteLength(prefixWrapperSuffix, 'utf-8');
    if (fillerBytesNeeded < 0) {
      throw new Error(`test setup: chunk boundary cannot accommodate prefix wrapper`);
    }
    const prefixFiller = 'A'.repeat(fillerBytesNeeded);
    const prefixLine = `${prefixWrapperPrefix}${prefixFiller}${prefixWrapperSuffix}`;
    if (Buffer.byteLength(prefixLine, 'utf-8') !== prefixPaddingBytes) {
      throw new Error(`test setup: prefixLine byte length mismatch`);
    }

    // Tail fill: enough rows after the Chinese line to push the file
    // size past 2 * CHUNK so two reverse chunks actually get read.
    // Each row is ~80 bytes, so 4000 rows ≈ 320 KB > one CHUNK.
    const tailLines = [];
    for (let i = 0; i < 4000; i++) {
      tailLines.push(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `tail-${i}` }] },
        timestamp: new Date(1_700_000_000_001 + i).toISOString(),
      }));
    }

    // Concatenate: prefix (head padding) + Chinese line + \n + tail.
    const body = prefixLine + chineseLine + '\n' + tailLines.join('\n') + '\n';
    writeFileSync(utf8SessionFilePath, body);

    // Sanity: file size > 2*CHUNK so two reverse chunks fire; E5 lands
    // at SEAM_BYTE-1. If math is off, test is silently useless.
    const fileBytes = Buffer.from(body, 'utf-8');
    if (fileBytes.length <= 2 * CHUNK) {
      throw new Error(`test setup: file size ${fileBytes.length} ≤ 2*CHUNK ${2 * CHUNK} — boundary not crossed`);
    }
    const e5At = SEAM_BYTE - 1;
    if (!(fileBytes[e5At] === 0xe5 && fileBytes[e5At + 1] === 0x89 && fileBytes[e5At + 2] === 0x8d)) {
      throw new Error(`test setup: 前 bytes not at file offset ${e5At}; got ${fileBytes[e5At].toString(16)} ${fileBytes[e5At + 1].toString(16)} ${fileBytes[e5At + 2].toString(16)}`);
    }
  });

  afterAll(() => {
    for (const p of utf8CleanupPaths) {
      try { rmSync(p); } catch {}
    }
  });

  it('round-trips a multi-byte UTF-8 character split across the chunk boundary', () => {
    // Pull every user/assistant row so the Chinese line (the OLDEST) is
    // guaranteed to be in the result regardless of how many tail rows
    // sit between it and EOF. The bug we're guarding against fires the
    // same way whether the boundary line is row 1 or row 1000 — what
    // matters is that the chunk boundary cuts the multi-byte char.
    const messages = loadSessionHistory(UTF8_TEST_WORK_DIR, UTF8_BOUNDARY_SESSION_ID, 100_000);
    const userMessages = messages.filter(m => m.type === 'user');
    expect(userMessages.length).toBe(1);
    const got = userMessages[0].message.content;
    expect(got).toBe('前面有汉字');
    // Defense in depth: must not contain U+FFFD even if length matches
    // accidentally.
    expect(got).not.toMatch(/�/);
  });
});
