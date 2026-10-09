import { bytes, fail, identifier, object, page, text } from './contracts.js';

/** Public read APIs use keyset cursors, never offsets or model-ranked recall. */
export function inspectRequest(payload = {}) {
  object(payload, ['section', 'cursor', 'limit'], ['section']);
  if (!['memory', 'skills'].includes(payload.section)) fail('INVALID_REQUEST');
  const { limit } = page({ limit: payload.limit });
  const cursor = payload.cursor ?? null;
  if (cursor !== null) identifier(cursor);
  return { section: payload.section, cursor, limit };
}
export function searchRequest(payload = {}) {
  object(payload, ['query', 'cursor', 'limit'], ['query']);
  return { query: text(payload.query, 512), ...page({ cursor: payload.cursor, limit: payload.limit }) };
}
export function personName(value) {
  if (typeof value !== 'string') fail('INVALID_REQUEST');
  return text(value.trim(), 160);
}
const pick = (value, keys) => value == null ? null : Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
export const settingsView = value => pick(value, ['autonomyEnabled', 'modelCandidates', 'defaultModel']);
export function messageView(value) {
  const result = pick(value, ['id', 'schemaVersion', 'revision', 'seq', 'episodeId', 'clientMessageId', 'role', 'text', 'createdAt']);
  if (result && Array.isArray(value.attachments)) result.attachments = value.attachments.slice(0, 4)
    .map(file => pick(file, ['id', 'name', 'mimeType', 'size', 'sha256', 'kind']));
  return result;
}
export function conceptView(value) {
  const result = pick(value, ['id', 'schemaVersion', 'kind', 'statement', 'epistemicState', 'sourceRefs', 'reportedSourceRefs', 'revision', 'episodeId', 'callId', 'stateVersion', 'updatedAt']);
  if (result && Array.isArray(value.associations)) result.associations = value.associations.map(a => pick(a, ['targetId', 'relation']));
  return result;
}
export function stateView(value) {
  const result = pick(value, ['schemaVersion', 'version', 'summary', 'appraisal', 'focusConceptIds', 'updatedAt', 'episodeId']);
  if (!result) return null;
  if (Array.isArray(value.conceptRefs)) result.conceptRefs = value.conceptRefs.map(ref => pick(ref, ['id', 'revision']));
  if (Object.hasOwn(value, 'decision')) result.decision = pick(value.decision, ['summary', 'uncertainties', 'selfCheck']);
  if (Object.hasOwn(value, 'lastSelection')) result.lastSelection = pick(value.lastSelection, ['model', 'effort']);
  return result;
}
export function createdSkillView(record, contract) {
  return { ...pick(record, ['id', 'description', 'version', 'revision', 'code', 'inputDescription', 'outputDescription', 'createdAt', 'updatedAt']),
    tests: Array.isArray(record.tests) ? record.tests.map(test => pick(test, ['input', 'expected'])) : [],
    domain: 'script', contract,
    evidence: pick(record.evidence, ['engine', 'testsPassed', 'testedAt']),
    source: { kind: 'person-created', episodeId: record.createdEpisodeId, callId: record.createdCallId } };
}
/** Complete records only. Continuation follows the last returned key even when the
 * byte budget, rather than the requested count, ends a page. No attachment bytes. */
export function inspectionPage(records, limit, key, view = value => value) {
  const items = []; let size = 0;
  for (const record of records) {
    if (items.length === limit) break;
    const item = view(record), cost = bytes(item);
    if (cost > 256 * 1024) fail('OUTPUT_LIMIT');
    if (items.length && size + cost > 256 * 1024) break;
    items.push(item); size += cost;
  }
  return { items, nextCursor: records.length > items.length ? String(items.at(-1)[key]) : null };
}
