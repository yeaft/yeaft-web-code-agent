import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptPersonResponse, createPersonController, digitalPersonGate, personState } from '../../web/stores/helpers/digital-person.js';

const controllers = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });
function fixture() {
  const requests = [];
  let owner = 'owner-a';
  let responder;
  const chat = {
    connectionState: 'connected', authenticated: true,
    agents: ['a', 'b'].map(id => ({ id, online: true, capabilities: ['digital_person'] })),
    sendWsMessage(message) { requests.push(message); responder?.(message); return true; },
  };
  const state = personState();
  const controller = createPersonController({ chat, state, scope: () => owner, timeoutMs: 100, pollMs: 50 });
  controllers.push(controller);
  const response = (request, data, extra = {}) => acceptPersonResponse(chat, {
    ...request, type: 'person_response', ok: true, data, ...extra,
  });
  const auto = (override = () => undefined) => { responder = request => {
    const result = override(request);
    if (result === false) return;
    const defaults = {
      status: { configured: true }, open: {},
      snapshot: { person: { id: `person-${request.agentId}`, name: 'Person' }, state: { version: 1 }, messages: [], busy: false },
      messages: { items: [], nextCursor: null }, traces: { items: [], nextCursor: null },
      send: { episodeId: 'episode-1' }, think: { episodeId: 'episode-1' }, dream: { episodeId: 'episode-1' }, cancel: {},
    };
    response(request, result === undefined ? defaults[request.op] : result);
  }; };
  return { chat, state, controller, requests, response, auto, owner(value) { owner = value; } };
}

describe('Digital Person owner / Agent request boundary', () => {
  it('opens via status, open and paginated reads without Session operations', async () => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    expect(f.state.person.id).toBe('person-a');
    expect(f.requests.map(r => r.op)).toEqual(['status', 'open', 'snapshot', 'messages', 'traces']);
    expect(f.requests.every(r => r.type === 'person_request' && r.agentId === 'a' && !r.sessionId && !r.ownerId)).toBe(true);
    expect(f.requests.find(r => r.op === 'traces').payload).toEqual({ cursor: null, limit: 50 });
  });

  it('gates unsupported, offline and disconnected Agents without requests', async () => {
    const f = fixture();
    f.chat.agents[0].capabilities = [];
    expect(digitalPersonGate(f.chat, 'a')).toBe('unsupported');
    await f.controller.open('a');
    f.chat.agents[0].online = false;
    expect(digitalPersonGate(f.chat, 'a')).toBe('offline');
    f.chat.connectionState = 'reconnecting';
    expect(digitalPersonGate(f.chat, 'a')).toBe('disconnected');
    expect(f.requests).toHaveLength(0);
  });

  it('unconfigured runtime never opens or creates a fallback Session', async () => {
    const f = fixture(); f.auto(r => r.op === 'status' ? { configured: false, reason: 'MongoDB not configured' } : undefined);
    await f.controller.open('a');
    expect(f.state.configured).toBe(false);
    expect(f.requests.map(r => r.op)).toEqual(['status']);
    expect(await f.controller.command('send', 'hi')).toBe(false);
  });

  it('rejects mismatched request, Agent and operation, then accepts the right response', async () => {
    const f = fixture(); const opening = f.controller.open('a'); const request = f.requests[0];
    expect(f.response(request, { configured: true }, { agentId: 'b' })).toBe(false);
    expect(f.response(request, { configured: true }, { op: 'snapshot' })).toBe(false);
    expect(f.response(request, { configured: true }, { requestId: 'unknown' })).toBe(false);
    f.auto(); f.response(request, { configured: true }); await opening;
    expect(f.state.person.id).toBe('person-a');
  });

  it('fences delayed responses after Agent and owner changes', async () => {
    const f = fixture(); const old = f.controller.open('a'); const request = f.requests[0];
    f.auto(); await f.controller.open('b'); await old;
    expect(f.response(request, { configured: true })).toBe(false);
    expect(f.state.person.id).toBe('person-b');
    f.auto(() => false); const refreshing = f.controller.refresh(); const snapshot = f.requests.at(-1);
    f.owner('owner-b');
    expect(f.response(snapshot, { person: { id: 'leak' } })).toBe(false);
    f.auto(); await f.controller.open('a'); await refreshing;
    expect(f.state.person.id).toBe('person-a');
  });

  it('keeps uncertain command ID across re-entry and retries only on explicit action', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'send' ? false : undefined);
    const pending = f.controller.command('send', 'hello');
    const first = f.requests.at(-1);
    await vi.advanceTimersByTimeAsync(101); expect(await pending).toBe(false);
    expect(f.state.error.code).toBe('timeout');
    await f.controller.open('b'); expect(f.state.retryCommand).toBeNull();
    await f.controller.open('a');
    expect(f.state.retryCommand.payload.clientMessageId).toBe(first.payload.clientMessageId);
    expect(f.requests.filter(r => r.op === 'send')).toHaveLength(1);
    expect(await f.controller.command('send', 'new')).toBe(false);
    f.auto(); await f.controller.command('send', '', true);
    const retry = f.requests.at(-1);
    expect(retry.payload).toEqual(first.payload);
    expect(retry.requestId).not.toBe(first.requestId);
    expect(f.state.retryCommand).toBeNull();
  });

  it('never transfers an uncertain command between owners', async () => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'think' ? false : undefined);
    const pending = f.controller.command('think');
    f.owner('other'); f.auto(); await f.controller.open('a'); await pending;
    expect(f.state.retryCommand).toBeNull();
  });

  it('polls busy snapshots, preserves all paged Trace and stops after completion', async () => {
    vi.useFakeTimers(); const f = fixture(); let busy = false;
    f.auto(r => r.op === 'snapshot' ? { person: { id: 'p' }, state: { version: 2 }, messages: [], busy }
      : r.op === 'traces' ? { items: [{ id: r.payload.cursor || 'latest', kind: 'think', createdAt: 1 }], nextCursor: r.payload.cursor ? null : 'older' } : undefined);
    await f.controller.open('a'); await f.controller.page('traces', true);
    expect(f.state.traces.map(t => t.id)).toEqual(['latest', 'older']);
    busy = true; await f.controller.command('think');
    await vi.advanceTimersByTimeAsync(51);
    expect(f.state.busy).toBe(true); expect(f.state.tracesStale).toBe(true);
    expect(f.state.traces).toHaveLength(2);
    busy = false; await vi.advanceTimersByTimeAsync(51);
    expect(f.state.busy).toBe(false);
    const count = f.requests.length; await vi.advanceTimersByTimeAsync(200);
    expect(f.requests).toHaveLength(count);
  });

  it('does not let an older idle snapshot undo an acknowledged command', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto(); await f.controller.open('a');
    let delayedSnapshot;
    f.auto(r => {
      if (r.op === 'snapshot') { delayedSnapshot = r; return false; }
    });
    // An earlier poll is in flight when the user starts a new episode.
    await f.controller.command('think');
    await vi.advanceTimersByTimeAsync(51);
    expect(delayedSnapshot).toBeTruthy();
    const refreshing = f.controller.refresh();
    const newerSnapshot = delayedSnapshot;
    f.response(newerSnapshot, { person: { id: 'p' }, state: {}, messages: [], busy: false });
    await refreshing;
    await f.controller.command('send', 'new episode');
    const acknowledgedEpisode = f.state.episodeId;
    const oldSnapshot = f.requests.filter(r => r.op === 'snapshot').at(-2);
    f.response(oldSnapshot, { person: { id: 'p' }, state: {}, messages: [], busy: false });
    await Promise.resolve();
    expect(f.state.busy).toBe(true);
    expect(f.state.episodeId).toBe(acknowledgedEpisode);
  });

  it('merges older messages without duplicates and cancels using a scoped request', async () => {
    const f = fixture(); let busy = true;
    const message = { id: 'new', role: 'assistant', text: 'answer', createdAt: 2 };
    f.auto(r => {
      if (r.op === 'snapshot') return { person: { id: 'p' }, state: {}, messages: [message], busy, episodeId: busy ? 'displayed-episode' : null };
      if (r.op === 'messages') return { items: r.payload.cursor ? [{ id: 'old', role: 'user', text: 'hi', createdAt: 1 }, message] : [message], nextCursor: r.payload.cursor ? null : 'cursor' };
      if (r.op === 'cancel') busy = false;
    });
    await f.controller.open('a'); await f.controller.page('messages', true);
    expect(f.state.messages.map(m => m.id)).toEqual(['old', 'new']);
    await f.controller.cancel();
    expect(f.requests.find(r => r.op === 'cancel')).toMatchObject({ agentId: 'a', payload: { episodeId: 'displayed-episode' } });
    expect(f.state.busy).toBe(false);
  });

  it('rebuilds a complete message pagination chain after remote activity exceeds the snapshot window', async () => {
    const f = fixture(); let records = [];
    f.auto(r => {
      if (r.op === 'snapshot') return { person: { id: 'p' }, state: {}, busy: false, messages: records.slice(-20), nextMessagesCursor: records.length > 20 ? String(records.at(-20).seq) : null };
      if (r.op === 'messages') {
        const end = r.payload.cursor ? Number(r.payload.cursor) - 1 : records.length;
        const items = records.slice(Math.max(0, end - 50), end);
        return { items, nextCursor: end > 50 ? String(items[0].seq) : null };
      }
    });
    await f.controller.open('a');
    records = Array.from({ length: 80 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1, createdAt: 1, text: 'remote' }));
    await f.controller.refresh();
    expect(f.state.messages).toHaveLength(50);
    expect(f.state.messageCursor).toBe('31');
    await f.controller.page('messages', true);
    expect(f.state.messages.map(m => m.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(f.state.messageCursor).toBeNull();
  });

  it('sorts same-time and clock-rollback records by authoritative sequence', async () => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    const records = [{ id: 'z-first', seq: 1, createdAt: 100 }, { id: 'a-second', seq: 2, createdAt: 99 }];
    f.auto(r => r.op === 'messages' || r.op === 'traces' ? { items: [...records].reverse(), nextCursor: null } : undefined);
    await f.controller.refresh();
    expect(f.state.messages.map(m => m.seq)).toEqual([1, 2]);
    expect(f.state.traces.map(m => m.seq)).toEqual([1, 2]);
  });

  it('fails a dropped transport promptly instead of waiting for timeout', async () => {
    const f = fixture(); f.chat.sendWsMessage = () => false;
    await f.controller.open('a');
    expect(f.state.loading).toBe(false); expect(f.state.error.code).toBe('disconnected');
  });
});
