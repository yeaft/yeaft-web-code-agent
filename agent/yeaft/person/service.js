import { SqlitePersonRepository } from './sqlite-repository.js';
import { LocalPersonMemory } from './local-memory.js';
import { ensurePersonStorage } from './sqlite-storage.js';
import { PersonRuntime } from './runtime.js';
import { allowedNativeToolIds } from './native-tools.js';
import { loadConfig } from '../config.js';
import { validateFiles } from './attachments.js';
import { createPersonProvider, resolveAgentDefaultModel, selectPersonModels, validateDefaultModel, validateModelCandidates } from './provider.js';
import { fail, identifier, LIMITS, object, page, personTaskRequest, safeError, text } from './contracts.js';
import { turnsPage } from './turn-diagnostics.js';
import { inspectRequest, personName, searchRequest } from './inspection.js';

/**
 * One durable Person per (namespace, authenticated ownerId). The transport MUST
 * supply authenticated ownerId, never accept it from a browser payload. Provider
 * secrets stay inside this Agent. Constructor and status never initiate model calls.
 * SQLite storage and native provider configuration belong to yeaftDir only
 * (no Session initialization or alternate storage authority).
 */
export function createPersonService(options = {}) {
  const { namespace = 'default', yeaftDir, workDir, config, adapter, allowedModels } = options;
  identifier(namespace);
  const configured = typeof yeaftDir === 'string' && Boolean(yeaftDir.trim());
  const calls = options.maxCalls ?? LIMITS.calls;
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const leaseMs = options.leaseMs ?? LIMITS.leaseMs;
  if (!Number.isInteger(calls) || calls < 1 || calls > 32 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 ||
      !Number.isInteger(leaseMs) || leaseMs < 300 || leaseMs > 60000) fail('INVALID_REQUEST');
  if (allowedModels != null && (!Array.isArray(allowedModels) || !allowedModels.length || allowedModels.some(m => typeof m !== 'string'))) fail('INVALID_REQUEST');
  const repository = configured ? new SqlitePersonRepository({ yeaftDir, namespace, leaseMs }) : null;
  const initialize = repository?.init.bind(repository);
  let binding;
  if (repository) repository.init = async () => {
    if (!binding) binding = ensurePersonStorage(yeaftDir, namespace).catch(error => { binding = null; throw error; });
    await binding;
    return initialize();
  };
  const literalRecall = repository?.recall.bind(repository);
  const memory = repository ? new LocalPersonMemory({
    repository, literalRecall, yeaftDir, namespace, embedding: options.embedding,
  }) : null;
  if (memory) repository.recall = (ownerId, args = {}, { signal } = {}) => args.query?.trim()
    ? memory.recall(ownerId, args, { signal }) : literalRecall(ownerId, args);
  // Config/adapter are loaded per explicit episode, not a permanent stale cache.
  const getProvider = (modelCandidates = [], defaultModel = null) => createPersonProvider({ yeaftDir, config, adapter, allowedModels, modelCandidates, defaultModel, effortEnabled: options.effortEnabled });
  const runtime = new PersonRuntime({ repository, getProvider, budget: { calls, timeoutMs }, workDir, yeaftDir, config, namespace });
  let closed = false;
  const requests = new Set();
  async function handle({ ownerId, op, payload = {} } = {}) {
    if (closed) fail('CLOSED');
    text(ownerId, 256); // Owners are opaque authenticated IDs, not database selectors.
    if (typeof op !== 'string') fail('INVALID_REQUEST');
    if (op === 'status') {
      object(payload, []);
      let agentDefaultModel = null;
      try { agentDefaultModel = resolveAgentDefaultModel(config ?? loadConfig({ dir: yeaftDir })); } catch { /* Invalid/missing native config. */ }
      const status = { renameSupported: true, defaultModelSupported: true, configured, storage: 'sqlite', modelReady: false,
        defaultModel: null, agentDefaultModel, modelCandidates: [], effectiveModelCandidates: [], effectiveDefaultModel: null };
      if (!configured) return { ...status, reason: 'Digital person storage configuration is missing.', storageReady: false };
      try { await repository.init(); }
      catch (error) { return { ...status, reason: safeError(error).message, storageReady: false }; }
      try {
        const settings = (await repository.getPerson(ownerId)).settings;
        status.modelCandidates = settings.modelCandidates ?? [];
        status.defaultModel = settings.defaultModel ?? null;
      } catch (error) { if (error.code !== 'NOT_OPEN') throw error; }
      try {
        const provider = await getProvider();
        try {
          const selected = selectPersonModels({ availableModels: provider.availableModels,
            modelCandidates: status.modelCandidates, defaultModel: status.defaultModel });
          status.modelReady = true;
          status.effectiveModelCandidates = selected.catalog.map(model => model.id);
          status.effectiveDefaultModel = selected.defaultSelection.model;
        } catch { /* Stale settings remain visible, but do not grant fallback candidates. */ }
        return { ...status, agentDefaultModel: provider.agentDefaultModel,
          reason: status.modelReady ? null : 'Saved model settings are unavailable; choose models or reset to Agent defaults.',
          storageReady: true, models: provider.availableModels, availableModels: provider.availableModels,
          availableModelsTruncated: provider.availableModelsTruncated, autonomySupported: false };
      } catch { return { ...status, reason: 'No permitted native model is configured for digital person.', storageReady: true, models: [], availableModels: [] }; }
    }
    if (!configured) fail('NOT_CONFIGURED');
    switch (op) {
      case 'open': {
        object(payload, ['name'], []);
        if (payload.name != null) text(payload.name, 160);
        return repository.open(ownerId, payload.name);
      }
      case 'tasks':
      case 'task_log':
      case 'task_cancel':
      case 'agent_close': {
        const args = personTaskRequest(op, payload);
        const person = await repository.getPerson(ownerId);
        const host = runtime.tasks();
        if (!host) fail('UNSUPPORTED');
        return host.request({ ownerId, personId: person.personId, namespace, op, payload: args });
      }
      case 'snapshot': object(payload, []); return repository.snapshot(ownerId);
      case 'receipt': {
        object(payload, ['clientMessageId', 'requestHash'], ['clientMessageId']);
        identifier(payload.clientMessageId);
        if (payload.requestHash != null && (typeof payload.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.requestHash))) fail('INVALID_REQUEST');
        // Read-only admission reconciliation: no files, recover, admission or runtime start.
        return repository.receipt(ownerId, payload.clientMessageId, payload.requestHash);
      }
      case 'send':
      case 'think':
      case 'dream': {
        object(payload, op === 'dream' ? ['clientMessageId'] : ['text', 'clientMessageId', 'files'], ['clientMessageId']);
        identifier(payload.clientMessageId);
        validateFiles(payload.files, payload.text ?? '', op);
        // Durable cancellation may already fence the old episode; do not start a
        // new local activity while its host effects are still being joined.
        if (runtime.isOwnerRunning(ownerId)) {
          const receipt = await repository.receipt(ownerId, payload.clientMessageId);
          if (!receipt.found) fail('BUSY');
        }
        const admitted = await repository.admit(ownerId, { kind: op, text: payload.text ?? '', clientMessageId: payload.clientMessageId,
          workerId: runtime.workerId, budget: runtime.budget, files: payload.files });
        if (!admitted.duplicate) {
          if (closed) await repository.finish(admitted.episode, 'interrupted', 'INTERRUPTED');
          else runtime.start(admitted.episode);
        }
        return { episodeId: admitted.episodeId, duplicate: admitted.duplicate, status: admitted.status };
      }
      case 'traces': await repository.recover(ownerId); return repository.list(ownerId, 'traces', page(payload));
      case 'messages': return repository.list(ownerId, 'messages', page(payload));
      case 'turns': return repository.turns(ownerId, turnsPage(payload));
      // These reads deliberately bypass recover(), Recall and the runtime/provider.
      case 'inspect': {
        const request = inspectRequest(payload);
        return repository.inspect(ownerId, request, request.section === 'skills' ? allowedNativeToolIds(config ?? loadConfig({ dir: yeaftDir })) : undefined);
      }
      case 'search': {
        searchRequest(payload);
        return repository.search(ownerId, payload);
      }
      case 'cancel': {
        object(payload, ['episodeId'], []);
        if (payload.episodeId != null) identifier(payload.episodeId);
        const release = runtime.beginCancellation(ownerId);
        try {
          const result = await repository.cancel(ownerId, payload.episodeId);
          // Even a repeated cancel must join an already-fenced local execution.
          // A durable cancelled status alone does not prove host effects stopped.
          await runtime.cancel(payload.episodeId, 'CANCELLED', ownerId);
          return result;
        } finally { release(); }
      }
      case 'settings': {
        object(payload, ['name', 'autonomyEnabled', 'modelCandidates', 'defaultModel'], []);
        const patch = { ...payload };
        if (Object.hasOwn(patch, 'name')) patch.name = personName(patch.name);
        if (Object.hasOwn(payload, 'autonomyEnabled') && typeof payload.autonomyEnabled !== 'boolean') fail('INVALID_REQUEST');
        if (Object.hasOwn(payload, 'modelCandidates')) validateModelCandidates(payload.modelCandidates);
        if (Object.hasOwn(payload, 'defaultModel')) validateDefaultModel(payload.defaultModel);
        // Timer-driven autonomy is deliberately not claimed or silently enabled.
        if (payload.autonomyEnabled === true) fail('UNSUPPORTED');
        let expectedControlVersion;
        if (Object.hasOwn(payload, 'modelCandidates') || Object.hasOwn(payload, 'defaultModel')) {
          const prior = await repository.getPerson(ownerId);
          if (prior.activeEpisodeId) fail('BUSY');
          const merged = { modelCandidates: [], defaultModel: null, ...prior.settings, ...patch };
          validateModelCandidates(merged.modelCandidates);
          validateDefaultModel(merged.defaultModel);
          // An automatic reset must also work when no model is currently available.
          if (merged.modelCandidates.length || merged.defaultModel !== null) {
            const provider = await getProvider();
            selectPersonModels({ availableModels: provider.availableModels, modelCandidates: merged.modelCandidates, defaultModel: merged.defaultModel });
          }
          // Fence the merge base across concurrent services; retry from fresh settings.
          expectedControlVersion = prior.controlVersion;
        }
        return repository.settings(ownerId, patch, expectedControlVersion);
      }
      default: fail('INVALID_REQUEST');
    }
  }
  return {
    request(input) {
      const pending = Promise.resolve().then(() => handle(input)).catch(error => { throw safeError(error); });
      requests.add(pending); pending.then(() => requests.delete(pending), () => requests.delete(pending));
      return pending;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...requests]);
      await runtime.close();
      await memory?.close();
      await repository?.close().catch(() => {});
    },
  };
}

export { PersonError } from './contracts.js';
