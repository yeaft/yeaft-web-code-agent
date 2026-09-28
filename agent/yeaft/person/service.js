import { MongoPersonRepository } from './repository.js';
import { PersonRuntime } from './runtime.js';
import { createPersonProvider } from './provider.js';
import { fail, identifier, LIMITS, object, page, safeError, text } from './contracts.js';

/**
 * One Mongo-backed Person per (namespace, authenticated ownerId). The transport MUST
 * supply authenticated ownerId, never accept it from a browser payload. URI/provider
 * secrets stay inside this Agent. Constructor and status never initiate model calls.
 * Native provider configuration is read from yeaftDir only (no Session initialization).
 * Inject MongoClient/config/adapter for isolated integration tests; no persistence fallback.
 */
export function createPersonService(options = {}) {
  const { uri, dbName = 'yeaft_person', namespace = 'default', yeaftDir, MongoClient, config, adapter, allowedModels } = options;
  identifier(namespace);
  if (typeof dbName !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(dbName)) fail('INVALID_REQUEST');
  if (uri != null && typeof uri !== 'string') fail('INVALID_REQUEST');
  const configured = Boolean(uri?.trim());
  const calls = options.maxCalls ?? LIMITS.calls;
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const leaseMs = options.leaseMs ?? LIMITS.leaseMs;
  if (!Number.isInteger(calls) || calls < 1 || calls > 8 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 ||
      !Number.isInteger(leaseMs) || leaseMs < 300 || leaseMs > 60000) fail('INVALID_REQUEST');
  if (allowedModels != null && (!Array.isArray(allowedModels) || !allowedModels.length || allowedModels.length > 8 || allowedModels.some(m => typeof m !== 'string'))) fail('INVALID_REQUEST');
  const repository = new MongoPersonRepository({ uri, dbName, namespace, MongoClient, leaseMs });
  // Config/adapter are loaded per explicit episode, not a permanent stale cache.
  const getProvider = () => createPersonProvider({ yeaftDir, config, adapter, allowedModels, effortEnabled: options.effortEnabled });
  const runtime = new PersonRuntime({ repository, getProvider, budget: { calls, timeoutMs } });
  let closed = false;
  const requests = new Set();
  async function handle({ ownerId, op, payload = {} } = {}) {
    if (closed) fail('CLOSED');
    text(ownerId, 256); // Owners are opaque authenticated IDs, not database selectors.
    if (typeof op !== 'string') fail('INVALID_REQUEST');
    if (op === 'status') {
      object(payload, []);
      if (!configured) return { configured: false, reason: 'MongoDB is not configured for digital person.', storageReady: false, modelReady: false };
      try { await repository.init(); }
      catch { return { configured: true, reason: 'Digital person storage is unavailable; a transaction-capable MongoDB replica set is required.', storageReady: false, modelReady: false }; }
      try {
        const provider = await getProvider();
        return { configured: true, reason: null, storageReady: true, modelReady: true, models: provider.catalog, autonomySupported: false };
      } catch { return { configured: true, reason: 'No permitted native model is configured for digital person.', storageReady: true, modelReady: false }; }
    }
    if (!configured) fail('NOT_CONFIGURED');
    switch (op) {
      case 'open': {
        object(payload, ['name'], []);
        if (payload.name != null) text(payload.name, 160);
        return repository.open(ownerId, payload.name);
      }
      case 'snapshot': object(payload, []); return repository.snapshot(ownerId);
      case 'send':
      case 'think':
      case 'dream': {
        object(payload, op === 'dream' ? ['clientMessageId'] : ['text', 'clientMessageId'], op === 'dream' ? ['clientMessageId'] : ['text', 'clientMessageId']);
        identifier(payload.clientMessageId);
        if (op !== 'dream') text(payload.text, LIMITS.inputBytes, op === 'think');
        const admitted = await repository.admit(ownerId, { kind: op, text: payload.text ?? '', clientMessageId: payload.clientMessageId,
          workerId: runtime.workerId, budget: runtime.budget });
        if (!admitted.duplicate) {
          if (closed) await repository.finish(admitted.episode, 'interrupted', 'INTERRUPTED');
          else runtime.start(admitted.episode);
        }
        return { episodeId: admitted.episodeId, duplicate: admitted.duplicate, status: admitted.status };
      }
      case 'traces': await repository.recover(ownerId); return repository.list(ownerId, 'traces', page(payload));
      case 'messages': return repository.list(ownerId, 'messages', page(payload));
      case 'cancel': {
        object(payload, ['episodeId'], []);
        if (payload.episodeId != null) identifier(payload.episodeId);
        const result = await repository.cancel(ownerId, payload.episodeId);
        if (result.cancelled) runtime.cancel(result.episodeId);
        return result;
      }
      case 'settings': {
        object(payload, ['autonomyEnabled'], []);
        if (Object.values(payload).some(v => typeof v !== 'boolean')) fail('INVALID_REQUEST');
        // Timer-driven autonomy is deliberately not claimed or silently enabled.
        if (payload.autonomyEnabled === true) fail('UNSUPPORTED');
        return repository.settings(ownerId, payload);
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
      await repository.close().catch(() => {});
    },
  };
}

export { PersonError } from './contracts.js';
