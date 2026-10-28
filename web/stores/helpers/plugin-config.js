import { agentSupportsYeaftPlugins } from '../../utils/yeaft-plugin-capability.js';

// Runtime ownership is the store, not a mounted Plugin Center. Never reconnect
// or enqueue a transport send here: retry is an explicit user action.
const runtimes = new WeakMap();
const fields = ['tools', 'skills', 'mcpServers'];
const REQUEST_TIMEOUT = 10_000;

/** Auth boundary: discard private cache/intent and retire async continuations. */
export function clearPluginState(store) {
  const agents = runtimes.get(store);
  for (const state of agents?.values() || []) {
    state.cancelled = true;
    state.intents = [];
  }
  for (const pending of Object.values(store._pluginPending || {})) {
    clearTimeout(pending.timer);
    if (pending.finish) pending.finish({ stale: true });
    else pending.resolve?.({ stale: true, error: 'Authentication changed' });
  }
  store._pluginPending = {};
  runtimes.delete(store);
  store.pluginConfigByAgent = {};
  store.pluginCatalogByKey = {};
  store.pluginCatalogRequestByKey = {};
  store.managedSkillRequestByKey = {};
  store.pluginCenterAgentId = null;
  store.pluginCenterOpen = false;
}

function runtime(store, agentId) {
  let agents = runtimes.get(store);
  if (!agents) runtimes.set(store, agents = new Map());
  if (!agents.has(agentId)) agents.set(agentId, { fence: 0, intents: [], task: null });
  return agents.get(agentId);
}

function copy(plugins) {
  const result = {};
  for (const field of fields) {
    if (Array.isArray(plugins?.[field])) result[field] = [...new Set(plugins[field])];
  }
  return result;
}

function record(store, agentId) {
  return store.pluginConfigByAgent?.[agentId] || {
    agentId, plugins: {}, optimistic: {}, draft: {}, loaded: false,
    saving: false, loading: false, error: null, errorAgentId: null,
    retryIntent: null, uncertain: false,
  };
}

function patch(store, agentId, changes) {
  const next = { ...record(store, agentId), ...changes, agentId };
  store.pluginConfigByAgent = { ...store.pluginConfigByAgent, [agentId]: next };
  return next;
}

/** Plugin-only inventory: cached Agents are always read-only until live again. */
export function pluginCenterAgents(store) {
  const live = store?.agents || [];
  const ids = new Set(live.map(agent => agent.id));
  const cached = Object.values(store?.pluginConfigByAgent || {})
    .filter(record => record.loaded && record.agent?.id && !ids.has(record.agent.id))
    .map(record => ({ ...record.agent, online: false }));
  return [...live, ...cached];
}

function availabilityError(store, agentId) {
  if (!agentId) return 'no agent';
  const agent = store.agents?.find(item => item?.id === agentId);
  if (!agentSupportsYeaftPlugins(agent)) {
    return 'The selected Agent does not support Plugins; upgrade and restart the Agent';
  }
  if (!agent?.online || !store.ws || store.ws.readyState !== 1) return 'Agent is offline or disconnected';
  return null;
}

function applyIntents(plugins, intents) {
  let next = copy(plugins);
  for (const intent of intents) {
    if (intent.kind === 'replace') {
      next = copy(intent.plugins);
      continue;
    }
    const selected = new Set(Array.isArray(next[intent.field]) ? next[intent.field] : intent.catalogNames);
    if (intent.enabled) selected.add(intent.itemName);
    else selected.delete(intent.itemName);
    next[intent.field] = [...selected];
  }
  return next;
}

function failure(store, agentId, error, uncertain = false) {
  const state = runtime(store, agentId);
  const current = record(store, agentId);
  return patch(store, agentId, {
    optimistic: copy(current.plugins), draft: copy(current.plugins), saving: false, loading: false,
    error, errorAgentId: agentId, errorOperation: state.intents.length ? 'save' : 'load',
    retryIntent: state.intents.length ? { agentId, intents: state.intents.map(intent => ({ ...intent })) } : null,
    uncertain: uncertain || current.uncertain,
  });
}

function request(store, agentId, kind, plugins) {
  const state = runtime(store, agentId);
  const fence = ++state.fence;
  const error = availabilityError(store, agentId);
  if (error) return Promise.resolve({ error, uncertain: false, fence });
  const requestId = `plugins-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise(resolve => {
    const finish = result => {
      const pending = store._pluginPending?.[requestId];
      if (!pending) return;
      clearTimeout(pending.timer);
      delete store._pluginPending[requestId];
      resolve({ ...result, fence });
    };
    const timer = setTimeout(() => finish({ error: 'timeout', uncertain: kind === 'save' }), REQUEST_TIMEOUT);
    store._pluginPending[requestId] = {
      kind, agentId, timer, fence, socket: store.ws,
      connectionGeneration: Number(store.chatHistoryConnectionGeneration || 0),
      expiresAt: Date.now() + REQUEST_TIMEOUT, finish,
    };
    try {
      const sent = store.sendWsMessage({
        type: kind === 'save' ? 'update_yeaft_plugins' : 'get_yeaft_plugins',
        agentId, requestId, ...(kind === 'save' ? { plugins: copy(plugins) } : {}),
      });
      if (!sent) finish({ error: 'Agent is offline or disconnected', uncertain: false });
    } catch (error) {
      finish({ error: error?.message || String(error), uncertain: kind === 'save' });
    }
  });
}

/** Only live, correctly attributed replies may settle a config request. */
export function acceptPluginConfigReply(store, msg) {
  const pending = msg.requestId ? store._pluginPending?.[msg.requestId] : null;
  const kind = msg.type === 'yeaft_plugins_updated' ? 'save' : 'config';
  if (!pending || pending.kind !== kind || pending.agentId !== msg.agentId) return false;
  if (Date.now() >= pending.expiresAt) return false;
  if (pending.socket !== store.ws
      || pending.connectionGeneration !== Number(store.chatHistoryConnectionGeneration || 0)) return false;
  if (pending.fence !== runtime(store, msg.agentId).fence) {
    pending.finish({ stale: true });
    return false;
  }
  // Malformed success is not an authoritative empty (= enable all) config.
  const valid = msg.plugins && typeof msg.plugins === 'object' && !Array.isArray(msg.plugins);
  pending.finish({
    plugins: valid ? copy(msg.plugins) : undefined,
    error: msg.error || (valid ? null : 'Invalid plugin configuration reply'),
    uncertain: !msg.error && !valid && kind === 'save',
  });
  return true;
}

/** Existing callers still receive a Promise of { plugins, error, ...status }. */
export function loadPluginConfig(store, agentId) {
  const state = runtime(store, agentId);
  if (state.task) return state.task;
  return readConfig(store, agentId);
}

async function readConfig(store, agentId) {
  const state = runtime(store, agentId);
  const agent = store.agents?.find(item => item?.id === agentId);
  patch(store, agentId, {
    loading: true,
    // Keep only display/capability metadata with this in-memory cache. The
    // Server removes disconnected Agents from inventory rather than marking
    // them offline; cached metadata must never authorize writes.
    ...(agent ? { agent: {
      id: agent.id, name: agent.name,
      capabilityMetadataProvided: agent.capabilityMetadataProvided,
      capabilities: Array.isArray(agent.capabilities) ? [...agent.capabilities] : [],
    } } : {}),
  });
  const result = await request(store, agentId, 'config');
  // An edit or newer read supersedes this read, even if its Promise callback
  // runs after the newer action started. It must not clear a save or its error.
  if (state.cancelled) return { stale: true };
  if (result.stale || (result.fence != null && result.fence !== state.fence)) {
    return { ...record(store, agentId), stale: true };
  }
  if (result.error) return failure(store, agentId, result.error);
  const current = record(store, agentId);
  const plugins = copy(result.plugins);
  const optimistic = state.task ? applyIntents(plugins, state.intents) : plugins;
  return patch(store, agentId, {
    plugins, optimistic, draft: copy(optimistic), loading: false, loaded: true, at: Date.now(),
    // Refreshing/remounting must not dismiss an unsaved change failure.
    ...(state.intents.length && !state.task ? {} : { error: null, errorAgentId: null, errorOperation: null, uncertain: false }),
    ...(current.retryIntent ? { retryIntent: current.retryIntent } : {}),
  });
}

async function drain(store, agentId, reconcile) {
  const state = runtime(store, agentId);
  const socket = store.ws;
  const connectionGeneration = Number(store.chatHistoryConnectionGeneration || 0);
  // Coalesce all synchronous toggles before creating a wire write.
  await Promise.resolve();
  if (state.cancelled) return { stale: true };
  if (reconcile || !record(store, agentId).loaded) {
    const result = await readConfig(store, agentId);
    if (state.cancelled) return { stale: true };
    if (result.error) return failure(store, agentId, result.error, record(store, agentId).uncertain);
  }
  while (state.intents.length) {
    if (state.stopError || socket !== store.ws
        || connectionGeneration !== Number(store.chatHistoryConnectionGeneration || 0)) {
      return failure(store, agentId, state.stopError || 'Connection changed; retry required', true);
    }
    const count = state.intents.length;
    const desired = applyIntents(record(store, agentId).plugins, state.intents.slice(0, count));
    patch(store, agentId, { optimistic: desired, draft: copy(desired), loading: false });
    const result = await request(store, agentId, 'save', desired);
    if (state.cancelled) return { stale: true };
    if (result.error || result.stale) {
      return failure(store, agentId, result.error || 'Plugin configuration changed; retry required', result.uncertain);
    }
    state.intents.splice(0, count);
    const plugins = copy(result.plugins);
    const optimistic = applyIntents(plugins, state.intents);
    patch(store, agentId, {
      plugins, optimistic, draft: copy(optimistic), loaded: true, at: Date.now(),
      error: null, errorAgentId: null, errorOperation: null, retryIntent: null, uncertain: false,
    });
  }
  return patch(store, agentId, { saving: false, loading: false });
}

function start(store, agentId, reconcile = false) {
  const state = runtime(store, agentId);
  state.stopError = null;
  patch(store, agentId, { saving: true });
  const task = drain(store, agentId, reconcile).catch(error => (
    state.cancelled ? { stale: true } : failure(store, agentId, error?.message || String(error), true)
  )).finally(() => { if (state.task === task) state.task = null; });
  state.task = task;
  return task;
}

function enqueue(store, agentId, intent) {
  const state = runtime(store, agentId);
  const current = record(store, agentId);
  // Vue sync watchers can enqueue from the final saving=false notification,
  // before the old task's finally callback has run. That task no longer owns
  // any intents; a new task must own the new edit.
  if (state.task && !current.saving && !state.intents.length) state.task = null;
  state.intents.push(intent);
  // A read already in flight no longer owns this Agent's draft.
  if (!state.task) state.fence++;
  const error = availabilityError(store, agentId);
  if (error) {
    // Do not start/leave an automatic queue that could replay on reconnect.
    if (state.task) {
      state.stopError = error;
      const next = failure(store, agentId, error, true);
      return Promise.resolve(next);
    }
    return Promise.resolve(failure(store, agentId, error));
  }
  if (!state.task && current.error && current.retryIntent) {
    // Keep failed intent for the explicit Retry button; ordinary UI activity
    // and remounts cannot silently replay it.
    return Promise.resolve(failure(store, agentId, current.error, current.uncertain));
  }
  const optimistic = applyIntents(current.plugins, state.intents);
  patch(store, agentId, { optimistic, draft: copy(optimistic) });
  return state.task || start(store, agentId);
}

/**
 * itemName/catalogNames use wire selection names (skills: name, NOT source id).
 * Missing field means all catalog items enabled; other fields stay untouched.
 */
export function setPluginEnabled(store, field, itemName, enabled, catalogNames, agentId) {
  if (!fields.includes(field) || typeof itemName !== 'string' || !itemName) {
    return Promise.resolve({ ...record(store, agentId), error: 'Invalid plugin selection' });
  }
  const names = (Array.isArray(catalogNames) ? catalogNames : []).map(item => (
    typeof item === 'string' ? item : (field === 'skills' ? item?.name : item?.id)
  )).filter(name => typeof name === 'string' && name);
  return enqueue(store, agentId, { kind: 'toggle', field, itemName, enabled: !!enabled, catalogNames: names });
}

/** Legacy whole-selection replacement, using the same serialized save owner. */
export function savePluginConfig(store, plugins, agentId) {
  return enqueue(store, agentId, { kind: 'replace', plugins: copy(plugins) });
}

export function retryPluginConfig(store, agentId) {
  const state = runtime(store, agentId);
  if (state.task) return state.task;
  const error = availabilityError(store, agentId);
  if (error) return Promise.resolve(failure(store, agentId, error));
  if (!state.intents.length) return loadPluginConfig(store, agentId);
  // A timeout does not cancel the old Agent-side write. Read authoritative
  // config before rebasing item intents; never resend an old full snapshot.
  return start(store, agentId, true);
}
