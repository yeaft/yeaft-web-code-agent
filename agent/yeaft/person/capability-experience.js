import { fail, identifier, object } from './contracts.js';

export const CAPABILITY_EXPERIENCE_LIMITS = Object.freeze({ entries: 16, observations: 8 });
const excluded = new Set(['catalog.search', 'catalog.view', 'Think']);
const manifestFields = ['id', 'version', 'revision'];
const observationFields = ['episodeId', 'callId', 'triggerKind', 'outcome', 'code', 'usedAt'];
const recentFirst = (a, b) => b.usedAt.localeCompare(a.usedAt);

function manifest(value) {
  object(value, manifestFields);
  identifier(value.id);
  if (!Number.isSafeInteger(value.version) || value.version < 1 || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) fail('INVALID_REQUEST');
  return { id: value.id, version: value.version, revision: value.revision };
}
function observation(value) {
  object(value, observationFields);
  identifier(value.episodeId); identifier(value.callId);
  if (!['send', 'think', 'dream'].includes(value.triggerKind) || !['succeeded', 'failed'].includes(value.outcome)) fail('INVALID_REQUEST');
  if (value.outcome === 'failed') identifier(value.code);
  else if (value.code !== null) fail('INVALID_REQUEST');
  if (typeof value.usedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.usedAt) ||
      !Number.isFinite(Date.parse(value.usedAt)) || new Date(value.usedAt).toISOString() !== value.usedAt) fail('INVALID_REQUEST');
  return { episodeId: value.episodeId, callId: value.callId, triggerKind: value.triggerKind, outcome: value.outcome, code: value.code, usedAt: value.usedAt };
}

/** Bounded metadata only. No instructions, permissions, arguments or results are
 * retained or made authoritative. Technical success is not semantic usefulness. */
export function capabilityExperienceView(value = []) {
  if (!Array.isArray(value)) fail('INVALID_REQUEST');
  return value.map(entry => {
    object(entry, [...manifestFields, 'observations']);
    const metadata = manifest({ id: entry.id, version: entry.version, revision: entry.revision });
    if (!Array.isArray(entry.observations)) fail('INVALID_REQUEST');
    const observations = entry.observations.map(observation).sort(recentFirst).slice(0, CAPABILITY_EXPERIENCE_LIMITS.observations);
    return { ...metadata, observations };
  }).filter(entry => !excluded.has(entry.id) && entry.observations.length)
    .sort((a, b) => recentFirst(a.observations[0], b.observations[0])).slice(0, CAPABILITY_EXPERIENCE_LIMITS.entries);
}

/** Called ONLY inside a fenced append transaction, with the stored episode and
 * repository clock. Missing manifest means no observed execution (legacy trace
 * or pre-execution rejection), not permission to infer one from trace content.
 * Returns null when no mutation is needed; never mutates either input. */
export function recordCapabilityExperience(previous, episode, kind, data, usedAt) {
  if (!['capability_result', 'capability_failed'].includes(kind) || !data || !Object.hasOwn(data, 'capabilityManifest')) return null;
  const id = kind === 'capability_result' ? data.capability?.id : data.capabilityId;
  if (excluded.has(id)) return null;
  const metadata = manifest(data.capabilityManifest);
  if (metadata.id !== id) fail('INVALID_REQUEST');
  const next = observation({ episodeId: episode.id, callId: data.callId, triggerKind: episode.kind,
    outcome: kind === 'capability_result' ? 'succeeded' : 'failed', code: kind === 'capability_result' ? null : data.code, usedAt });
  const entries = capabilityExperienceView(previous);
  // Event identity is per episode/call, including across capability entries.
  if (entries.some(entry => entry.observations.some(o => o.episodeId === next.episodeId && o.callId === next.callId))) return null;
  const existing = entries.find(entry => entry.id === id);
  const retained = existing?.version === metadata.version && existing.revision === metadata.revision ? existing.observations : [];
  const updated = { ...metadata, observations: [next, ...retained].sort(recentFirst).slice(0, CAPABILITY_EXPERIENCE_LIMITS.observations) };
  return [updated, ...entries.filter(entry => entry.id !== id)]
    .sort((a, b) => recentFirst(a.observations[0], b.observations[0])).slice(0, CAPABILITY_EXPERIENCE_LIMITS.entries);
}
