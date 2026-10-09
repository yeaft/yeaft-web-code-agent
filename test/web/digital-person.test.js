import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptPersonResponse, createPersonController, digitalPersonGate, personState } from '../../web/stores/helpers/digital-person.js';
import { personActivityRecords, projectPersonActivity } from '../../web/utils/person-activity.js';

const controllers = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });
function fixture(options = {}) {
  const requests = [];
  let owner = 'owner-a';
  let responder;
  const chat = {
    digitalPersonUiEnabledByAgent: { a: true, b: true },
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
      status: { configured: true, renameSupported: true }, open: {}, receipt: { found: false },
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

  it('does not read or command a UI-disabled Person even through direct controller access', async () => {
    const f = fixture(); f.auto();
    f.chat.digitalPersonUiEnabledByAgent.a = false;
    expect(digitalPersonGate(f.chat, 'a')).toBe('disabled');
    await f.controller.open('a');
    expect(await f.controller.command('send', 'hidden')).toBe(false);
    expect(f.requests).toEqual([]);
    expect(digitalPersonGate(f.chat, 'b')).toBe('');
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

  it('fences stale search pages and inspector reads across query, Agent and owner changes', async () => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => ['search', 'inspect'].includes(r.op) ? false : undefined);
    const oldSearch = f.controller.search('old'); const old = f.requests.at(-1);
    const newSearch = f.controller.search('new'); const newer = f.requests.at(-1);
    f.response(newer, { items: [{ id: 'new-message', text: 'new' }], nextCursor: 'next' }); await newSearch;
    f.response(old, { items: [{ id: 'old-message' }], nextCursor: null }); await oldSearch;
    expect(f.state.search.items.map(r => r.id)).toEqual(['new-message']);
    const more = f.controller.search('new', true); const moreRequest = f.requests.at(-1);
    await f.controller.search('');
    f.response(moreRequest, { items: [{ id: 'late-page' }], nextCursor: null }); await more;
    expect(f.state.search.items).toEqual([]);
    const reading = f.controller.inspect('memory'); const read = f.requests.at(-1);
    await f.controller.open('b'); await reading;
    expect(f.response(read, { items: [{ id: 'private-a' }] })).toBe(false);
    expect(f.state.memory.items).toEqual([]);
    const skills = f.controller.inspect('skills'); const skillRead = f.requests.at(-1);
    f.owner('another-owner');
    expect(f.response(skillRead, { items: [{ id: 'private-skill' }] })).toBe(false);
    await f.controller.open('b'); await skills;
    expect(f.state.skills.items).toEqual([]);
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

  it('uses the returned Person identity on rename without model configuration or cognition', async () => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'settings' ? { settings: { modelCandidates: ['p/m'] }, person: { id: 'person-a', name: 'Mira', settings: { modelCandidates: ['p/m'] } } }
      : r.op === 'status' ? { configured: true, storageReady: true, modelReady: false, models: [] } : undefined);
    expect(await f.controller.settings({ name: 'Mira' })).toBe(true);
    expect(f.state.person.name).toBe('Mira');
    expect(f.state.modelCandidates).toEqual(['p/m']);
    expect(f.state.modelReady).toBe(false);
    expect(f.requests.filter(r => r.op === 'settings').at(-1).payload).toEqual({ name: 'Mira' });
    expect(f.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
  });

  it('projects model references and saves a nullable default without starting cognition', async () => {
    const f = fixture();
    const settings = { modelCandidates: ['p/a', 'p/b'], defaultModel: 'p/b' };
    const status = { configured: true, defaultModelSupported: true, models: [{ id: 'p/a' }, { id: 'p/b' }],
      ...settings, agentDefaultModel: 'p/a', effectiveDefaultModel: 'p/b', effectiveModelCandidates: ['p/a', 'p/b'] };
    f.auto(r => r.op === 'status' ? status : r.op === 'snapshot' ? { person: { id: 'person-a', settings }, messages: [], busy: false } : undefined);
    await f.controller.open('a');
    expect(f.state).toMatchObject({ defaultModelSupported: true, defaultModel: 'p/b', agentDefaultModel: 'p/a',
      effectiveDefaultModel: 'p/b', effectiveModelCandidates: ['p/a', 'p/b'] });
    f.auto(r => r.op === 'settings' ? { settings: { ...settings, defaultModel: null } } : r.op === 'status'
      ? { ...status, defaultModel: null, effectiveDefaultModel: 'p/a' } : undefined);
    expect(await f.controller.settings({ defaultModel: null })).toBe(true);
    expect(f.state.defaultModel).toBeNull();
    expect(f.state.effectiveDefaultModel).toBe('p/a');
    expect(f.requests.filter(r => r.op === 'settings').at(-1).payload).toEqual({ defaultModel: null });
    expect(f.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
    f.auto(r => r.op === 'status' ? { configured: true, models: [] } : undefined);
    await f.controller.refresh();
    expect(f.state.defaultModelSupported).toBe(false);
    expect(f.state.agentDefaultModel).toBeNull();
    expect(f.state.effectiveModelCandidates).toEqual([]);
  });

  it('keeps file references in uncertain retry and isolates model settings from cognition', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'send' ? false : r.op === 'settings' ? { settings: r.payload } : undefined);
    const pending = f.controller.command('send', '', false, [{ fileId: 'file-1', name: 'not-authoritative.txt' }]);
    await vi.advanceTimersByTimeAsync(101); expect(await pending).toBe(false);
    expect(f.state.retryCommand.payload.attachments).toEqual([{ fileId: 'file-1' }]);
    const first = f.requests.find(r => r.op === 'send');
    expect(await f.controller.settings(['p/m'])).toBe(true);
    expect(f.state.retryCommand.payload.clientMessageId).toBe(first.payload.clientMessageId);
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

  it.each([true, false])('reconciles unknown attachments while model unavailable (receipt found=%s)', async found => {
    vi.useFakeTimers();
    const reupload = vi.fn(async () => [{ fileId: 'renewed' }]);
    const f = fixture({ reupload }); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'send' ? false : undefined);
    const pending = f.controller.command('send', 'original', false, [{ fileId: 'expired', file: { name: 'x.txt' } }]);
    const originalId = f.requests.at(-1).payload.clientMessageId;
    await vi.advanceTimersByTimeAsync(101); await pending;
    f.state.modelReady = false;
    f.auto(r => r.op === 'receipt' ? { found, episodeId: 'episode-1', status: 'completed', kind: 'send', text: 'original' }
      : r.op === 'settings' ? { settings: r.payload } : r.op === 'status' ? { configured: true, modelReady: true } : undefined);
    expect(await f.controller.command('send', '', true)).toBe(found);
    expect(f.requests.find(r => r.op === 'receipt').payload.clientMessageId).toBe(originalId);
    expect(reupload).not.toHaveBeenCalled();
    expect(f.requests.filter(r => r.op === 'send')).toHaveLength(1);
    if (found) expect(f.state.retryCommand).toBeNull();
    else {
      expect(f.state.retryCommand.payload.clientMessageId).toBe(originalId);
      expect(await f.controller.settings(['p/replacement'])).toBe(true);
      f.auto(r => r.op === 'receipt' ? { found: false } : undefined);
      expect(await f.controller.command('send', '', true)).toBe(true);
      expect(reupload).toHaveBeenCalledOnce();
      expect(f.requests.filter(r => r.op === 'send').at(-1).payload.clientMessageId).toBe(originalId);
    }
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

  it('reconciles an admitted Dream whose payload has no text field', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'dream' ? false : undefined);
    const pending = f.controller.command('dream');
    await vi.advanceTimersByTimeAsync(101); await pending;
    f.auto(r => r.op === 'receipt' ? { found: true, episodeId: 'episode-1', status: 'completed', kind: 'dream', text: '' } : undefined);
    expect(await f.controller.command('dream', '', true)).toBe(true);
    expect(f.requests.filter(r => r.op === 'dream')).toHaveLength(1);
    expect(f.state.retryCommand).toBeNull();
  });

  it('refreshes history after receipt miss races with a completed duplicate admission', async () => {
    vi.useFakeTimers();
    const reupload = vi.fn(async () => [{ fileId: 'renewed' }]);
    const f = fixture({ reupload }); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'send' ? false : undefined);
    const pending = f.controller.command('send', '', false, [{ fileId: 'expired', file: { name: 'x.txt' } }]);
    const originalId = f.requests.at(-1).payload.clientMessageId;
    await vi.advanceTimersByTimeAsync(101); await pending;
    const final = { id: 'final', role: 'assistant', text: 'already completed' };
    f.auto(r => r.op === 'send' ? { duplicate: true, status: 'completed', episodeId: 'episode-1' }
      : r.op === 'messages' ? { items: [final], nextCursor: null } : undefined);
    expect(await f.controller.command('send', '', true)).toBe(true);
    expect(f.requests.filter(r => r.op === 'send').at(-1).payload.clientMessageId).toBe(originalId);
    expect(f.state.messages).toEqual([final]);
    expect(f.state.busy).toBe(false);
    expect(f.state.retryCommand).toBeNull();
    const count = f.requests.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.requests).toHaveLength(count);
  });

  it('refreshes model catalog and readiness without starting or reopening a Person', async () => {
    const f = fixture();
    let status = { configured: true, modelReady: true, availableModels: [{ ref: 'p/old' }], modelCandidates: ['p/old'] };
    f.auto(r => r.op === 'status' ? status : undefined); await f.controller.open('a');
    status = { configured: true, modelReady: false, reason: 'model_unavailable', availableModels: [{ ref: 'p/new' }], modelCandidates: ['p/old'] };
    await f.controller.refresh();
    expect(f.state.models).toEqual([{ ref: 'p/new' }]);
    expect(f.state.modelReady).toBe(false);
    status = { configured: true, modelReady: true, availableModels: [{ ref: 'p/replacement' }], modelCandidates: [] };
    await f.controller.refresh();
    expect(f.state.models).toEqual([{ ref: 'p/replacement' }]);
    expect(f.state.modelCandidates).toEqual([]);
    expect(f.state.modelReady).toBe(true);
    expect(f.requests.filter(r => r.op === 'open')).toHaveLength(1);
    expect(f.requests.filter(r => ['send', 'think', 'dream', 'settings'].includes(r.op))).toHaveLength(0);
  });

  it('fences delayed catalog refresh across Agent and owner changes', async () => {
    for (const boundary of ['agent', 'owner']) {
      const f = fixture(); f.auto(); await f.controller.open('a');
      f.auto(r => r.op === 'status' ? false : undefined);
      const refreshing = f.controller.refresh(); const delayed = f.requests.at(-1);
      if (boundary === 'owner') f.owner('owner-b');
      f.auto(r => r.op === 'status' ? { configured: true, availableModels: [{ ref: 'p/current' }] } : undefined);
      await f.controller.open(boundary === 'agent' ? 'b' : 'a'); await refreshing;
      expect(f.response(delayed, { configured: true, availableModels: [{ ref: 'p/private' }] })).toBe(false);
      expect(f.state.models).toEqual([{ ref: 'p/current' }]);
    }
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
      const cancelling = kind === 'cancelled' ? f.controller.cancel() : null;
      await vi.advanceTimersByTimeAsync(kind === 'cancelled' ? 0 : 51);
      expect(f.state.busy).toBe(false);
      expect(f.state.tracesStale).toBe(true);
      f.response(delayed, { items: more ? [older] : [latest], nextCursor: more ? null : 'older' });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.state.tracesStale).toBe(true);
      if (more) {
        // Live activity still reads the latest tail, without replacing the
        // diagnostic window the user explicitly paged into.
        const followup = f.requests.at(-1);
        expect(followup).toMatchObject({ op: 'traces', payload: { cursor: null, limit: 50 } });
        f.response(followup, { items: [latest, terminal], nextCursor: 'older' });
        await reading;
        expect(f.state.traces.map(t => t.id)).toEqual(['older', 'latest']);
        expect(f.state.traceCursor).toBeNull();
        expect(f.requests.filter(r => r.op === 'traces')).toHaveLength(3);
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
      await cancelling;
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
      await reading; await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0); // Catalog refresh precedes the snapshot request.
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
    await vi.advanceTimersByTimeAsync(0); // Wait for status, snapshot and latest-page dispatch.
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

describe('Digital Person conversation activity', () => {
  const trace = (seq, kind, extra = {}) => ({ id: `t${seq}`, episodeId: 'e', seq, kind, createdAt: seq * 1000, ...extra });
  const project = (traces, extra = {}, gate = '') => projectPersonActivity({ ...personState(), busy: true, episodeId: 'e', activityRecords: personActivityRecords(traces), ...extra }, gate);

  it('projects only execution facts and excludes private content and unrelated episodes', () => {
    const records = [trace(1, 'accepted', { trigger: { kind: 'send', text: 'PRIVATE_TEXT' } }),
      trace(2, 'call_started', { callId: 'c', request: 'PRIVATE_PROMPT' }),
      trace(3, 'call_output', { callId: 'c', output: 'PRIVATE_OUTPUT' }),
      trace(4, 'activity', { activity: { summary: 'PRIVATE_REASONING' } }),
      trace(5, 'capability_started', { callId: 'c', capability: { id: 'Recall', args: { query: 'PRIVATE_QUERY' } } }),
      trace(6, 'capability_started', { episodeId: 'another', capability: { id: 'Capability.create' } })];
    const value = project(records);
    expect(value.label).toBe('person.activity.recalling');
    expect(value.rows.map(r => r.status)).toEqual(['completed', 'running']);
    expect(value.rows[0].durationMs).toBe(1000);
    expect(value.startedAt).toBe(1000);
    expect(JSON.stringify(personActivityRecords(records))).not.toMatch(/PRIVATE_|"(?:request|output|args|summary)":/);
    expect(value.rows).toHaveLength(2);
  });

  it.each([
    ['catalog.search', 'searchingSkills'], ['catalog.view', 'readingSkill'],
    ['Skill.reconsider', 'readingMethod'], ['Skill.associate', 'readingMethod'],
    ['Capability.create', 'validatingCapability'], ['Script.sum', 'runningScript'],
    ['<img src=x>', 'usingCapability'], ['__proto__', 'usingCapability'],
  ])('uses a truthful fixed label for %s', (id, label) => {
    const value = project([trace(1, 'capability_started', { capability: { id } })]);
    expect(value.label).toBe(`person.activity.${label}`);
    expect(value.params).toEqual(id === 'Script.sum' ? { name: id } : {});
    expect(JSON.stringify(value)).not.toContain('<img');
  });

  it('does not call an invocation outcome or model output an episode success', () => {
    const events = [trace(1, 'capability_started', { callId: 'c', capability: { id: 'Recall' } }),
      trace(2, 'capability_result', { callId: 'c', capability: { id: 'Recall' } })];
    expect(project(events)).toMatchObject({ loading: true, label: 'person.activity.preparing', rows: [expect.objectContaining({ status: 'completed' })] });
    events.push(trace(3, 'call_started', { callId: 'd' }), trace(4, 'call_output', { callId: 'd' }));
    expect(project(events)).toMatchObject({ loading: true, label: 'person.activity.processingResponse' });
  });

  it.each([true, false])('shows joined tool outcome after cancellation without reviving episode success (failed=%s)', failed => {
    const events = [trace(1, 'capability_started', { callId: 'c', capability: { id: 'FileWrite', args: 'PRIVATE_ARGS' } }),
      trace(2, 'cancelled'), trace(3, 'capability_finalized', { callId: 'c', capability: { id: 'FileWrite' },
        outcome: failed ? 'capability_failed' : 'capability_result', afterTerminal: true, accepted: false,
        result: { ok: !failed, output: 'PRIVATE_OUTPUT' } })];
    const value = project(events, { busy: false, latestEpisode: { id: 'e', status: 'cancelled', endedAt: 2000 } });
    expect(value).toMatchObject({ loading: false, label: 'person.activity.cancelled', endedAt: 2000,
      rows: [expect.objectContaining({ status: failed ? 'failed' : 'completed', durationMs: 2000 })] });
    expect(JSON.stringify(personActivityRecords(events))).not.toMatch(/PRIVATE_|"(?:args|output|result)":/);
  });

  it.each(['completed', 'cancelled', 'failed', 'interrupted', 'budget_exhausted'])('fences late events with confirmed %s, including no assistant reply', status => {
    const value = project([trace(1, 'call_started', { callId: 'c' }), trace(2, 'call_failed', { callId: 'c' })], {
      busy: false, episodeId: null, latestEpisode: { id: 'e', status, endedAt: 3000 },
    });
    expect(value.loading).toBe(false);
    expect(value.label).toBe(`person.activity.${status === 'budget_exhausted' ? 'budgetExhausted' : status}`);
    expect(value.endedAt).toBe(3000);
    expect(value.rows.every(r => r.status !== 'running')).toBe(true);
  });

  it('stops pretending to know current work on stale reads or disconnection', () => {
    const records = [trace(1, 'capability_started', { capability: { id: 'Recall' } })];
    for (const state of [{ activityStale: true }, { progressStale: true }]) {
      expect(project(records, state)).toMatchObject({ label: 'person.activity.stale', loading: false, rows: [expect.objectContaining({ status: 'unknown' })] });
    }
    expect(project(records, {}, 'disconnected')).toMatchObject({ label: 'person.activity.disconnected', loading: false });
    expect(project(records, {}, 'offline').loading).toBe(false);
    expect(project(records, {}, 'disabled').visible).toBe(false);
    expect(project(records, { commandPending: true })).toMatchObject({ label: 'person.activity.confirming', rows: [] });
    expect(project(records, { busy: false, retryCommand: {} }).label).toBe('person.activity.uncertain');
    expect(project(records, { cancelPending: true }).label).toBe('person.activity.stopping');
  });

  it('does not reuse the last success for a new command with unknown admission', () => {
    const value = project([trace(1, 'committed')], {
      busy: false, episodeId: null, latestEpisode: { id: 'e', status: 'completed', endedAt: 2000 }, retryCommand: {},
    });
    expect(value).toMatchObject({ visible: true, loading: false, label: 'person.activity.uncertain', rows: [], startedAt: null, endedAt: null });
  });

  it('keeps the tail bounded and missing starts explicitly incomplete', () => {
    const records = Array.from({ length: 80 }, (_, i) => trace(i + 1, 'capability_result', { callId: `c${i}`, capability: { id: 'Recall' } }));
    const value = project(records);
    expect(personActivityRecords(records)).toHaveLength(50);
    expect(value.rows).toHaveLength(30);
    expect(value.limited).toBe(true);
    expect(value.startedAt).toBeNull();
    expect(value.rows.every(r => r.durationMs === null)).toBe(true);
  });

  it('keeps live progress current after history pagination and preserves scope on disconnect only', async () => {
    vi.useFakeTimers(); const f = fixture(); let records = [trace(1, 'accepted', { trigger: { kind: 'send' } })];
    let busy = true;
    f.auto(r => r.op === 'snapshot' ? { person: { id: 'p' }, messages: [], busy, episodeId: busy ? 'e' : null, latestEpisode: { id: 'e', status: busy ? 'running' : 'completed' } }
      : r.op === 'traces' ? { items: r.payload.cursor ? [trace(0, 'accepted', { episodeId: 'old' })] : records, nextCursor: r.payload.cursor ? null : 'older' } : undefined);
    await f.controller.open('a'); await f.controller.page('traces', true);
    const historical = [...f.state.traces];
    records = [...records, trace(2, 'capability_started', { callId: 'c', capability: { id: 'Recall', args: 'PRIVATE' } })];
    await vi.advanceTimersByTimeAsync(51);
    expect(projectPersonActivity(f.state).label).toBe('person.activity.recalling');
    expect(f.state.traces).toEqual(historical);
    expect(f.state.tracesStale).toBe(true);
    expect(f.state.activityStale).toBe(false);
    f.chat.connectionState = 'reconnecting'; await f.controller.open('a');
    expect(projectPersonActivity(f.state, 'disconnected')).toMatchObject({ visible: true, loading: false, label: 'person.activity.disconnected' });
    expect(f.state.traces).toEqual([]);
    expect(JSON.stringify(f.state.activityRecords)).not.toContain('PRIVATE');
    f.owner('other'); await f.controller.open('a');
    expect(f.state.activityRecords).toEqual([]);
    expect(f.state.busy).toBe(false);
    f.chat.connectionState = 'connected'; busy = false; await f.controller.open('a');
    expect(projectPersonActivity(f.state)).toMatchObject({ loading: false, label: 'person.activity.completed' });
  });

  it('refreshes live progress while a slow history page is still pending', async () => {
    vi.useFakeTimers(); const f = fixture({ timeoutMs: 1000 }); let history;
    let records = [trace(1, 'capability_started', { callId: 'c', capability: { id: 'Recall' } })];
    f.auto(r => {
      if (r.op === 'snapshot') return { person: { id: 'p' }, busy: true, episodeId: 'e' };
      if (r.op === 'traces' && r.payload.cursor) { history = r; return false; }
      if (r.op === 'traces') return { items: records, nextCursor: 'older' };
    });
    await f.controller.open('a');
    const historical = [...f.state.traces];
    const reading = f.controller.page('traces', true);
    records = [...records, trace(2, 'capability_result', { callId: 'c', capability: { id: 'Recall' } }),
      trace(3, 'capability_started', { callId: 'd', capability: { id: 'Script.sum' } })];
    await vi.advanceTimersByTimeAsync(51);
    expect(f.state.tracesLoading).toBe(true);
    expect(f.state.traces).toEqual(historical);
    expect(projectPersonActivity(f.state)).toMatchObject({ label: 'person.activity.runningScript', loading: true });
    f.response(history, { items: [trace(0, 'committed', { episodeId: 'old' })], nextCursor: null });
    await reading;
    expect(f.state.traces).toHaveLength(2);
    expect(f.state.activityRecords).toHaveLength(3);
    expect(projectPersonActivity(f.state).label).toBe('person.activity.runningScript');
  });

  it('marks an explicit snapshot failure stale, recovers, and ignores an older failed snapshot', async () => {
    vi.useFakeTimers(); const f = fixture(); let fail = false; let delayed;
    const snapshot = { person: { id: 'p' }, busy: true, episodeId: 'e' };
    f.auto(r => {
      if (r.op === 'snapshot' && fail) { f.response(r, null, { ok: false, errorCode: 'requestFailed' }); return false; }
      if (r.op === 'snapshot') return snapshot;
      if (r.op === 'traces') return { items: [trace(1, 'call_started', { callId: 'c' })] };
    });
    await f.controller.open('a'); fail = true; await f.controller.refresh();
    expect(projectPersonActivity(f.state)).toMatchObject({ label: 'person.activity.stale', loading: false });
    fail = false; await f.controller.refresh();
    expect(f.state.progressStale).toBe(false);
    f.auto(r => r.op === 'snapshot' ? (delayed = r, false) : undefined);
    await vi.advanceTimersByTimeAsync(51);
    const old = delayed;
    const refreshing = f.controller.refresh(); await vi.advanceTimersByTimeAsync(0);
    f.response(delayed, snapshot); await refreshing;
    f.response(old, null, { ok: false, errorCode: 'requestFailed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.progressStale).toBe(false);
    expect(f.state.error).toBeNull();
  });

  it('fences concurrent live tails against late success, failure and identity changes', async () => {
    vi.useFakeTimers();
    for (const result of ['success', 'failure', 'owner', 'agent']) {
      const f = fixture();
      f.auto(r => r.op === 'snapshot' ? { person: { id: 'p' }, busy: true, episodeId: 'e' }
        : r.op === 'traces' ? { items: [], nextCursor: 'older' } : undefined);
      await f.controller.open('a'); await f.controller.page('traces', true);
      f.auto(r => r.op === 'traces' ? false : r.op === 'snapshot' ? { person: { id: 'p' }, busy: true, episodeId: 'e' } : undefined);
      await vi.advanceTimersByTimeAsync(51);
      const older = f.requests.at(-1);
      const refreshing = f.controller.refresh({ preserveHistory: true }); await vi.advanceTimersByTimeAsync(0);
      const latest = f.requests.at(-1);
      expect(latest.requestId).not.toBe(older.requestId);
      f.response(latest, { items: [trace(3, 'capability_started', { callId: 'd', capability: { id: 'Script.sum' } })] });
      await refreshing;
      if (['owner', 'agent'].includes(result)) {
        if (result === 'owner') f.owner('new-owner');
        f.auto(); await f.controller.open(result === 'agent' ? 'b' : 'a');
      }
      f.response(older, { items: [trace(1, 'call_started')] }, result === 'failure' ? { ok: false, errorCode: 'requestFailed' } : {});
      await vi.advanceTimersByTimeAsync(0);
      expect(f.state.activityStale).toBe(false); expect(f.state.error).toBeNull();
      if (['owner', 'agent'].includes(result)) expect(f.state.activityRecords).toEqual([]);
      else expect(projectPersonActivity(f.state).label).toBe('person.activity.runningScript');
      f.controller.dispose();
    }
  });

  it('marks progress stale after a failed tail/snapshot and recovers automatically without cognition', async () => {
    vi.useFakeTimers(); const f = fixture(); let fail = '';
    f.auto(r => {
      if (r.op === fail) { f.response(r, null, { ok: false, error: 'Unavailable' }); return false; }
      if (r.op === 'snapshot') return { person: { id: 'p' }, busy: true, episodeId: 'e' };
      if (r.op === 'traces') return { items: [trace(1, 'capability_started', { capability: { id: 'Recall' } })], nextCursor: null };
    });
    await f.controller.open('a');
    for (const op of ['traces', 'snapshot']) {
      fail = op; await vi.advanceTimersByTimeAsync(51);
      expect(projectPersonActivity(f.state)).toMatchObject({ loading: false, label: 'person.activity.stale' });
      fail = ''; await vi.advanceTimersByTimeAsync(51);
      expect(projectPersonActivity(f.state)).toMatchObject({ loading: true, label: 'person.activity.recalling' });
    }
    expect(f.requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
  });
});
