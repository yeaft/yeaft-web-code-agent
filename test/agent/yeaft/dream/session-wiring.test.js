import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildRunDreamOpts } from '../../../../agent/yeaft/dream/session-wiring.js';
import { runDream } from '../../../../agent/yeaft/dream/runner.js';
import { extractAndWriteMemorySegments } from '../../../../agent/yeaft/dream/segment-extract.js';
import { writeDreamError } from '../../../../agent/yeaft/dream/state.js';
import { readScope } from '../../../../agent/yeaft/memory/segment-store.js';
import { readSummary } from '../../../../agent/yeaft/memory/store.js';
import { buildDreamOutputSnapshot } from '../../../../agent/yeaft/dream/output-snapshot.js';

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

    await expect(opts.listSessions()).resolves.toEqual(['s-empty', 's-live']);
    await expect(opts.countMessages('s-empty')).resolves.toBe(0);
    await expect(opts.countMessages('s-live')).resolves.toBe(2);
    await expect(opts.loadSessionDiff('s-live', 'm0001')).resolves.toEqual([
      { id: 'm0002', role: 'assistant', body: 'noted, I will keep patches small', vpId: 'vp-linus' },
    ]);
    await expect(opts.loadOverlapPreamble('s-live', 'm0002', 1)).resolves.toEqual([
      { id: 'm0001', role: 'user', body: 'remember that I prefer small patches' },
    ]);
  });

  it('uses session metadata as the authoritative Dream session list', async () => {
    writeSessionMeta(testDir, 's-registered-empty');
    writeConversationSegmentJsonlMessage(testDir, 's-registered-with-jsonl', {
      id: 'm0001', role: 'user', content: 'registered JSONL session', time: '2026-06-12T00:00:00.000Z'
    });

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.listSessions()).resolves.toEqual(['s-registered-empty', 's-registered-with-jsonl']);
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

  it('reads session JSONL audit logs when conversation markdown is absent', async () => {
    writeSessionJsonlMessage(testDir, 's-jsonl', {
      id: 'u_01',
      ts: '2026-06-12T00:00:00.000Z',
      from: 'user',
      role: 'user',
      text: 'Dream must read the session JSONL audit log.',
    });
    writeSessionJsonlMessage(testDir, 's-jsonl', {
      id: 'msg_02',
      ts: '2026-06-12T00:01:00.000Z',
      from: 'linus',
      role: 'assistant',
      content: [
        { type: 'text', text: 'JSONL assistant rows should preserve VP attribution.' },
        { type: 'tool_call', name: 'FileRead' },
      ],
    });

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.listSessions()).resolves.toEqual(['s-jsonl']);
    await expect(opts.countMessages('s-jsonl')).resolves.toBe(2);
    await expect(opts.loadSessionDiff('s-jsonl', 'u_01')).resolves.toEqual([
      { id: 'msg_02', role: 'assistant', body: 'JSONL assistant rows should preserve VP attribution.\n[tool call: FileRead]', vpId: 'linus' },
    ]);
  });

  it('reads ConversationStore JSONL segments when markdown projection is absent', async () => {
    writeConversationSegmentJsonlMessage(testDir, 's-segments', {
      id: 'm0001',
      time: '2026-06-12T00:00:00.000Z',
      sessionId: 's-segments',
      role: 'user',
      content: 'ConversationStore JSONL rows are Dream input.',
    });

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.listSessions()).resolves.toEqual(['s-segments']);
    await expect(opts.countMessages('s-segments')).resolves.toBe(1);
    await expect(opts.loadSessionDiff('s-segments', null)).resolves.toEqual([
      { id: 'm0001', role: 'user', body: 'ConversationStore JSONL rows are Dream input.' },
    ]);
  });

  it('prefers canonical conversation JSONL over the session audit log', async () => {
    writeConversationSegmentJsonlMessage(testDir, 's-both', {
      id: 'm0001',
      time: '2026-06-12T00:00:00.000Z',
      sessionId: 's-both',
      role: 'user',
      content: 'canonical conversation row',
    });
    writeSessionJsonlMessage(testDir, 's-both', {
      id: 'u_audit_01',
      ts: '2026-06-12T00:00:00.000Z',
      from: 'user',
      role: 'user',
      text: 'audit duplicate row',
    });

    const opts = buildRunDreamOpts(fakeSession(testDir));

    await expect(opts.countMessages('s-both')).resolves.toBe(1);
    await expect(opts.loadSessionDiff('s-both', null)).resolves.toEqual([{ id: 'm0001', role: 'user', body: 'canonical conversation row' }]);
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
    const summary = await readSummary(
      { kind: 'session', id: 's-live' },
      { root: join(testDir, 'memory'), language: 'en' },
    );
    expect(summary).toContain('Dream processed the session conversation');

    const snapshot = await buildDreamOutputSnapshot({ yeaftDir: testDir }, 's-live');
    expect(snapshot).toEqual(expect.objectContaining({
      scope: 'sessions/s-live',
      hasOutput: true,
      lastError: null,
      totalMessageCount: 2,
      memoryText: expect.stringContaining('Dream processed the session conversation'),
      summaryText: expect.stringContaining('Dream processed the session conversation'),
    }));
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

  it('calls Dream LLM with the active session model, not fastModel', async () => {
    writeSessionMessage(testDir, 's-model', 'm0001', 'user', 'Dream should use the active session model.');
    const calls = [];
    const result = await runDream({
      ...buildRunDreamOpts({
        yeaftDir: testDir,
        config: {
          language: 'en',
          model: 'my-proxy/gpt-5.5',
          primaryModel: 'my-proxy/gpt-5.5',
          fastModelId: 'claude-sonnet-4-20250514',
          modelEffort: 'high',
        },
        adapter: { call: async (req) => {
          calls.push(req);
          return { text: await fakeDreamLlm(req), usage: {} };
        } },
      }),
      manual: true,
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result.targets.some(t => t.status === 'done')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.model === 'my-proxy/gpt-5.5')).toBe(true);
    expect(calls.every(c => c.modelEffort === 'high')).toBe(true);
  });

  it('uses per-session config.json for scoped Dream LLM calls', async () => {
    writeSessionMessage(testDir, 's-session-model', 'm0001', 'user', 'Dream should use the selected Session model.');
    writeSessionConfig(testDir, 's-session-model', {
      model: 'my-proxy/gpt-5.5',
      modelEffort: 'high',
    });
    const calls = [];
    const result = await runDream({
      ...buildRunDreamOpts({
        yeaftDir: testDir,
        config: {
          language: 'en',
          model: 'missing-root-model',
          primaryModel: 'missing-root-model',
        },
        adapter: { call: async (req) => {
          calls.push(req);
          return { text: await fakeDreamLlm(req), usage: {} };
        } },
      }),
      manual: true,
      scopeFilter: ['sessions/s-session-model'],
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result.targets.some(t => t.status === 'done')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.model === 'my-proxy/gpt-5.5')).toBe(true);
    expect(calls.every(c => c.modelEffort === 'high')).toBe(true);
  });

  it('includes the latest Dream error in the debug output snapshot', async () => {
    writeSessionMeta(testDir, 's-error');
    await writeDreamError(join(testDir, 'memory'), 'sessions/s-error', {
      phase: 'triage',
      message: 'Model "missing-fast-model" not found in any provider.',
    });

    const snapshot = await buildDreamOutputSnapshot({ yeaftDir: testDir }, 's-error');
    expect(snapshot.lastError).toEqual(expect.objectContaining({ phase: 'triage', message: expect.stringContaining('missing-fast-model') }));
  });

  it('fills primary session memory and summary when apply returns empty strings', async () => {
    writeSessionMessage(testDir, 's-empty-apply', 'm0001', 'user', 'Dream output must still feed the next system prompt.');

    const result = await runDream({
      ...buildRunDreamOpts(fakeSession(testDir)),
      manual: true,
      llm: async (req) => {
        if (req.pass === 'triage-pass1') return JSON.stringify({ topics: [], user_profile_signals: false });
        if (req.pass === 'extract-segments') return '[]';
        return JSON.stringify({ memory_md: '', summary_md: '' });
      },
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result.targets).toContainEqual(expect.objectContaining({ target: 'sessions/s-empty-apply', status: 'done' }));
    const memory = readFileSync(join(testDir, 'memory', 'sessions', 's-empty-apply', 'memory.md'), 'utf8');
    const summary = await readSummary(
      { kind: 'session', id: 's-empty-apply' },
      { root: join(testDir, 'memory'), language: 'en' },
    );
    expect(memory).toContain('Dream output must still feed the next system prompt');
    expect(summary).toContain('Dream output must still feed the next system prompt');
  });

  it('parses fenced JSON arrays during segment extraction', async () => {
    const result = await extractAndWriteMemorySegments({
      root: join(testDir, 'memory'),
      sessionId: 's-fenced-array',
      messages: [{ id: 'm1', role: 'user', body: 'Dream should preserve fenced JSON array output.' }],
      targets: ['sessions/s-fenced-array'],
      llm: async (req) => {
        if (req.pass === 'extract-segments') {
          return '```json\n[{"kind":"decision","tags":["dream"],"sourceMessages":[{"id":"m1","body":"bad object leak"}],"body":"Fenced array segment survived parsing."}]\n```';
        }
        return '[]';
      },
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({ scopes: expect.any(Number), segments: expect.any(Number) }));
    expect(result.scopes).toBeGreaterThan(0);
    const memory = readFileSync(join(testDir, 'memory', 'sessions', 's-fenced-array', 'memory.md'), 'utf8');
    expect(memory).toContain('Fenced array segment survived parsing');
    expect(memory).toContain('sourceMessages: [m1]');
    expect(memory).not.toContain('[object Object]');
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
    expect(memory).not.toContain('tags: [recent, experience, workflow]');
  });

  it('writes current session memory.md even when extractor returns no permanent segments', async () => {
    const llm = async (req) => {
      if (req.pass === 'extract-segments') return '[]';
      return '[]';
    };

    const result = await extractAndWriteMemorySegments({
      root: join(testDir, 'memory'),
      sessionId: 's-recent-only',
      messages: [{ id: 'm1', role: 'user', body: 'manual dream should still leave inspectable current context.' }],
      targets: ['sessions/s-recent-only'],
      llm,
      nowIso: () => '2026-06-12T00:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({ scopes: 1, segments: 1, errors: [] }));
    const memory = readFileSync(join(testDir, 'memory', 'sessions', 's-recent-only', 'memory.md'), 'utf8');
    expect(memory).toContain('Recent session details from the latest Dream pass');
    expect(memory).toContain('manual dream should still leave inspectable current context');
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
    expect(memory.match(/tags: \[recent, current\]/g)).toHaveLength(1);
    expect(memory.match(/tags: \[recent, experience, workflow\]/g)).toHaveLength(1);

    const segments = readScope(join(testDir, 'memory'), 'sessions/s-lessons');
    const experience = segments.find(seg => seg.tags.includes('experience'));
    expect(experience?.body).toContain('- After review, route findings back to Linus');
    expect(experience?.body).toContain('- Do not repeat the current session member in active_scope');
    expect(experience?.body).not.toContain('- m1 user:');
    expect(experience?.body).not.toContain('Correction: active_scope should not include session_member');
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
  if (rootName === 'sessions') writeSessionMeta(root, sessionId);
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

function writeSessionJsonlMessage(root, sessionId, row) {
  writeSessionMeta(root, sessionId);
  const dir = join(root, 'sessions', sessionId, 'messages');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '000001.jsonl'), `${JSON.stringify(row)}\n`, { flag: 'a' });
}

function writeConversationSegmentJsonlMessage(root, sessionId, row) {
  writeSessionMeta(root, sessionId);
  const dir = join(root, 'sessions', sessionId, 'conversation', 'segments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '000001.jsonl'), `${JSON.stringify(row)}\n`, { flag: 'a' });
}

function writeSessionMeta(root, sessionId, extra = {}) {
  const dir = join(root, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    id: sessionId,
    name: sessionId,
    roster: [],
    defaultVpId: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    ...extra,
  }, null, 2));
}

function writeSessionConfig(root, sessionId, config) {
  const dir = join(root, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}
