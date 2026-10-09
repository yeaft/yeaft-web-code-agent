/** Digital Person is an owner + Agent resource, never a hidden Session.
 * Request correlation lives outside Pinia serialization. No command is retried
 * automatically; an uncertain command keeps its original clientMessageId.
 */
import { personActivityRecords } from '../../utils/person-activity.js';

const channels = new WeakMap();
const outboxes = new WeakMap();
const PAGE_SIZE = 50;
const id = () => globalThis.crypto.randomUUID();
const failure = code => Object.assign(new Error(code), { code });

export function digitalPersonGate(chat, agentId) {
  if (!agentId) return 'noAgent';
  if (!Object.hasOwn(chat.digitalPersonUiEnabledByAgent || {}, agentId)
    || chat.digitalPersonUiEnabledByAgent[agentId] !== true) return 'disabled';
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
      code: message.errorCode || message.error?.code || 'requestFailed',
    }));
  }
  return true;
}

const inspectionPage = () => ({ items: [], nextCursor: null, loading: false, loaded: false, error: null });

export function personState() {
  return {
    loading: false, configured: null, storageReady: null, modelReady: null, reason: '', person: null, state: null, latestEpisode: null,
    messages: [], traces: [], busy: false, episodeId: null, error: null,
    messageCursor: null, traceCursor: null, messagesLoading: false, tracesLoading: false,
    commandPending: false, commandEpisodeId: null, cancelPending: false, retryCommand: null, tracesStale: false,
    activityRecords: [], activityEpisodeId: null, activityStale: false, progressStale: false,
    models: [], modelCandidates: [], effectiveModelCandidates: [], defaultModel: null,
    agentDefaultModel: null, effectiveDefaultModel: null, defaultModelSupported: false,
    settingsPending: false, renameSupported: false,
    memory: inspectionPage(), skills: inspectionPage(), search: { ...inspectionPage(), query: '' },
    tasks: { tasks: [], agents: [], loaded: false, loading: false, stale: false, error: null, pending: null },
    taskLog: { taskId: '', text: '', nextOffset: 0, loading: false, error: null },
  };
}

function mergeRows(previous, next) {
  const rows = new Map(previous.map(row => [row.id, row]));
  for (const row of next || []) if (row?.id) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => {
    if (Number.isSafeInteger(a.seq) && Number.isSafeInteger(b.seq)) return a.seq - b.seq;
    const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return Number.isFinite(delta) && delta !== 0 ? delta : String(a.id).localeCompare(String(b.id));
  });
}

/** `scope` is the current authenticated browser identity, not a wire owner ID.
 * The Server owns authorization; no owner supplied by this client is trusted.
 */
export function createPersonController({ chat, state, scope, timeoutMs = 30_000, pollMs = 1500, reupload = null }) {
  if (!channels.has(chat)) channels.set(chat, new Map());
  let generation = 0;
  let agentId = '';
  let activeScope = '';
  let poll = null;
  let polling = false;
  let snapshotRequest = 0;
  let messageWindowVersion = 0;
  let tracePaged = false;
  let traceHistoryLoading = false;
  let activityRequest = 0;
  let traceRefreshVersion = 0;
  let queuedTraceRefresh = null;
  let disposed = false;
  let tasksVisible = false;
  let taskPoll = null;
  let tasksRequest = 0;
  const owned = new Set();
  const current = (g = generation) => !disposed && g === generation && activeScope === scope();
  const outbox = () => {
    let record = outboxes.get(chat);
    if (!record || record.scope !== scope()) {
      record = { scope: scope(), commands: new Map(), files: new Map() };
      outboxes.set(chat, record);
    }
    return record.commands;
  };
  const retainedFiles = () => { outbox(); return outboxes.get(chat).files; };
  const showError = error => { state.error = { code: error.code || 'requestFailed', message: error.message }; };

  function applyModelStatus(status) {
    state.renameSupported = status.renameSupported === true;
    state.defaultModelSupported = status.defaultModelSupported === true;
    state.models = status.availableModels || status.models || [];
    if (Array.isArray(status.modelCandidates)) state.modelCandidates = status.modelCandidates;
    if (Object.hasOwn(status, 'defaultModel')) state.defaultModel = status.defaultModel ?? null;
    state.agentDefaultModel = status.agentDefaultModel ?? null;
    state.effectiveDefaultModel = status.effectiveDefaultModel ?? null;
    state.effectiveModelCandidates = status.effectiveModelCandidates || [];
  }

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
    // Keep only allowlisted progress while this same identity is unreachable.
    // Disconnect does not cancel Agent work; never transfer it to another owner.
    const unavailable = ['disconnected', 'offline'].includes(digitalPersonGate(chat, nextAgentId));
    const progress = nextAgentId === agentId && activeScope === scope() && unavailable ? {
      activityRecords: state.activityRecords, activityEpisodeId: state.episodeId || state.activityEpisodeId,
      latestEpisode: state.latestEpisode, busy: state.busy, activityStale: true, progressStale: true,
    } : {};
    generation += 1;
    clearTimeout(poll);
    clearTimeout(taskPoll);
    taskPoll = null;
    tasksRequest += 1;
    tasksVisible = false;
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
    traceHistoryLoading = false;
    activityRequest += 1;
    traceRefreshVersion = 0;
    queuedTraceRefresh = null;
    Object.assign(state, personState(), progress, { retryCommand: outbox().get(agentId) || null });
  }

  async function snapshot() {
    const g = generation;
    const requestNumber = ++snapshotRequest;
    let data;
    try { data = await request('snapshot'); }
    catch (error) {
      if (!current(g) || requestNumber !== snapshotRequest) return;
      state.progressStale = true;
      throw error;
    }
    if (!current(g) || requestNumber !== snapshotRequest) return;
    state.person = data.person;
    state.modelCandidates = data.person?.settings?.modelCandidates || [];
    state.defaultModel = data.person?.settings?.defaultModel ?? null;
    state.state = data.state;
    state.latestEpisode = data.latestEpisode || null;
    const incoming = data.messages || [];
    const lastSeq = state.messages.at(-1)?.seq;
    const firstSeq = incoming[0]?.seq;
    // A remote tab may have produced more than the snapshot window. Restart a
    // contiguous pagination chain rather than leaving an unreachable middle gap.
    if (!state.messages.length || (Number.isSafeInteger(firstSeq) && Number.isSafeInteger(lastSeq) && firstSeq > lastSeq + 1)) {
      messageWindowVersion += 1;
      state.messages = mergeRows([], incoming);
      state.messageCursor = data.nextMessagesCursor ?? null;
    } else {
      // Any newly observed tail invalidates an older page read, even without a
      // gap. Otherwise a delayed latest page could erase a completed reply after
      // polling has stopped. An invalidated older page can be requested again.
      const existing = new Set(state.messages.map(row => row.id));
      if (incoming.some(row => !existing.has(row.id))) messageWindowVersion += 1;
      state.messages = mergeRows(state.messages, incoming);
    }
    state.busy = data.busy === true;
    state.episodeId = data.episodeId || null;
    state.activityEpisodeId = state.episodeId || state.latestEpisode?.id || state.activityEpisodeId;
    state.progressStale = false;
  }

  // Automatic activity reads must not wait for a slow diagnostic-history page.
  // They own no history cursor/window and share a latest-request fence with
  // ordinary latest reads so an older response cannot overwrite live progress.
  async function activityTail() {
    const g = generation;
    const requestNumber = ++activityRequest;
    try {
      const data = await request('traces', { cursor: null, limit: PAGE_SIZE });
      if (!current(g) || requestNumber !== activityRequest) return;
      state.activityRecords = personActivityRecords(data.items);
      state.activityStale = false;
    } catch (error) {
      if (!current(g) || requestNumber !== activityRequest) return;
      state.activityStale = true;
      showError(error);
    }
  }

  async function page(kind, more = false, { preserveHistory = false } = {}) {
    const g = generation;
    if (!current(g)) return;
    const loadingKey = kind === 'messages' ? 'messagesLoading' : 'tracesLoading';
    const cursorKey = kind === 'messages' ? 'messageCursor' : 'traceCursor';
    if (kind === 'traces' && !more) {
      traceRefreshVersion += 1;
      state.tracesStale = true;
      if (preserveHistory && (tracePaged || traceHistoryLoading)) return activityTail();
      if (state.tracesLoading) {
        // Coalesce newer demands, but never let an automatic poll override an
        // explicit refresh. An in-flight pre-terminal read cannot satisfy them.
        if (!queuedTraceRefresh || !preserveHistory) queuedTraceRefresh = { preserveHistory };
        return;
      }
    }
    if (state[loadingKey] || (more && state[cursorKey] == null)) return;
    state[loadingKey] = true;
    if (kind === 'traces' && more) traceHistoryLoading = true;
    const activityVersion = kind === 'traces' && !more ? ++activityRequest : null;
    const traceVersion = traceRefreshVersion;
    const windowVersion = kind === 'messages' && !more ? ++messageWindowVersion : messageWindowVersion;
    try {
      const data = await request(kind, { cursor: more ? state[cursorKey] : null, limit: PAGE_SIZE });
      if (!current(g) || (kind === 'messages' && windowVersion !== messageWindowVersion)) return;
      const keepTraceWindow = kind === 'traces' && !more && preserveHistory && tracePaged;
      if (!keepTraceWindow) {
        state[kind] = mergeRows(more ? state[kind] : [], data.items);
        state[cursorKey] = data.nextCursor ?? null;
      }
      if (kind === 'traces' && !more && activityVersion === activityRequest && traceVersion === traceRefreshVersion) {
        state.activityRecords = personActivityRecords(data.items);
        state.activityStale = false;
      }
      if (kind === 'traces' && !keepTraceWindow) {
        tracePaged = more;
        // Older pages extend history, not our knowledge of the latest tail.
        if (!more && traceVersion === traceRefreshVersion) state.tracesStale = false;
      }
    } catch (error) {
      if (current(g)) {
        if (kind === 'traces' && !more && activityVersion === activityRequest) state.activityStale = true;
        showError(error);
      }
    } finally {
      if (current(g)) {
        state[loadingKey] = false;
        if (kind === 'traces' && more) traceHistoryLoading = false;
        if (kind === 'traces' && queuedTraceRefresh) {
          const queued = queuedTraceRefresh;
          queuedTraceRefresh = null;
          // Consume once, even on failure. Recheck history after an older page
          // settles so polling cannot silently replace newly paged records.
          await page('traces', false, queued);
        }
      }
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
        await page('traces', false, { preserveHistory: true });
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
      state.storageReady = status.storageReady !== false;
      state.modelReady = status.modelReady !== false;
      state.reason = status.reason || '';
      applyModelStatus(status);
      if (!state.configured || !state.storageReady) return;
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

  async function refresh({ preserveHistory = false } = {}) {
    if (!state.person || state.storageReady === false) return open(agentId);
    const g = generation;
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    try {
      const status = await request('status');
      if (!current(g)) return;
      state.configured = status.configured === true;
      state.storageReady = status.storageReady !== false;
      state.modelReady = status.modelReady !== false;
      state.reason = status.reason || '';
      applyModelStatus(status);
      if (!state.configured || !state.storageReady) return;
      await snapshot();
      if (current(g)) await Promise.all([page('messages'), page('traces', false, { preserveHistory })]);
    } catch (error) {
      if (current(g)) showError(error);
    } finally {
      if (current(g)) { state.loading = false; schedule(); }
    }
  }

  async function command(op, text = '', retry = false, attachments = []) {
    // Read-only receipt reconciliation must remain available when the selected model disappears.
    if (state.settingsPending || state.commandPending || state.loading || !state.person || (!retry && (!state.configured || state.modelReady === false)) || digitalPersonGate(chat, agentId)) return false;
    if (state.retryCommand && !retry) return false;
    if (!retry && (state.busy || (op === 'send' && !text.trim() && !attachments.length))) return false;
    const envelope = retry ? state.retryCommand : {
      op, payload: { ...(op === 'dream' ? {} : { text: text.trim(), ...(attachments.length ? { attachments: attachments.map(({ fileId }) => ({ fileId })) } : {}) }), clientMessageId: id() },
    };
    if (!envelope) return false;
    const g = generation;
    if (!retry) retainedFiles().set(agentId, attachments.map(row => row.file).filter(Boolean));
    outbox().set(agentId, envelope);
    state.retryCommand = envelope;
    state.commandPending = true;
    state.commandEpisodeId = null;
    state.error = null;
    try {
      let data;
      const hasFiles = !!envelope.payload.attachments?.length;
      const renew = async () => {
        const files = retainedFiles().get(agentId);
        if (!reupload || files?.length !== envelope.payload.attachments.length) throw failure('attachment_expired');
        const refs = await reupload(files);
        if (!current(g)) throw failure('stale');
        envelope.payload = { ...envelope.payload, attachments: refs.map(({ fileId }) => ({ fileId })) };
      };
      if (retry) {
        const receipt = await request('receipt', { clientMessageId: envelope.payload.clientMessageId });
        if (!current(g)) return false;
        if (receipt.found) {
          if (receipt.kind !== envelope.op || receipt.text !== (envelope.payload.text ?? '')) throw failure('idempotency_conflict');
          data = receipt;
        } else {
          if (!state.configured || state.modelReady === false) throw failure('model_unavailable');
          if (hasFiles && reupload) await renew();
        }
      }
      if (!data) {
        try { data = await request(envelope.op, envelope.payload); }
        catch (error) {
          if (error.code !== 'attachment_expired' || !hasFiles || !reupload || !current(g)) throw error;
          await renew();
          data = await request(envelope.op, envelope.payload);
        }
      }
      if (!current(g)) return false;
      outbox().delete(agentId);
      retainedFiles().delete(agentId);
      state.retryCommand = null;
      snapshotRequest += 1; // An older in-flight idle snapshot cannot undo this acknowledgement.
      // Receipt reconciliation refreshes live activity below; keep the original
      // command identity separate so another tab's newer episode cannot replace it.
      state.commandEpisodeId = data.episodeId || null;
      state.episodeId = state.commandEpisodeId;
      state.activityEpisodeId = state.episodeId;
      state.activityStale = false;
      state.progressStale = false;
      state.busy = !data.status || ['accepted', 'running'].includes(data.status);
      // Poll rather than treating the acknowledgement as a completed model turn.
      schedule();
      if (data.found || !state.busy) await refresh({ preserveHistory: true });
      return true;
    } catch (error) {
      if (current(g)) {
        // A rejected retry says nothing about the original unknown admission.
        // Only an acknowledgement (or explicit discard) resolves that envelope.
        if (!retry && !['timeout', 'outcome_unknown', 'disconnected', 'stale'].includes(error.code)) {
          outbox().delete(agentId);
          retainedFiles().delete(agentId);
          state.retryCommand = null;
        }
        showError(error);
      }
      return false;
    } finally {
      if (current(g)) state.commandPending = false;
    }
  }

  // Each result page belongs to this identity and query, never to the chat window.
  // Replacing a query invalidates pending responses without blocking a newer read.
  async function inspect(section, more = false) {
    if (!['memory', 'skills'].includes(section)) return;
    return readPage(section, 'inspect', { section }, more);
  }
  async function search(query, more = false) {
    const value = typeof query === 'string' ? query.trim() : '';
    if (more && value !== state.search.query) return;
    return readPage('search', 'search', { query: value }, more);
  }
  async function readPage(key, op, payload, more) {
    if (!current()) return;
    // Invalidation is local, not a network operation: edits during refresh or
    // disconnect must fence an older response even when no new read can start.
    if (!more) state[key] = { ...inspectionPage(), ...(key === 'search' ? { query: payload.query } : {}) };
    if (!state.person || state.loading || digitalPersonGate(chat, agentId)) return;
    if (more && (state[key].loading || state[key].nextCursor == null)) return;
    const target = state[key];
    if (key === 'search' && !payload.query) return;
    const g = generation;
    target.loading = true;
    target.error = null;
    try {
      const data = await request(op, { ...payload, cursor: more ? target.nextCursor : null, limit: 20 });
      if (!current(g) || target !== state[key]) return;
      target.items = more ? [...new Map([...target.items, ...data.items].map(row => [row.id, row])).values()] : data.items;
      target.nextCursor = data.nextCursor ?? null;
      target.loaded = true;
    } catch (error) {
      if (current(g) && target === state[key]) target.error = { code: error.code, message: error.message };
    } finally {
      if (current(g) && target === state[key]) target.loading = false;
    }
  }

  // Inspection is Person-scoped, independent of the current message/episode and
  // model readiness. Poll only while its drawer is visible, including idle cognition.
  function scheduleTasks() {
    clearTimeout(taskPoll);
    if (!tasksVisible || !current() || digitalPersonGate(chat, agentId)) return;
    const g = generation;
    taskPoll = setTimeout(() => { if (current(g)) void readTasks(); }, pollMs);
  }
  function showTasks(visible) {
    tasksVisible = visible;
    clearTimeout(taskPoll);
    if (visible && !state.loading) void readTasks();
  }
  async function readTasks() {
    if (!current() || !state.person || state.loading || digitalPersonGate(chat, agentId) || state.tasks.loading) return;
    const g = generation;
    const number = ++tasksRequest;
    state.tasks.loading = true;
    state.tasks.error = null;
    try {
      const data = await request('tasks');
      if (!current(g) || number !== tasksRequest) return;
      state.tasks.tasks = data.tasks || [];
      state.tasks.agents = data.agents || [];
      state.tasks.truncated = data.truncated === true;
      state.tasks.loaded = true;
      state.tasks.stale = false;
    } catch (error) {
      if (current(g) && number === tasksRequest) {
        state.tasks.stale = true;
        state.tasks.error = { code: error.code, message: error.message };
      }
    } finally {
      if (current(g) && number === tasksRequest) { state.tasks.loading = false; scheduleTasks(); }
    }
  }
  async function readTaskLog(taskId, more = false) {
    if (!current() || !state.person || state.loading || digitalPersonGate(chat, agentId)) return;
    if (more && (state.taskLog.taskId !== taskId || state.taskLog.loading)) return;
    if (!more) state.taskLog = { taskId, text: '', nextOffset: 0, loading: false, error: null };
    const target = state.taskLog;
    const g = generation;
    target.loading = true;
    target.error = null;
    try {
      const data = await request('task_log', { taskId, offset: more ? target.nextOffset : 0, maxBytes: 32768 });
      if (!current(g) || state.taskLog !== target) return;
      // UI budget is independent of the raw durable log; keep the newest 64 KiB.
      target.text = (more ? target.text + data.text : data.text).slice(-65536);
      target.nextOffset = data.nextOffset;
    } catch (error) {
      if (current(g) && state.taskLog === target) target.error = { code: error.code, message: error.message };
    } finally {
      if (current(g) && state.taskLog === target) target.loading = false;
    }
  }
  async function stopTask(kind, taskId) {
    if (!current() || !state.person || state.loading || digitalPersonGate(chat, agentId) || state.tasks.pending) return false;
    const g = generation;
    state.tasks.pending = taskId;
    state.tasks.error = null;
    try {
      await request(kind === 'agent' ? 'agent_close' : 'task_cancel', kind === 'agent' ? { agentId: taskId } : { taskId });
      if (!current(g)) return false;
      // Fence older list responses, then read the actual post-cancellation state.
      tasksRequest += 1;
      state.tasks.loading = false;
      await readTasks();
      return true;
    } catch (error) {
      if (current(g)) { state.tasks.stale = true; state.tasks.error = { code: error.code, message: error.message }; }
      return false;
    } finally { if (current(g)) state.tasks.pending = null; }
  }

  async function settings(update) {
    if (!current() || state.settingsPending || state.loading || state.busy || state.commandPending || !state.person || digitalPersonGate(chat, agentId)) return false;
    const g = generation;
    state.settingsPending = true;
    state.error = null;
    try {
      const payload = Array.isArray(update) ? { modelCandidates: [...update] } : update;
      const result = await request('settings', payload);
      if (!current(g)) return false;
      state.modelCandidates = result.settings.modelCandidates || [];
      state.defaultModel = result.settings.defaultModel ?? null;
      state.person.settings = result.settings;
      if (result.person?.id === state.person.id) state.person = result.person;
      snapshotRequest += 1; // Fence an older snapshot from undoing a successful rename.
      // A candidate correction can recover model readiness without reopening the page.
      const status = await request('status');
      if (!current(g)) return false;
      applyModelStatus(status);
      state.modelReady = status.modelReady !== false;
      state.reason = status.reason || '';
      return true;
    } catch (error) {
      if (current(g)) showError(error);
      return false;
    } finally {
      if (current(g)) state.settingsPending = false;
    }
  }

  async function cancel() {
    if (state.cancelPending || !state.busy || !state.episodeId) return;
    const episodeId = state.episodeId;
    const g = generation;
    state.cancelPending = true;
    try {
      await request('cancel', { episodeId });
      if (current(g)) await refresh({ preserveHistory: true });
    } catch (error) {
      if (current(g)) showError(error);
    } finally {
      if (current(g)) state.cancelPending = false;
    }
  }

  return {
    open, refresh, command, cancel, page, settings, inspect, search, showTasks, readTasks, readTaskLog, stopTask,
    discardRetry() { outbox().delete(agentId); retainedFiles().delete(agentId); state.retryCommand = null; },
    dispose() { reset(); disposed = true; },
  };
}
