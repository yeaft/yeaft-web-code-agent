/**
 * session-stats-dir-mkdir.test.js — pins the eager-mkdir behaviour
 * added to `loadSession` for the stats directory.
 *
 * Before this fix, `<yeaftDir>/stats/` was created lazily by the
 * `ToolUsageStats` flush path. In group chat (where only per-VP engines
 * run, never the session-level engine before v0.1.779), no flush ever
 * fired and the directory simply never appeared on disk — which the
 * user reported as "都没有 stats 这个 folder". The fix eagerly
 * `mkdirSync(.., {recursive: true})` at session boot and warns to the
 * console if the parent isn't writable.
 *
 * This test calls loadSession against a temp dir and asserts that
 * `stats/` exists immediately after the call returns, BEFORE any tool
 * has executed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadSession } from '../../../agent/yeaft/session.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-stats-mkdir-'));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('loadSession — eager stats/ mkdir', () => {
  it('creates <yeaftDir>/stats at boot, before any tool runs', async () => {
    const statsDir = join(dir, 'stats');
    expect(existsSync(statsDir)).toBe(false);
    // skipMCP/skipSkills keep the test cheap; we only care about the
    // mkdir side effect, not the live MCP/skills boot.
    const session = await loadSession({ dir, skipMCP: true, skipSkills: true });
    try {
      expect(existsSync(statsDir)).toBe(true);
      expect(statSync(statsDir).isDirectory()).toBe(true);
      expect(session.toolStats).toBeTruthy();
    } finally {
      if (session?.dispose) await session.dispose();
    }
  });
});
