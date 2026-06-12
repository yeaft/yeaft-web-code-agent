import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runDream } from '../../../../agent/yeaft/dream/runner.js';

let testDir;

beforeEach(() => {
  testDir = join(tmpdir(), `yeaft-dream-apply-error-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('Dream apply diagnostics', () => {
  it('records a raw response snippet when apply JSON parsing fails', async () => {
    await runDream({
      root: testDir,
      manual: true,
      listSessions: async () => ['s-live'],
      countMessages: async () => 1,
      loadGroupDiff: async () => [{ id: 'm0001', role: 'user', body: 'remember malformed output diagnostics' }],
      llm: async req => {
        if (String(req.pass).startsWith('triage')) return '{}';
        return 'not json: provider returned prose instead of the requested object';
      },
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    const raw = readFileSync(join(testDir, 'sessions', 's-live', '.dream-last-error.json'), 'utf8');
    const err = JSON.parse(raw);
    expect(err.phase).toBe('apply');
    expect(err.message).toContain('malformed JSON');
    expect(err.rawSnippet).toBe('not json: provider returned prose instead of the requested object');
  });
});
