import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptPersonResponse, createPersonController, digitalPersonGate, personState } from '../../web/stores/helpers/digital-person.js';

const controllers = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });
function fixture(options = {}) {
  const requests = [];
  let owner = 'owner-a';
  let responder;
  const chat = {
    connectionState: 'connected', authenticated: true,
    agents: ['a', 'b'].map(id => ({ id, online: true, capabilities: ['digital_person'] })),
    sendWsMessage(message) { requests.push(message); responder?.(message); return true; },
  };
  const state = personState();
  const controller = createPersonController({ chat, state, scope: () => owner, timeoutMs: 100, pollMs: 50, ...options });
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

  it('stays manual through idle time, refresh, reconnect and re-entry', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto();
    const commands = () => f.requests.filter(r => ['send', 'think', 'dream', 'settings'].includes(r.op));
    await f.controller.open('a');
    await vi.advanceTimersByTimeAsync(3600000);
    await f.controller.refresh();
    await f.controller.page('traces');
    await f.controller.page('messages');
    f.chat.connectionState = 'reconnecting'; await f.controller.open('a');
    f.chat.connectionState = 'connected'; await f.controller.open('a');
    await f.controller.open('b'); await f.controller.open('a');
    expect(commands()).toEqual([]);
    for (const op of ['think', 'dream']) {
      expect(await f.controller.command(op)).toBe(true);
      // The status poll observes completion, but must not start another episode.
      await vi.advanceTimersByTimeAsync(3600000);
      expect(f.state.busy).toBe(false);
      expect(commands().filter(r => r.op === op)).toHaveLength(1);
    }
    expect(commands().map(r => r.op)).toEqual(['think', 'dream']);
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

  it('keeps file references in uncertain retry and isolates model settings from cognition', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'send' ? false : r.op === 'settings' ? { settings: r.payload } : undefined);
    const pending = f.controller.command('send', '', false, [{ fileId: 'file-1', name: 'not-authoritative.txt' }]);
    await vi.advanceTimersByTimeAsync(101); expect(await pending).toBe(false);
    expect(f.state.retryCommand.payload.attachments).toEqual([{ fileId: 'file-1' }]);
    expect(await f.controller.settings(['p/m'])).toBe(false);
    const first = f.requests.at(-1);
    f.auto(); expect(await f.controller.command('send', '', true)).toBe(true);
    expect(f.requests.at(-1).payload).toEqual(first.payload);
    await vi.advanceTimersByTimeAsync(51);
    f.auto(r => r.op === 'settings' ? { settings: r.payload } : undefined);
    expect(await f.controller.settings(['p/m'])).toBe(true);
    expect(f.state.modelCandidates).toEqual(['p/m']);
    expect(f.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(2);
  });

  it('reconciles an admitted file request without uploading or executing it again', async () => {
    vi.useFakeTimers();
    const reupload = vi.fn(); const f = fixture({ reupload }); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'send' ? false : undefined);
    const pending = f.controller.command('send', '', false, [{ fileId: 'expired', file: { name: 'x.txt' } }]);
    const original = f.requests.at(-1);
    await vi.advanceTimersByTimeAsync(101); await pending;
    f.auto(r => r.op === 'receipt' ? { found: true, episodeId: 'episode-1', status: 'completed', kind: 'send', text: '' } : undefined);
    expect(await f.controller.command('send', '', true)).toBe(true);
    expect(f.requests.find(r => r.op === 'receipt').payload.clientMessageId).toBe(original.payload.clientMessageId);
    expect(f.requests.filter(r => r.op === 'send')).toHaveLength(1);
    expect(reupload).not.toHaveBeenCalled();
    expect(f.state.retryCommand).toBeNull();
  });

  it('reuploads original files after missing receipt, preserving command identity and text', async () => {
    vi.useFakeTimers();
    const file = { name: 'x.txt' };
    const reupload = vi.fn(async () => [{ fileId: 'renewed' }]);
    const f = fixture({ reupload }); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'think' ? false : undefined);
    const pending = f.controller.command('think', 'original', false, [{ fileId: 'expired', file }]);
    const original = f.requests.at(-1);
    await vi.advanceTimersByTimeAsync(101); await pending;
    await f.controller.open('b'); await f.controller.open('a');
    f.auto(r => r.op === 'receipt' ? { found: false } : undefined);
    expect(await f.controller.command('think', 'changed', true)).toBe(true);
    expect(reupload).toHaveBeenCalledWith([file]);
    expect(f.requests.at(-1).payload).toEqual({ ...original.payload, attachments: [{ fileId: 'renewed' }] });
  });

  it('renews a stale draft once, and fences renewal after owner changes', async () => {
    let finish;
    const reupload = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const f = fixture({ reupload }); f.auto(); await f.controller.open('a');
    f.auto(r => {
      if (r.op !== 'send') return;
      f.response(r, null, { ok: false, errorCode: 'attachment_expired' }); return false;
    });
    const pending = f.controller.command('send', 'original', false, [{ fileId: 'expired', file: { name: 'x.txt' } }]);
    await Promise.resolve(); await Promise.resolve();
    expect(reupload).toHaveBeenCalledOnce();
    f.owner('owner-b'); f.auto(); await f.controller.open('a');
    finish([{ fileId: 'private-renewed' }]); expect(await pending).toBe(false);
    expect(f.requests.filter(r => r.op === 'send')).toHaveLength(1);
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

  it('synchronizes terminal traces behind late reads without silently losing paged history', async () => {
    vi.useFakeTimers();
    for (const more of [false, true]) for (const kind of ['committed', 'cancelled', 'failed']) {
      const f = fixture();
      const latest = { id: 'latest', seq: 2, kind: 'call_started' };
      const older = { id: 'older', seq: 1, kind: 'committed' };
      const terminal = { id: 'terminal', seq: 3, kind };
      f.auto(r => r.op === 'traces' ? { items: [latest], nextCursor: 'older' } : undefined);
      await f.controller.open('a'); await f.controller.command('think');
      f.auto(r => r.op === 'traces' ? false : undefined);
      const reading = f.controller.page('traces', more);
      const delayed = f.requests.at(-1);
      // Both polling and the cancel acknowledgement refresh terminal state
      // while a pre-terminal trace read is still in flight.
      if (kind === 'cancelled') await f.controller.cancel();
      else await vi.advanceTimersByTimeAsync(51);
      expect(f.state.busy).toBe(false);
      expect(f.state.tracesStale).toBe(true);
      f.response(delayed, { items: more ? [older] : [latest], nextCursor: more ? null : 'older' });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.state.tracesStale).toBe(true);
      if (more) {
        await reading;
        expect(f.state.traces.map(t => t.id)).toEqual(['older', 'latest']);
        expect(f.state.traceCursor).toBeNull();
        expect(f.requests.filter(r => r.op === 'traces')).toHaveLength(2);
        // Only an explicit latest refresh may replace the paged window.
        f.auto(r => r.op === 'traces' ? { items: [latest, terminal], nextCursor: 'older' } : undefined);
        await f.controller.page('traces');
      } else {
        const followup = f.requests.at(-1);
        expect(followup).toMatchObject({ op: 'traces', payload: { cursor: null, limit: 50 } });
        expect(followup.requestId).not.toBe(delayed.requestId);
        f.response(followup, { items: [latest, terminal], nextCursor: 'older' });
        await reading;
      }
      expect(f.state.traces.at(-1)).toEqual(terminal);
      expect(f.state.tracesStale).toBe(false);
      const count = f.requests.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.requests).toHaveLength(count);
      expect(f.requests.filter(r => !['status', 'open', 'snapshot', 'messages', 'traces'].includes(r.op)).map(r => r.op)).toEqual(kind === 'cancelled' ? ['think', 'cancel'] : ['think']);
      f.controller.dispose();
    }
  });

  it('keeps failed or timed-out terminal reads stale without unbounded retries', async () => {
    vi.useFakeTimers();
    for (const code of ['requestFailed', 'timeout']) for (const more of [false, true]) {
      const f = fixture();
      const latest = { id: 'latest', seq: 2 };
      f.auto(r => r.op === 'traces' ? { items: [latest], nextCursor: 'older' } : undefined);
      await f.controller.open('a'); await f.controller.command('think');
      f.auto(r => r.op === 'traces' ? false : undefined);
      const reading = f.controller.page('traces', more);
      const delayed = f.requests.at(-1);
      await vi.advanceTimersByTimeAsync(51);
      if (code === 'timeout') await vi.advanceTimersByTimeAsync(50);
      else {
        f.response(delayed, null, { ok: false, errorCode: code });
        await vi.advanceTimersByTimeAsync(0);
      }
      const followup = f.requests.at(-1);
      expect(followup.op).toBe('traces');
      expect(followup.requestId).not.toBe(delayed.requestId);
      if (code === 'timeout') await vi.advanceTimersByTimeAsync(101);
      else f.response(followup, null, { ok: false, errorCode: code });
      await reading;
      expect(f.state.error.code).toBe(code);
      expect(f.state.tracesStale).toBe(true);
      expect(f.state.tracesLoading).toBe(false);
      expect(f.state.traces).toEqual([latest]);
      expect(f.state.traceCursor).toBe('older');
      expect(f.response(delayed, { items: [{ id: 'too-late' }] })).toBe(false);
      expect(f.response(followup, { items: [{ id: 'also-too-late' }] })).toBe(false);
      const count = f.requests.length;
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.requests).toHaveLength(count);
      f.auto(r => r.op === 'traces' ? { items: [{ id: 'terminal', kind: 'failed' }], nextCursor: null } : undefined);
      await f.controller.refresh();
      expect(f.state.traces.map(t => t.id)).toEqual(['terminal']);
      expect(f.state.tracesStale).toBe(false);
      expect(f.state.error).toBeNull();
      expect(f.requests.filter(r => ['send', 'think', 'dream', 'settings'].includes(r.op)).map(r => r.op)).toEqual(['think']);
      f.controller.dispose();
    }
  });

  it('fences queued and in-flight terminal trace reads across Agent and owner changes', async () => {
    vi.useFakeTimers();
    for (const boundary of ['agent', 'owner']) for (const followupStarted of [false, true]) {
      const f = fixture(); f.auto(); await f.controller.open('a');
      await f.controller.command('think');
      f.auto(r => r.op === 'traces' ? false : undefined);
      const reading = f.controller.page('traces');
      const delayed = f.requests.at(-1);
      await vi.advanceTimersByTimeAsync(51);
      expect(f.state.tracesStale).toBe(true);
      if (followupStarted) {
        f.response(delayed, { items: [{ id: 'old' }], nextCursor: null });
        await vi.advanceTimersByTimeAsync(0);
      }
      const pending = f.requests.at(-1);
      if (boundary === 'owner') {
        f.owner('owner-b');
        expect(f.response(pending, { items: [{ id: 'leak' }] })).toBe(false);
      }
      const count = f.requests.length;
      f.auto(); await f.controller.open(boundary === 'agent' ? 'b' : 'a'); await reading;
      expect(f.response(pending, { items: [{ id: 'leak' }] })).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.requests.slice(count).map(r => r.op)).toEqual(['status', 'open', 'snapshot', 'messages', 'traces']);
      expect(f.state.person.id).toBe(boundary === 'agent' ? 'person-b' : 'person-a');
      expect(f.state.traces).toEqual([]);
      expect(f.state.tracesStale).toBe(false);
      expect(f.state.tracesLoading).toBe(false);
      expect(f.state.error).toBeNull();
      f.controller.dispose();
    }
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

  it.each(['offline', 'requestFailed', 'busy'])('retains an unknown command after a rejected %s retry', async code => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    let rejection = 'outcome_unknown';
    f.auto(r => {
      if (r.op !== 'send') return;
      f.response(r, null, { ok: false, errorCode: rejection, error: 'safe failure' });
      return false;
    });
    expect(await f.controller.command('send', 'accepted maybe')).toBe(false);
    const original = f.state.retryCommand.payload.clientMessageId;
    rejection = code;
    expect(await f.controller.command('send', '', true)).toBe(false);
    expect(f.state.retryCommand.payload.clientMessageId).toBe(original);
    expect(await f.controller.command('send', 'new ID forbidden')).toBe(false);
    f.auto();
    expect(await f.controller.command('send', '', true)).toBe(true);
    expect(f.requests.filter(r => r.op === 'send').map(r => r.payload.clientMessageId)).toEqual([original, original, original]);
    expect(f.state.retryCommand).toBeNull();
  });

  it('does not let a delayed latest page erase the final polled reply', async () => {
    vi.useFakeTimers(); const f = fixture();
    let records = Array.from({ length: 50 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1 }));
    let busy = true, delayed = null, hold = false;
    f.auto(r => {
      if (r.op === 'snapshot') return { person: { id: 'p' }, messages: records.slice(-20), nextMessagesCursor: '31', busy, episodeId: busy ? 'e1' : null };
      if (r.op === 'messages') {
        if (hold) { delayed = r; return false; }
        return { items: records, nextCursor: null };
      }
    });
    await f.controller.open('a');
    hold = true;
    const refresh = f.controller.refresh();
    await Promise.resolve(); await Promise.resolve();
    expect(delayed).toBeTruthy();
    const oldRows = records;
    records = [...records, { id: 'm51', seq: 51 }]; busy = false;
    await vi.advanceTimersByTimeAsync(51);
    expect(f.state.messages.at(-1).seq).toBe(51);
    expect(f.state.busy).toBe(false);
    f.response(delayed, { items: oldRows, nextCursor: null }); await refresh;
    expect(f.state.messages.at(-1).seq).toBe(51);
    expect(f.state.messages).toHaveLength(51);
    expect(f.state.messageCursor).toBeNull();
  });

  it('fences an older page when a newer snapshot resets a gap window', async () => {
    vi.useFakeTimers(); const f = fixture();
    let records = Array.from({ length: 80 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1 }));
    let hold = false, delayed;
    f.auto(r => {
      if (r.op === 'snapshot') return { person: { id: 'p' }, messages: records.slice(-20), nextMessagesCursor: String(records.at(-20).seq), busy: true };
      if (r.op === 'messages') {
        if (hold) { delayed = r; return false; }
        const end = r.payload.cursor ? Number(r.payload.cursor) - 1 : records.length;
        const items = records.slice(Math.max(0, end - 50), end);
        return { items, nextCursor: end > 50 ? String(items[0].seq) : null };
      }
    });
    await f.controller.open('a'); hold = true;
    const older = f.controller.page('messages', true);
    records = Array.from({ length: 160 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1 }));
    await vi.advanceTimersByTimeAsync(51);
    expect(f.state.messageCursor).toBe('141');
    f.response(delayed, { items: records.slice(0, 30), nextCursor: null }); await older;
    expect(f.state.messages).toHaveLength(20);
    expect(f.state.messageCursor).toBe('141');
    hold = false;
    while (f.state.messageCursor) await f.controller.page('messages', true);
    expect(f.state.messages.map(m => m.seq)).toEqual(records.map(m => m.seq));
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
