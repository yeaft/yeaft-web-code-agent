import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildRunDreamOpts } from '../../../../agent/yeaft/dream/session-wiring.js';
import { runDream } from '../../../../agent/yeaft/dream/runner.js';
import { extractAndWriteMemorySegments } from '../../../../agent/yeaft/dream/segment-extract.js';

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
  it('enumerates and reads the live sessions conversation layout', async () => {
    writeSessionMessage(testDir, 's-live', 'm0001', 'user', 'remember that I prefer small patches');
    writeSessionMessage(testDir, 's-live', 'm0002', 'assistant', 'noted, I will keep patches small', { speakerVpId: 'vp-linus' });
    writeSessionMessage(testDir, 's-empty', 'm0001', 'user', 'this one is removed');
    rmSync(join(testDir, 'sessions', 's-empty', 'conversation', 'messages', 'm0001.md'));
    mkdirSync(join(testDir, 'groups', 's-old', 'messages'), { recursive: true });
    writeFileSync(join(testDir, 'groups', 's-old', 'group.json'), '{"id":"s-old"}\n');

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.listSessions()).resolves.toEqual(['s-live']);
    await expect(opts.countMessages('s-live')).resolves.toBe(2);
    await expect(opts.loadSessionDiff('s-live', 'm0001')).resolves.toEqual([
      { id: 'm0002', role: 'assistant', body: 'noted, I will keep patches small', vpId: 'vp-linus' },
    ]);
    await expect(opts.loadOverlapPreamble('s-live', 'm0002', 1)).resolves.toEqual([
      { id: 'm0001', role: 'user', body: 'remember that I prefer small patches' },
    ]);
  });

  it('reads cold and hot messages as one ordered transcript', async () => {
    writeSessionMessage(testDir, 's-live', 'm0001', 'user', 'old cursor message', {}, 'cold');
    writeSessionMessage(testDir, 's-live', 'm0002', 'assistant', 'old assistant response', { speakerVpId: 'vp-linus' }, 'cold');
    writeSessionMessage(testDir, 's-live', 'm0003', 'user', 'new hot message');

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.countMessages('s-live')).resolves.toBe(3);
    await expect(opts.loadGroupDiff('s-live', 'm0002')).resolves.toEqual([
      { id: 'm0003', role: 'user', body: 'new hot message' },
    ]);
    await expect(opts.loadOverlapPreamble('s-live', 'm0003', 2)).resolves.toEqual([
      { id: 'm0001', role: 'user', body: 'old cursor message' },
      { id: 'm0002', role: 'assistant', body: 'old assistant response', vpId: 'vp-linus' },
    ]);
  });

  it('falls back to legacy groups conversation layout for old data', async () => {
    writeSessionMessage(testDir, 's-legacy', 'm0001', 'user', 'legacy data', {}, 'messages', 'groups');

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.listSessions()).resolves.toEqual(['s-legacy']);
    await expect(opts.countMessages('s-legacy')).resolves.toBe(1);
    await expect(opts.loadGroupDiff('s-legacy', null)).resolves.toEqual([
      { id: 'm0001', role: 'user', body: 'legacy data' },
    ]);
  });

  it('lets runDream process sessions from session conversation messages instead of empty-running', async () => {
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
    expect(result.memorySegments).toEqual([
      expect.objectContaining({ sessionId: 's-live', status: 'done', segments: expect.any(Number) }),
    ]);
    const sessionMemory = readFileSync(join(testDir, 'memory', 'sessions', 's-live', 'memory.md'), 'utf8');
    expect(sessionMemory).toContain('kind: decision');
    expect(sessionMemory).toContain('Dream processed the session conversation');
    expect(sessionMemory).toContain('tags: [recent, current]');
    expect(events).toContainEqual(expect.objectContaining({ phase: 'done', sessions: 1 }));
  });

  it('writes session-vp and topic segment memory for multiple VPs', async () => {
    writeSessionMessage(testDir, 's-vps', 'm0001', 'user', 'Omni should coordinate and Martin should review the Dream segment PR. Topic is active_scope rendering.');
    writeSessionMessage(testDir, 's-vps', 'm0002', 'assistant', 'Omni will coordinate the PR and keep session terminology.', { speakerVpId: 'omni' });
    writeSessionMessage(testDir, 's-vps', 'm0003', 'assistant', 'Martin will review active_scope and Dream segment behavior.', { speakerVpId: 'martin' });

    const result = await runDream({
      ...buildRunDreamOpts(fakeSession(testDir)),
      manual: true,
      llm: fakeDreamLlm,
      limits: { MIN_NEW_PER_GROUP: 1 },
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result.memorySegments[0]).toEqual(expect.objectContaining({ status: 'done' }));
    const omniMemory = readFileSync(join(testDir, 'memory', 'sessions', 's-vps', 'vp', 'omni', 'memory.md'), 'utf8');
    const martinMemory = readFileSync(join(testDir, 'memory', 'sessions', 's-vps', 'vp', 'martin', 'memory.md'), 'utf8');
    const topicMemory = readFileSync(join(testDir, 'memory', 'sessions', 's-vps', 'topic', 'active_scope', 'rendering', 'memory.md'), 'utf8');
    expect(omniMemory).toContain('Dream processed the session conversation');
    expect(martinMemory).toContain('Dream processed the session conversation');
    expect(topicMemory).toContain('Dream processed the session conversation');
  });

  it('isolates malformed segment extraction to one scope and continues others', async () => {
    const calls = [];
    const llm = async (req) => {
      if (req.pass === 'extract-segments') {
        calls.push(req.prompt.match(/Target scope: ([^\n]+)/)?.[1] || '');
        if (req.prompt.includes('Target scope: user\n')) return '{ malformed';
        return JSON.stringify([{ kind: 'decision', tags: ['review'], sourceMessages: ['m1'], body: 'Other scopes still write memory after one scope fails.' }]);
      }
      if (req.pass === 'extract-segments-retry') return 'still malformed';
      return '[]';
    };

    const result = await extractAndWriteMemorySegments({
      root: join(testDir, 'memory'),
      sessionId: 's-isolate',
      messages: [{ id: 'm1', role: 'user', body: 'Keep session and VP memory even if user extraction fails.' }],
      targets: ['user', 'sessions/s-isolate', 'sessions/s-isolate/user', 'sessions/s-isolate/topic/review'],
      llm,
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result.errors).toEqual([expect.objectContaining({ scope: 'user', rawSnippet: expect.any(String) })]);
    expect(calls).toContain('user');
    expect(readFileSync(join(testDir, 'memory', 'sessions', 's-isolate', 'memory.md'), 'utf8')).toContain('Other scopes still write memory');
    expect(readFileSync(join(testDir, 'memory', 'sessions', 's-isolate', 'user', 'memory.md'), 'utf8')).toContain('Other scopes still write memory');
    expect(readFileSync(join(testDir, 'memory', 'sessions', 's-isolate', 'topic', 'review', 'memory.md'), 'utf8')).toContain('Other scopes still write memory');
  });

  it('bounds repeated current details and keeps only the latest recent segment', async () => {
    let body = 'PR #978 review todo is current.';
    const llm = async (req) => {
      if (req.pass === 'extract-segments') {
        return JSON.stringify([{ kind: 'decision', tags: ['pr'], sourceMessages: ['m1'], body }]);
      }
      return '[]';
    };
    const base = {
      root: join(testDir, 'memory'),
      sessionId: 's-repeat',
      messages: [{ id: 'm1', role: 'user', body: 'PR #978 review todo remains current.' }],
      targets: ['sessions/s-repeat'],
      llm,
    };

    await extractAndWriteMemorySegments({ ...base, nowIso: () => '2026-06-12T00:00:00.000Z' });
    body = 'PR #978 review todo is still current, reworded by the extractor.';
    await extractAndWriteMemorySegments({ ...base, nowIso: () => '2026-06-12T00:01:00.000Z' });

    const memory = readFileSync(join(testDir, 'memory', 'sessions', 's-repeat', 'memory.md'), 'utf8');
    expect(memory).not.toContain('PR #978 review todo is current.');
    expect(memory).toContain('PR #978 review todo is still current, reworded by the extractor.');
    expect(memory.match(/tags: \[pr\]/g)).toHaveLength(1);
    expect(memory.match(/tags: \[recent, current\]/g)).toHaveLength(1);
    expect(memory.match(/tags: \[recent, experience, workflow\]/g)).toHaveLength(1);
  });

  it('keeps reusable session experience separate from current detail', async () => {
    const llm = async (req) => {
      if (req.pass === 'extract-segments') {
        return JSON.stringify([
          {
            kind: 'workflow',
            tags: ['review-flow'],
            sourceMessages: ['m2'],
            body: 'After review, route findings back to Linus and only route to Omni for merge/tag after fixes are verified.',
          },
          {
            kind: 'correction',
            tags: ['prompt-metadata'],
            sourceMessages: ['m1'],
            body: 'Do not repeat the current session member in active_scope; the selected soul already establishes who is speaking.',
          },
        ]);
      }
      return '[]';
    };

    await extractAndWriteMemorySegments({
      root: join(testDir, 'memory'),
      sessionId: 's-lessons',
      messages: [
        { id: 'm1', role: 'user', body: 'Correction: active_scope should not include session_member; keep session_members only.' },
        { id: 'm2', role: 'user', body: 'Workflow preference: after review, forward fixes to Linus, then route to Omni only for merge and tag.' },
        { id: 'm3', role: 'assistant', body: 'PR #1001 was merged.' },
      ],
      targets: ['sessions/s-lessons'],
      llm,
      nowIso: () => '2026-06-16T00:00:00.000Z',
    });

    const memory = readFileSync(join(testDir, 'memory', 'sessions', 's-lessons', 'memory.md'), 'utf8');
    expect(memory).toContain('kind: workflow');
    expect(memory).toContain('kind: correction');
    expect(memory).toContain('After review, route findings back to Linus');
    expect(memory).toContain('Do not repeat the current session member in active_scope');
    expect(memory).toContain('Reusable session experience from the latest Dream pass');
    expect(memory).toContain('Correction: active_scope should not include session_member');
    expect(memory.match(/tags: \[recent, current\]/g)).toHaveLength(1);
    expect(memory.match(/tags: \[recent, experience, workflow\]/g)).toHaveLength(1);
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
  if (req.pass === 'triage-pass1') return JSON.stringify({ topics: ['active_scope rendering'], user_profile_signals: false });
  if (req.pass === 'triage-pass2') return JSON.stringify({ decision: 'new', path: 'active_scope/rendering' });
  if (req.pass === 'extract-segments') {
    return JSON.stringify([
      {
        kind: 'decision',
        tags: ['dream'],
        sourceMessages: ['m0002'],
        body: 'Dream processed the session conversation and preserved the current implementation detail.',
      },
    ]);
  }
  return JSON.stringify({
    memory_md: '# Memory\n\n- Dream processed the session conversation.\n',
    summary_md: 'Dream processed the session conversation.',
  });
}

function writeSessionMessage(root, sessionId, id, role, content, extra = {}, kind = 'messages', rootName = 'sessions') {
  const dir = join(root, rootName, sessionId, 'conversation', kind);
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
