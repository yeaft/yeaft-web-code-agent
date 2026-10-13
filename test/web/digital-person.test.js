import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptPersonResponse, createPersonController, personState } from '../../web/stores/helpers/digital-person.js';
import { projectPersonThoughts, projectPersonJournal } from '../../web/stores/helpers/person-thoughts.js';
import { finalProposal } from '../agent/yeaft/person/fixtures.js';
import { personActivityRecords, projectPersonActivity, projectPersonFeedback } from '../../web/utils/person-activity.js';

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

  it('fences task lists and logs across Agent switches, disconnect and disposal', async () => {
    vi.useFakeTimers(); const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => ['tasks', 'task_log'].includes(r.op) ? false : undefined);
    const reading = f.controller.readTasks(); const list = f.requests.at(-1);
    const logging = f.controller.readTaskLog('private-a'); const log = f.requests.at(-1);
    await f.controller.open('b'); await Promise.all([reading, logging]);
    expect(f.response(list, { tasks: [{ id: 'private-a' }], agents: [] })).toBe(false);
    expect(f.response(log, { text: 'secret', nextOffset: 6 })).toBe(false);
    expect(f.state.tasks.tasks).toEqual([]); expect(f.state.taskLog.text).toBe('');
    f.auto(r => r.op === 'tasks' ? { tasks: [], agents: [] } : undefined);
    f.controller.showTasks(true); await vi.advanceTimersByTimeAsync(0);
    f.chat.connectionState = 'reconnecting';
    const count = f.requests.length; await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(count);
    f.controller.dispose(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(count);
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

  it('merges a slow older page during live output instead of starving scroll pagination', async () => {
    vi.useFakeTimers(); const f = fixture();
    let rows = Array.from({ length: 80 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1 }));
    let delayed;
    f.auto(r => {
      if (r.op === 'snapshot') return { person: { id: 'p' }, messages: rows.slice(-20), nextMessagesCursor: String(rows.at(-20).seq), busy: true };
      if (r.op === 'messages') {
        if (r.payload.cursor) { delayed = r; return false; }
        return { items: rows.slice(-50), nextCursor: '31' };
      }
    });
    await f.controller.open('a');
    const older = f.controller.page('messages', true);
    rows.push({ id: 'm81', seq: 81 });
    await vi.advanceTimersByTimeAsync(51);
    f.response(delayed, { items: rows.slice(0, 30), nextCursor: null }); await older;
    expect(f.state.messages.map(row => row.seq)).toEqual(rows.map(row => row.seq));
    expect(f.state.messageCursor).toBeNull();
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

  it('keeps sibling tools independent by trace ID even when model and provider IDs match', () => {
    const records = [trace(1, 'call_started', { callId: 'model' }), trace(2, 'call_output', { callId: 'model' }),
      trace(3, 'capability_started', { callId: 'trace-a', modelCallId: 'model', toolUseId: 'provider', toolIndex: 0, capability: { id: 'Recall' } }),
      trace(4, 'capability_started', { callId: 'trace-b', modelCallId: 'model', toolUseId: 'provider', toolIndex: 1, capability: { id: 'unknown' } }),
      trace(5, 'capability_result', { callId: 'trace-a', modelCallId: 'model', capability: { id: 'Recall' } })];
    const value = project(records);
    expect(value.rows.map(row => [row.id, row.status])).toEqual([['model:model', 'completed'], ['capability:trace-a', 'completed'], ['capability:trace-b', 'running']]);
    expect(value.rows[1].durationMs).toBe(2000);
    expect(project(records, { busy: false, latestEpisode: { id: 'e', status: 'completed' } }).rows[2].status).toBe('unknown');
    expect(JSON.stringify(value)).not.toContain('provider');
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
});

describe('Digital Person durable turn usage reads', () => {
  const row = seq => ({ id: `turn-${seq}`, seq, calls: [] });

  it('fences delayed turn reads on newer refresh, Agent/owner switches, and keeps failures local', async () => {
    const f = fixture(); f.auto(); await f.controller.open('a');
    f.auto(r => r.op === 'turns' ? false : undefined);
    const old = f.controller.readTurns(); const older = f.requests.at(-1);
    const fresh = f.controller.readTurns(); const newer = f.requests.at(-1);
    f.response(newer, { items: [row(2)], nextCursor: 2 }); await fresh;
    f.response(older, { items: [row(1)], nextCursor: null }); await old;
    expect(f.state.turns.items.map(r => r.seq)).toEqual([2]);
    const failed = f.controller.readTurns();
    f.response(f.requests.at(-1), null, { ok: false, error: 'Unavailable' }); await failed;
    expect(f.state.turns.stale).toBe(true); expect(f.state.error).toBeNull();
    for (const change of ['agent', 'owner']) {
      const pending = f.controller.readTurns(); const request = f.requests.at(-1);
      if (change === 'owner') f.owner('owner-b');
      f.auto(); await f.controller.open(change === 'agent' ? 'b' : 'a');
      expect(f.response(request, { items: [row(99)] })).toBe(false); await pending;
      expect(f.state.turns.items).toEqual([]);
      f.auto(r => r.op === 'turns' ? false : undefined);
    }
  });
});

describe('Person snapshot waiting feedback', () => {
  const waiting = (extra = {}) => ({ ...personState(), busy: true, episodeId: 'e', latestEpisode: {
    id: 'e', status: 'running', createdAt: 1000, feedback: { at: 61000, phase: 'model', capabilityId: 'PRIVATE_CAPABILITY' },
  }, ...extra });

  it('uses the newest substantive reply as a fence, not raw traces or unrelated history', () => {
    const state = waiting({ messages: [{ id: 'other', role: 'assistant', text: 'Other episode', episodeId: 'older', createdAt: 70000 }] });
    expect(projectPersonFeedback(state)).not.toBeNull();
    state.messages.push({ id: 'progress', role: 'assistant', replyKind: 'progress', episodeId: 'e', text: 'Verified finding', createdAt: 62000 });
    expect(projectPersonFeedback(state)).toBeNull();
    state.latestEpisode.feedback.at = 122000;
    expect(projectPersonFeedback(state)).not.toBeNull();
    state.activityRecords = personActivityRecords([{ id: 'end', episodeId: 'e', kind: 'cancelled', createdAt: 123000 }]);
    expect(projectPersonFeedback(state)).toBeNull();
  });
});

describe('Person native cognition projection', () => {
  const trace = (kind, seq, extra = {}) => ({
    id: `trace-${seq}`, episodeId: 'episode-a', kind, seq,
    createdAt: new Date(Date.UTC(2026, 8, 28, 0, 0, seq)).toISOString(), ...extra,
  });
  const output = (seq, callId, proposal, extra = {}) => trace('call_output', seq, {
    callId, output: { text: JSON.stringify(proposal), complete: true }, ...extra,
  });
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }

  it('projects exactly one cognition after native multi-tool execution, never text or tool arguments', () => {
    const proposal = finalProposal();
    const cognition = output(6, 'cognition', proposal, { output: { protocol: 'cognition', text: JSON.stringify(proposal), toolCalls: [], complete: true } });
    const activity = trace('activity', 7, { callId: 'cognition', activity: proposal.activity, decision: proposal.decision });
    const commit = trace('committed', 8, { callId: 'cognition', decision: proposal.decision });
    const records = [
      trace('call_started', 1, { callId: 'native', manifest: { protocol: 'native-tool-loop', phase: 'execution' },
        request: { messages: [{ role: 'user', content: JSON.stringify({ trigger: { kind: 'send', text: 'PRIVATE_CONTEXT' } }) }] } }),
      trace('call_output', 2, { callId: 'native', output: { protocol: 'native-tools', text: '', toolCalls: [
        { id: 'provider-a', name: 'FileWrite', input: { content: 'PRIVATE_ARGS' } },
        { id: 'provider-b', name: 'Bash', input: { command: 'PRIVATE_COMMAND' } },
      ] } }),
      trace('call_output', 3, { callId: 'prose', output: { protocol: 'native-tools', text: 'PRIVATE_EXECUTION_TEXT', toolCalls: [] } }),
      trace('call_failed', 4, { callId: 'partial', output: { protocol: 'native-tools', text: 'PRIVATE_PARTIAL', complete: false } }),
      trace('call_output', 5, { callId: 'unknown', output: { protocol: 'future-protocol', text: JSON.stringify(proposal) } }),
      cognition, activity, commit,
    ];
    const entries = projectPersonThoughts(freeze(records));
    expect(entries.map(e => e.kind)).toEqual(['thought', 'committed']);
    expect(entries[0]).toMatchObject({ callId: 'cognition', status: 'committed' });
    expect(entries[1].sections).toEqual([]);
    expect(projectPersonJournal(records)[0]).toMatchObject({ status: 'committed', history: [] });
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE_|provider-a|provider-b|FileWrite|Bash/);
    expect(projectPersonThoughts(records.slice(0, 5))).toEqual([]);
    expect(projectPersonThoughts([activity, commit])[0]).toMatchObject({ kind: 'activity', status: 'committed' });
    expect(projectPersonThoughts([cognition])[0].status).toBe('candidate');
    expect(projectPersonThoughts([cognition, { ...commit, callId: 'native' }])[0].status).toBe('candidate');
  });

  it('keeps native cognition exact across newest-first, overlapping and output-missing pages', () => {
    const proposal = finalProposal();
    const execution = trace('call_output', 1, { callId: 'native', output: { protocol: 'native-tools', text: JSON.stringify(proposal), toolCalls: [] } });
    const cognition = output(2, 'cognition', proposal, { output: { protocol: 'cognition', text: JSON.stringify(proposal), toolCalls: [] } });
    const activity = trace('activity', 3, { callId: 'cognition', activity: proposal.activity, decision: proposal.decision });
    const commit = trace('committed', 4, { callId: 'cognition', decision: proposal.decision });
    const newest = [commit, activity];
    expect(projectPersonJournal(newest)[0]).toMatchObject({ status: 'committed', history: [] });
    expect(projectPersonThoughts([execution])).toEqual([]); // Execution JSON is never a candidate.
    const merged = freeze([...newest, activity, cognition, execution, cognition]);
    expect(projectPersonThoughts(merged).map(entry => entry.kind)).toEqual(['thought', 'committed']);
    const entries = projectPersonJournal(merged);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'committed', candidateStatus: null, history: [] });
    expect(entries[0].sections.filter(section => section.label === 'activity_summary')).toHaveLength(1);
    expect(entries[0].id).toBe(projectPersonJournal(newest)[0].id);
  });
});
