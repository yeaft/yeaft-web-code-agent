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
import { loadSessionHistory, pathToProjectFolder } from '../../agent/history.js';

const TEST_WORK_DIR = '/tmp/feat-chat-load-perf-test-workdir';
const TEST_SESSION_ID = 'feat-chat-load-perf-tail-read-session';

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
