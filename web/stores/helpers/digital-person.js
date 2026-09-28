/** Digital Person is an owner + Agent resource, never a hidden Session.
 * Request correlation lives outside Pinia serialization. No command is retried
 * automatically; an uncertain command keeps its original clientMessageId.
 */
const channels = new WeakMap();
const outboxes = new WeakMap();
const PAGE_SIZE = 50;
const id = () => globalThis.crypto.randomUUID();
const failure = code => Object.assign(new Error(code), { code });

export function digitalPersonGate(chat, agentId) {
  if (!agentId) return 'noAgent';
  if (chat.connectionState !== 'connected' || !chat.authenticated) return 'disconnected';
  const agent = chat.agents.find(row => row.id === agentId);
  if (!agent?.online) return 'offline';
  if (!agent.capabilities?.includes('digital_person')) return 'unsupported';
  return '';
}

export function acceptPersonResponse(chat, message) {
  const pending = channels.get(chat)?.get(message.requestId);
  if (!pending || message.agentId !== pending.agentId || message.op !== pending.op) return false;
  if (!pending.current()) return false;
  pending.finish();
  if (message.ok === true) pending.resolve(message.data);
  else {
    const detail = typeof message.error === 'string' ? message.error : message.error?.message;
    pending.reject(Object.assign(new Error(detail || 'requestFailed'), {
      code: message.error?.code || 'requestFailed',
    }));
  }
  return true;
}

export function personState() {
  return {
    loading: false, configured: null, reason: '', person: null, state: null,
    messages: [], traces: [], busy: false, episodeId: null, error: null,
    messageCursor: null, traceCursor: null, messagesLoading: false, tracesLoading: false,
    commandPending: false, cancelPending: false, retryCommand: null, tracesStale: false,
  };
}

function mergeRows(previous, next) {
  const rows = new Map(previous.map(row => [row.id, row]));
  for (const row of next || []) if (row?.id) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => {
    const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return Number.isFinite(delta) && delta !== 0 ? delta : String(a.id).localeCompare(String(b.id));
  });
}

/** `scope` is the current authenticated browser identity, not a wire owner ID.
 * The Server owns authorization; no owner supplied by this client is trusted.
 */
export function createPersonController({ chat, state, scope, timeoutMs = 30_000, pollMs = 1500 }) {
  if (!channels.has(chat)) channels.set(chat, new Map());
  let generation = 0;
  let agentId = '';
  let activeScope = '';
  let poll = null;
  let polling = false;
  let snapshotRequest = 0;
  let tracePaged = false;
  let disposed = false;
  const owned = new Set();
  const current = (g = generation) => !disposed && g === generation && activeScope === scope();
  const outbox = () => {
    let record = outboxes.get(chat);
    if (!record || record.scope !== scope()) {
      record = { scope: scope(), commands: new Map() };
      outboxes.set(chat, record);
    }
    return record.commands;
  };
  const showError = error => { state.error = { code: error.code || 'requestFailed', message: error.message }; };

  function request(op, payload = {}) {
    const g = generation;
    if (!current(g)) return Promise.reject(failure('stale'));
    const gate = digitalPersonGate(chat, agentId);
    if (gate) return Promise.reject(failure(gate));
    const requestId = `person-${id()}`;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        channels.get(chat).delete(requestId);
        owned.delete(requestId);
      };
      const timer = setTimeout(() => { finish(); reject(failure('timeout')); }, timeoutMs);
      channels.get(chat).set(requestId, {
        agentId, op, current: () => current(g), finish, resolve, reject,
      });
      owned.add(requestId);
      if (!chat.sendWsMessage({ type: 'person_request', agentId, requestId, op, payload })) {
        finish();
        reject(failure('disconnected'));
      }
    });
  }

  function reset(nextAgentId = '') {
    generation += 1;
    clearTimeout(poll);
    poll = null;
    polling = false;
    for (const requestId of owned) {
      const pending = channels.get(chat).get(requestId);
      pending?.finish();
      pending?.reject(failure('stale'));
    }
    agentId = nextAgentId;
    activeScope = scope();
    tracePaged = false;
    Object.assign(state, personState(), { retryCommand: outbox().get(agentId) || null });
  }

  async function snapshot() {
    const g = generation;
    const requestNumber = ++snapshotRequest;
    const data = await request('snapshot');
    if (!current(g) || requestNumber !== snapshotRequest) return;
    state.person = data.person;
    state.state = data.state;
    state.messages = mergeRows(state.messages, data.messages);
    state.busy = data.busy === true;
    state.episodeId = data.episodeId || null;
  }

  async function page(kind, more = false) {
    const g = generation;
    const loadingKey = kind === 'messages' ? 'messagesLoading' : 'tracesLoading';
    const cursorKey = kind === 'messages' ? 'messageCursor' : 'traceCursor';
    if (state[loadingKey] || (more && state[cursorKey] == null)) return;
    state[loadingKey] = true;
    try {
      const data = await request(kind, { cursor: more ? state[cursorKey] : null, limit: PAGE_SIZE });
      if (!current(g)) return;
      state[kind] = mergeRows(more || kind === 'messages' ? state[kind] : [], data.items);
      state[cursorKey] = data.nextCursor ?? null;
      if (kind === 'traces') {
        tracePaged = more;
        state.tracesStale = false;
      }
    } catch (error) {
      if (current(g)) showError(error);
    } finally {
      if (current(g)) state[loadingKey] = false;
    }
  }

  function schedule() {
    clearTimeout(poll);
    if (!current() || !state.busy || digitalPersonGate(chat, agentId)) return;
    const g = generation;
    poll = setTimeout(async () => {
      if (!current(g) || polling) return;
      polling = true;
      try {
        await snapshot();
        if (!current(g)) return;
        if (!tracePaged) await page('traces');
        else state.tracesStale = true;
      } catch (error) {
        if (current(g)) showError(error);
      } finally {
        if (current(g)) { polling = false; schedule(); }
      }
    }, pollMs);
  }

  async function open(nextAgentId) {
    reset(nextAgentId);
    if (digitalPersonGate(chat, agentId)) return;
    const g = generation;
    state.loading = true;
    try {
      const status = await request('status');
      if (!current(g)) return;
      state.configured = status.configured === true;
      state.reason = status.reason || '';
      if (!state.configured) return;
      await request('open');
      if (!current(g)) return;
      await snapshot();
      if (!current(g)) return;
      await Promise.all([page('messages'), page('traces')]);
      if (current(g)) schedule();
    } catch (error) {
      if (current(g)) showError(error);
    } finally {
      if (current(g)) state.loading = false;
    }
  }

  async function refresh() {
    if (!state.person) return open(agentId);
    const g = generation;
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    try {
      await snapshot();
      if (current(g)) await page('traces');
    } catch (error) {
      if (current(g)) showError(error);
    } finally {
      if (current(g)) { state.loading = false; schedule(); }
    }
  }

  async function command(op, text = '', retry = false) {
    if (state.commandPending || state.loading || !state.person || !state.configured || digitalPersonGate(chat, agentId)) return false;
    if (state.retryCommand && !retry) return false;
    if (!retry && (state.busy || (op === 'send' && !text.trim()))) return false;
    const envelope = retry ? state.retryCommand : {
      op, payload: { ...(op === 'dream' ? {} : { text: text.trim() }), clientMessageId: id() },
    };
    if (!envelope) return false;
    const g = generation;
    outbox().set(agentId, envelope);
    state.retryCommand = envelope;
    state.commandPending = true;
    state.error = null;
    try {
      const data = await request(envelope.op, envelope.payload);
      if (!current(g)) return false;
      outbox().delete(agentId);
      state.retryCommand = null;
      snapshotRequest += 1; // An older in-flight idle snapshot cannot undo this acknowledgement.
      state.episodeId = data.episodeId || null;
      state.busy = true;
      // Poll rather than treating the acknowledgement as a completed model turn.
      schedule();
      return true;
    } catch (error) {
      if (current(g)) {
        if (!['timeout', 'disconnected', 'stale'].includes(error.code)) {
          outbox().delete(agentId);
          state.retryCommand = null;
        }
        showError(error);
      }
      return false;
    } finally {
      if (current(g)) state.commandPending = false;
    }
  }

  async function cancel() {
    if (state.cancelPending || !state.busy) return;
    const g = generation;
    state.cancelPending = true;
    try {
      await request('cancel');
      if (current(g)) await refresh();
    } catch (error) {
      if (current(g)) showError(error);
    } finally {
      if (current(g)) state.cancelPending = false;
    }
  }

  return {
    open, refresh, command, cancel, page,
    discardRetry() { outbox().delete(agentId); state.retryCommand = null; },
    dispose() { reset(); disposed = true; },
  };
}
