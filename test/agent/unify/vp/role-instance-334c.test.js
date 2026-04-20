/**
 * task-334c — RoleInstance v1 tests.
 *
 * Covers:
 *   A. RoleInstance lifecycle: enqueue → drain → idle, abort, standby
 *   B. createEngineBinder cache, invalidate, clear
 *   C. buildSystemPrompt section shape + caching by mtimeMs
 *   D. recallCoreMemory: vp single-dim filter (R3 §Δ2.3)
 *   E. createTurnRunner: happy path + abort + persistence to group
 *   F. registry.updateVpInPlace mirrors personaHash (task-334c fix)
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { RoleInstance } from '../../../../agent/unify/vp/role-instance.js';
import { Registry } from '../../../../agent/unify/vp/registry.js';
import {
  buildSystemPrompt,
  recallCoreMemory,
  searchCoreMemory,
  createEngineBinder,
  createTurnRunner,
} from '../../../../agent/unify/vp/index.js';

function makeVp(overrides = {}) {
  return {
    id: 'alice',
    name: 'Alice',
    role: 'PM',
    traits: ['curious'],
    modelHint: 'primary',
    persona: 'You are Alice, a thoughtful PM.',
    personaHash: 'abc12345',
    dir: '/tmp/alice',
    memoryDir: '/tmp/alice/memory',
    mtimeMs: 1000,
    ...overrides,
  };
}

function makeEnvelope(text, extra = {}) {
  return {
    groupId: 'grp_a',
    taskId: null,
    trigger: 'mention',
    msg: { id: 'msg_1', from: 'user', role: 'user', text, ts: '2026-04-20T00:00:00Z' },
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────
// A. Lifecycle
// ─────────────────────────────────────────────────────────────
describe('RoleInstance — lifecycle (task-334c)', () => {
  it('enqueue transitions idle → queued; drain runs FIFO and returns to idle', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    expect(ri.state).toBe('idle');
    ri.enqueue(makeEnvelope('hi'));
    expect(ri.state).toBe('queued');
    ri.enqueue(makeEnvelope('again'));

    const seen = [];
    const result = await ri.drain(async (env) => {
      seen.push(env.msg.text);
    });

    expect(seen).toEqual(['hi', 'again']);
    expect(result.turns).toBe(2);
    expect(result.errors).toBe(0);
    expect(ri.state).toBe('idle');
    expect(ri.turnCount).toBe(2);
  });

  it('drain is re-entry safe — concurrent calls return the same promise', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('one'));
    let count = 0;
    const runner = async () => { count += 1; await new Promise(r => setTimeout(r, 5)); };
    const p1 = ri.drain(runner);
    const p2 = ri.drain(runner);
    expect(p1).toBe(p2);
    await p1;
    expect(count).toBe(1);
  });

  it('standby sticks — drain buffers, does not invoke runner', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.setState('standby');
    ri.enqueue(makeEnvelope('waiting'));
    let calls = 0;
    const res = await ri.drain(async () => { calls += 1; });
    expect(calls).toBe(0);
    expect(ri.state).toBe('standby');
    expect(ri.inputQueue.length).toBe(1);
    expect(res.turns).toBe(0);

    // Reactivate: runner proceeds.
    ri.setState('idle');
    await ri.drain(async () => { calls += 1; });
    expect(calls).toBe(1);
    expect(ri.state).toBe('idle');
  });

  it('abort() fires the controller; runner seeing AbortError stops drain', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('a'));
    ri.enqueue(makeEnvelope('b'));

    let started = 0;
    const runner = async (_env, inst) => {
      started += 1;
      if (started === 1) {
        inst.abort('user');
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    };

    const result = await ri.drain(runner);
    expect(started).toBe(1);
    expect(result.turns).toBe(1);
    expect(result.errors).toBe(1);
    expect(ri.state).toBe('error');
    expect(ri.inputQueue.length).toBe(1); // second envelope not consumed
  });

  it('non-abort runner errors flag error state but drain continues', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('x'));
    ri.enqueue(makeEnvelope('y'));
    const calls = [];
    const runner = async (env) => {
      calls.push(env.msg.text);
      if (env.msg.text === 'x') throw new Error('boom');
    };
    const res = await ri.drain(runner);
    expect(calls).toEqual(['x', 'y']);
    expect(res.turns).toBe(2);
    expect(res.errors).toBe(1);
  });

  it('snapshot includes turnCount + hasError', () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.turnCount = 3;
    ri.lastError = new Error('x');
    const s = ri.snapshot();
    expect(s.turnCount).toBe(3);
    expect(s.hasError).toBe(true);
    expect(s.vpId).toBe('alice');
    expect(s.groupId).toBe('grp_a');
  });
});

// ─────────────────────────────────────────────────────────────
// B. Engine binder
// ─────────────────────────────────────────────────────────────
describe('createEngineBinder', () => {
  function fakeEngine() { return { query: async function*() { /* noop */ } }; }

  it('caches per-vpId; same VP → same engine', () => {
    let calls = 0;
    const binder = createEngineBinder({
      createEngine: () => { calls += 1; return fakeEngine(); },
    });
    const vp = makeVp();
    const ri1 = new RoleInstance({ vp, groupId: 'grp_a' });
    const ri2 = new RoleInstance({ vp, groupId: 'grp_b' });
    const e1 = binder.bind(ri1);
    const e2 = binder.bind(ri2);
    expect(e1).toBe(e2);
    expect(calls).toBe(1);
    expect(binder.size()).toBe(1);
  });

  it('invalidate drops the cache; next bind rebuilds', () => {
    let calls = 0;
    const binder = createEngineBinder({
      createEngine: () => { calls += 1; return fakeEngine(); },
    });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    binder.bind(ri);
    binder.invalidate('alice');
    expect(binder.size()).toBe(0);
    binder.bind(ri);
    expect(calls).toBe(2);
  });

  it('rejects non-Engine factory output', () => {
    const binder = createEngineBinder({ createEngine: () => ({}) });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    expect(() => binder.bind(ri)).toThrow(/Engine-like/);
  });

  it('requires createEngine factory', () => {
    expect(() => createEngineBinder({})).toThrow(/createEngine/);
  });
});

// ─────────────────────────────────────────────────────────────
// C. System prompt
// ─────────────────────────────────────────────────────────────
describe('buildSystemPrompt', () => {
  let registry;
  beforeEach(() => { registry = new Registry(); });

  it('emits STATIC / SEMI-DYNAMIC / DYNAMIC sections with persona + hash', async () => {
    const vp = makeVp();
    registry.setVp(vp);
    const ri = registry.getOrCreateRoleInstance('alice', 'grp_a');
    const prompt = await buildSystemPrompt(ri, {
      registry,
      rosterMembers: ['alice', 'bob'],
      runtimeCtx: { taskId: 'task_1' },
    });
    expect(prompt).toMatch(/§ STATIC/);
    expect(prompt).toMatch(/§ SEMI-DYNAMIC/);
    expect(prompt).toMatch(/§ DYNAMIC/);
    expect(prompt).toMatch(/vp_persona \(id=alice, hash=abc12345\)/);
    expect(prompt).toMatch(/You are Alice, a thoughtful PM\./);
    expect(prompt).toMatch(/群成员 \(2\)/);
    expect(prompt).toMatch(/你自己：alice/);
    expect(prompt).toMatch(/vpId: alice/);
    expect(prompt).toMatch(/groupId: grp_a/);
    expect(prompt).toMatch(/taskId: task_1/);
    expect(prompt).toMatch(/isDream: false/);
  });

  it('caches STATIC by mtimeMs; rebuilds after mtime change', async () => {
    const vp = makeVp();
    const ri = new RoleInstance({ vp, groupId: 'grp_a' });
    await buildSystemPrompt(ri, {});
    const cached = ri.systemPrompt;
    const mtime1 = ri._promptBuiltForMtime;
    expect(cached).toBeTruthy();
    expect(mtime1).toBe(1000);

    // mtime change simulates hot-reload
    vp.mtimeMs = 2000;
    vp.persona = 'Alice v2 persona.';
    await buildSystemPrompt(ri, {});
    expect(ri._promptBuiltForMtime).toBe(2000);
    expect(ri.systemPrompt).toMatch(/Alice v2 persona\./);
  });

  it('injects core_memory block when memoryStore has entries', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.memoryStore = {
      query: ({ vp, limit }) => {
        expect(vp).toBe('alice');
        expect(limit).toBe(7);
        return [
          { body: 'prefers terse replies', shard: 'preference' },
          { body: 'worked on task-334', shard: 'context' },
        ];
      },
    };
    const p = await buildSystemPrompt(ri, {});
    expect(p).toMatch(/## core_memory/);
    expect(p).toMatch(/\[mem:preference\] prefers terse replies/);
    expect(p).toMatch(/\[mem:context\] worked on task-334/);
  });

  it('omits core_memory when store returns nothing', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.memoryStore = { query: () => [] };
    const p = await buildSystemPrompt(ri, {});
    expect(p).not.toMatch(/## core_memory/);
  });

  it('does not leak sourceRef to the prompt (R3 §Δ2.1)', async () => {
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.memoryStore = {
      query: () => [{ body: 'body1', shard: 'fact', sourceRef: 'msg_secret_999' }],
    };
    const p = await buildSystemPrompt(ri, {});
    expect(p).toMatch(/body1/);
    expect(p).not.toMatch(/msg_secret_999/);
  });
});

// ─────────────────────────────────────────────────────────────
// D. recallCoreMemory
// ─────────────────────────────────────────────────────────────
describe('recallCoreMemory + searchCoreMemory (R3 §Δ2.3)', () => {
  it('passes {vp, limit} single-dim filter to store.query', async () => {
    let received = null;
    const store = { query: (f) => { received = f; return [{ body: 'x' }]; } };
    const out = await recallCoreMemory(store, { vp: 'alice', limit: 3 });
    expect(received).toEqual({ vp: 'alice', limit: 3 });
    expect(out).toHaveLength(1);
  });

  it('returns [] for null store and throws without vp', async () => {
    expect(await recallCoreMemory(null, { vp: 'alice' })).toEqual([]);
    await expect(recallCoreMemory({ query: () => [] }, {})).rejects.toThrow(/vp/);
  });

  it('honours optional shard / kind / tags filters', async () => {
    let received = null;
    const store = { query: (f) => { received = f; return []; } };
    await recallCoreMemory(store, { vp: 'alice', shard: 'preference', kind: 'fact', tags: ['x'] });
    expect(received.shard).toBe('preference');
    expect(received.kind).toBe('fact');
    expect(received.tags).toEqual(['x']);
  });

  it('searchCoreMemory delegates to store.search when available', async () => {
    const store = {
      search: ({ vp, query, limit }) => {
        expect(vp).toBe('alice');
        expect(query).toBe('foo');
        expect(limit).toBe(5);
        return [{ body: 'foo bar' }];
      },
    };
    const out = await searchCoreMemory(store, { vp: 'alice', query: 'foo', limit: 5 });
    expect(out).toHaveLength(1);
  });

  it('searchCoreMemory falls back to query + substring when no search()', async () => {
    const store = { query: () => [{ body: 'apple pie' }, { body: 'Banana split' }] };
    const out = await searchCoreMemory(store, { vp: 'alice', query: 'banana' });
    expect(out).toHaveLength(1);
    expect(out[0].body).toMatch(/Banana/);
  });
});

// ─────────────────────────────────────────────────────────────
// E. createTurnRunner
// ─────────────────────────────────────────────────────────────
describe('createTurnRunner', () => {
  function fakeEngine(emitter) {
    return {
      async *query(opts) {
        // Echo back received systemPrompt/metadata so tests can assert.
        emitter?.(opts);
        yield { type: 'text', text: 'hello ' };
        yield { type: 'text', text: opts.prompt.toUpperCase() };
        yield { type: 'turn_end' };
      },
    };
  }

  it('runs one envelope end-to-end: builds prompt, accumulates text, appends messages', async () => {
    let captured = null;
    const binder = createEngineBinder({ createEngine: () => fakeEngine((o) => { captured = o; }) });
    const registry = new Registry();
    const vp = makeVp();
    registry.setVp(vp);
    const ri = registry.getOrCreateRoleInstance('alice', 'grp_a');
    const runner = createTurnRunner({ binder, registry, rosterMembers: ['alice'] });

    ri.enqueue(makeEnvelope('world'));
    const res = await ri.drain(runner);

    expect(res.turns).toBe(1);
    expect(res.errors).toBe(0);
    expect(ri.messages).toHaveLength(2);
    expect(ri.messages[0].role).toBe('user');
    expect(ri.messages[0].text).toBe('world');
    expect(ri.messages[1].role).toBe('assistant');
    expect(ri.messages[1].text).toBe('hello WORLD');
    expect(captured.systemPrompt).toMatch(/§ STATIC/);
    expect(captured.metadata).toMatchObject({ vpId: 'alice', groupId: 'grp_a' });
  });

  it('routes aborted event → AbortError; drain stops', async () => {
    const binder = createEngineBinder({
      createEngine: () => ({
        async *query() {
          yield { type: 'text', text: 'partial' };
          yield { type: 'aborted', reason: 'user' };
        },
      }),
    });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('stop me'));
    ri.enqueue(makeEnvelope('never reached'));
    const runner = createTurnRunner({ binder });
    await ri.drain(runner);
    expect(ri.state).toBe('error');
    expect(ri.lastError?.name).toBe('AbortError');
    expect(ri.inputQueue.length).toBe(1);
  });

  it('persists assistant replies via group.appendMessage when provided', async () => {
    const appended = [];
    const group = { appendMessage: (m) => { appended.push(m); return { ...m, id: 'msg_99' }; } };
    const binder = createEngineBinder({
      createEngine: () => ({
        async *query() { yield { type: 'text', text: 'reply body' }; },
      }),
    });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('ping', { taskId: 'task_1' }));
    const runner = createTurnRunner({ binder, group });
    await ri.drain(runner);
    expect(appended).toHaveLength(1);
    expect(appended[0].from).toBe('alice');
    expect(appended[0].text).toBe('reply body');
    expect(appended[0].taskId).toBe('task_1');
  });

  it('skips persistence when assistant produced empty text', async () => {
    const appended = [];
    const group = { appendMessage: (m) => { appended.push(m); } };
    const binder = createEngineBinder({
      createEngine: () => ({ async *query() { /* nothing */ } }),
    });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('silence'));
    const runner = createTurnRunner({ binder, group });
    await ri.drain(runner);
    expect(appended).toHaveLength(0);
  });

  it('rejects missing envelope.msg', async () => {
    const binder = createEngineBinder({ createEngine: () => ({ async *query() {} }) });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.inputQueue.push({ groupId: 'grp_a' }); // bad envelope — no .msg
    ri.setState('queued');
    const runner = createTurnRunner({ binder });
    const res = await ri.drain(runner);
    expect(res.errors).toBe(1);
  });

  it('onEvent fan-out receives forwarded events', async () => {
    const events = [];
    const binder = createEngineBinder({
      createEngine: () => ({
        async *query() {
          yield { type: 'text', text: 'a' };
          yield { type: 'tool_call', name: 'x' };
          yield { type: 'turn_end' };
        },
      }),
    });
    const ri = new RoleInstance({ vp: makeVp(), groupId: 'grp_a' });
    ri.enqueue(makeEnvelope('hi'));
    const runner = createTurnRunner({ binder, onEvent: (e) => events.push(e.type) });
    await ri.drain(runner);
    expect(events).toContain('tool_call');
    expect(events).toContain('turn_end');
  });
});

// ─────────────────────────────────────────────────────────────
// F. Registry personaHash mirror (task-334c fix for known 334h nit)
// ─────────────────────────────────────────────────────────────
describe('Registry.updateVpInPlace — personaHash mirror', () => {
  it('updates personaHash alongside other persona fields', () => {
    const r = new Registry();
    const vp1 = makeVp({ personaHash: 'aaaaaaaa' });
    r.setVp(vp1);
    const updated = r.updateVpInPlace({ ...vp1, persona: 'new body', personaHash: 'bbbbbbbb', mtimeMs: 2000 });
    expect(updated.personaHash).toBe('bbbbbbbb');
    expect(updated.persona).toBe('new body');
    expect(updated.mtimeMs).toBe(2000);
    // identity stable (same object)
    expect(updated).toBe(vp1);
  });
});
