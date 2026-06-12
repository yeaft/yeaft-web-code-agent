import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildRunDreamOpts } from '../../../../agent/yeaft/dream/session-wiring.js';
import { runDream } from '../../../../agent/yeaft/dream/runner.js';

let testDir;

beforeEach(() => {
  testDir = join(tmpdir(), `yeaft-dream-session-wiring-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('buildRunDreamOpts session conversation wiring', () => {
  it('enumerates and reads the live legacy groups conversation layout', async () => {
    writeSessionMessage(testDir, 's-live', 'm0001', 'user', 'remember that I prefer small patches');
    writeSessionMessage(testDir, 's-live', 'm0002', 'assistant', 'noted, I will keep patches small', { speakerVpId: 'vp-linus' });
    writeSessionMessage(testDir, 's-empty', 'm0001', 'user', 'this one is removed');
    rmSync(join(testDir, 'groups', 's-empty', 'conversation', 'messages', 'm0001.md'));
    mkdirSync(join(testDir, 'sessions', 's-old', 'messages'), { recursive: true });
    writeFileSync(join(testDir, 'sessions', 's-old', 'session.json'), '{"id":"s-old"}\n');

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.listSessions()).resolves.toEqual(['s-live']);
    await expect(opts.countMessages('s-live')).resolves.toBe(2);
    await expect(opts.loadGroupDiff('s-live', 'm0001')).resolves.toEqual([
      { id: 'm0002', role: 'assistant', body: 'noted, I will keep patches small', vpId: 'vp-linus' },
    ]);
    await expect(opts.loadOverlapPreamble('s-live', 'm0002', 1)).resolves.toEqual([
      { id: 'm0001', role: 'user', body: 'remember that I prefer small patches' },
    ]);
  });

  it('lets runDream process sessions from groups conversation messages instead of empty-running', async () => {
    writeSessionMessage(testDir, 's-live', 'm0001', 'user', 'remember that I prefer concise answers');
    writeSessionMessage(testDir, 's-live', 'm0002', 'assistant', 'I will keep the answer concise', { speakerVpId: 'vp-linus' });

    const opts = buildRunDreamOpts(fakeSession(testDir));
    const events = [];
    const result = await runDream({
      ...opts,
      manual: true,
      llm: fakeDreamLlm,
      onProgress: event => events.push(event),
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: 's-live', status: 'triaged' }),
    ]);
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.targets.every(t => t.status === 'done')).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ phase: 'done', sessions: 1 }));
  });
});

function fakeSession(yeaftDir) {
  return {
    yeaftDir,
    config: { language: 'en' },
    adapter: {
      stream: async () => ({ text: '{}', usage: {} }),
    },
  };
}

async function fakeDreamLlm(req) {
  if (String(req.pass).startsWith('triage')) return '{}';
  return JSON.stringify({
    memory_md: '# Memory\n\n- Dream processed the session conversation.\n',
    summary_md: 'Dream processed the session conversation.',
  });
}

function writeSessionMessage(root, sessionId, id, role, content, extra = {}) {
  const dir = join(root, 'groups', sessionId, 'conversation', 'messages');
  mkdirSync(dir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${id}`,
    `role: ${role}`,
    `time: 2026-06-12T00:00:00.000Z`,
    `sessionId: ${sessionId}`,
    ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
    '---',
  ].join('\n');
  writeFileSync(join(dir, `${id}.md`), `${frontmatter}\n${content}\n`);
}
