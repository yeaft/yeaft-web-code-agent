import { MongoPersonRepository } from './repository.js';
import { SqlitePersonRepository } from './sqlite-repository.js';
import { LocalPersonMemory } from './local-memory.js';
import { selectPersonStorage, bindPersonStorage } from './storage.js';
import { PersonRuntime } from './runtime.js';
import { validateFiles } from './attachments.js';
import { createPersonProvider, validateModelCandidates } from './provider.js';
import { fail, identifier, LIMITS, object, page, safeError, text } from './contracts.js';
import { inspectRequest, personName, searchRequest } from './inspection.js';

/**
 * One durable Person per (namespace, authenticated ownerId). The transport MUST
 * supply authenticated ownerId, never accept it from a browser payload. URI/provider
 * secrets stay inside this Agent. Constructor and status never initiate model calls.
 * Native provider configuration is read from yeaftDir only (no Session initialization).
 * SQLite is the local default; an existing Mongo URI retains Mongo. No authority fallback.
 */
export function createPersonService(options = {}) {
  const { uri, dbName = 'yeaft_person', namespace = 'default', yeaftDir, MongoClient, config, adapter, allowedModels } = options;
  identifier(namespace);
  if (typeof dbName !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(dbName)) fail('INVALID_REQUEST');
  if (uri != null && typeof uri !== 'string') fail('INVALID_REQUEST');
  const { storage, configured } = selectPersonStorage({ ...options, yeaftDir });
  const calls = options.maxCalls ?? LIMITS.calls;
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const leaseMs = options.leaseMs ?? LIMITS.leaseMs;
  if (!Number.isInteger(calls) || calls < 1 || calls > 8 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 ||
      !Number.isInteger(leaseMs) || leaseMs < 300 || leaseMs > 60000) fail('INVALID_REQUEST');
  if (allowedModels != null && (!Array.isArray(allowedModels) || !allowedModels.length || allowedModels.some(m => typeof m !== 'string'))) fail('INVALID_REQUEST');
  const repository = !configured ? null : storage === 'mongodb'
    ? new MongoPersonRepository({ uri, dbName, namespace, MongoClient, leaseMs })
    : new SqlitePersonRepository({ yeaftDir, namespace, leaseMs });
  const initialize = repository?.init.bind(repository);
  let binding;
  if (repository) repository.init = async () => {
    if (!binding) binding = bindPersonStorage(yeaftDir, namespace, storage).catch(error => { binding = null; throw error; });
    await binding;
    return initialize();
  };
  const literalRecall = repository?.recall.bind(repository);
  const memory = repository && storage === 'sqlite' ? new LocalPersonMemory({
    repository, literalRecall, yeaftDir, namespace, embedding: options.embedding,
  }) : null;
  if (memory) repository.recall = (ownerId, args = {}, { signal } = {}) => args.query?.trim()
    ? memory.recall(ownerId, args, { signal }) : literalRecall(ownerId, args);
  // Config/adapter are loaded per explicit episode, not a permanent stale cache.
  const getProvider = (modelCandidates = []) => createPersonProvider({ yeaftDir, config, adapter, allowedModels, modelCandidates, effortEnabled: options.effortEnabled });
  const runtime = new PersonRuntime({ repository, getProvider, budget: { calls, timeoutMs } });
  let closed = false;
  const requests = new Set();
  async function handle({ ownerId, op, payload = {} } = {}) {
    if (closed) fail('CLOSED');
    text(ownerId, 256); // Owners are opaque authenticated IDs, not database selectors.
    if (typeof op !== 'string') fail('INVALID_REQUEST');
    if (op === 'status') {
      object(payload, []);
      if (!configured) return { configured: false, storage, reason: 'Digital person storage configuration is missing.', storageReady: false, modelReady: false };
      try { await repository.init(); }
      catch (error) { return { configured: true, storage, reason: safeError(error).message, storageReady: false, modelReady: false }; }
      let modelCandidates = [];
      try { modelCandidates = (await repository.getPerson(ownerId)).settings.modelCandidates ?? []; }
      catch (error) { if (error.code !== 'NOT_OPEN') throw error; }
      try {
        const provider = await getProvider();
        let modelReady = true;
        try {
          validateModelCandidates(modelCandidates);
          if (modelCandidates.some(ref => !provider.availableModels.some(model => model.id === ref))) modelReady = false;
        } catch { modelReady = false; }
        return { configured: true, storage, reason: modelReady ? null : 'Saved model candidates are unavailable; choose models or reset to Agent defaults.',
          storageReady: true, modelReady, models: provider.availableModels, availableModels: provider.availableModels,
          availableModelsTruncated: provider.availableModelsTruncated, modelCandidates, autonomySupported: false };
      } catch { return { configured: true, storage, reason: 'No permitted native model is configured for digital person.', storageReady: true, modelReady: false, models: [], availableModels: [], modelCandidates }; }
    }
    if (!configured) fail('NOT_CONFIGURED');
    switch (op) {
      case 'open': {
        object(payload, ['name'], []);
        if (payload.name != null) text(payload.name, 160);
        return repository.open(ownerId, payload.name);
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
      // These reads deliberately bypass recover(), Recall and the runtime/provider.
      case 'inspect': return repository.inspect(ownerId, inspectRequest(payload));
      case 'search': {
        searchRequest(payload);
        return repository.search(ownerId, payload);
      }
      case 'cancel': {
        object(payload, ['episodeId'], []);
        if (payload.episodeId != null) identifier(payload.episodeId);
        const result = await repository.cancel(ownerId, payload.episodeId);
        if (result.cancelled) runtime.cancel(result.episodeId);
        return result;
      }
      case 'settings': {
        object(payload, ['name', 'autonomyEnabled', 'modelCandidates'], []);
        const patch = { ...payload };
        if (Object.hasOwn(patch, 'name')) patch.name = personName(patch.name);
        if (Object.hasOwn(payload, 'autonomyEnabled') && typeof payload.autonomyEnabled !== 'boolean') fail('INVALID_REQUEST');
        if (Object.hasOwn(payload, 'modelCandidates')) {
          const refs = payload.modelCandidates;
          validateModelCandidates(refs);
          if (refs.length) {
            const provider = await getProvider();
            if (refs.some(ref => !provider.availableModels.some(model => model.id === ref))) fail('MODEL_SELECTION');
          }
        }
        // Timer-driven autonomy is deliberately not claimed or silently enabled.
        if (payload.autonomyEnabled === true) fail('UNSUPPORTED');
        return repository.settings(ownerId, patch);
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
