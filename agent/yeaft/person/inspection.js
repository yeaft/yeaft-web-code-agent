import { bytes, fail, identifier, object, page, text } from './contracts.js';

/** Timestamp + binary ID keysets survive insertion, deletion of the boundary
 * record and same-millisecond writes. Builtins have no invented chronology.
 * Bare ID cursors remain readable for pre-keyset clients' ID-ascending pages. */
export function inspectionCursor(value, section) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 512) fail('INVALID_REQUEST');
  const prefix = section === 'memory' ? 'm1' : 's1';
  const match = /^(m1|s1):(c|b):(\d{1,16}):([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) {
    if (/^(m1|s1):/.test(value)) fail('INVALID_REQUEST');
    identifier(value); return { legacy: true, id: value };
  }
  const [, type, stage, rawTime, encoded] = match;
  const time = Number(rawTime), id = Buffer.from(encoded, 'base64url').toString('utf8');
  identifier(id);
  if (type !== prefix || (section === 'memory' && stage !== 'c') || !Number.isSafeInteger(time) || time < 0 ||
      String(time) !== rawTime || (stage === 'b' && time !== 0) || Buffer.from(id).toString('base64url') !== encoded) fail('INVALID_REQUEST');
  return { stage, time, id };
}
export const inspectionTime = value => {
  const time = value == null ? NaN : new Date(value).getTime();
  return Number.isSafeInteger(time) && time >= 0 ? time : 0;
};
export const chronologicalCursor = (section, record, stage = 'c') =>
  `${section === 'memory' ? 'm1' : 's1'}:${stage}:${stage === 'b' ? 0 : inspectionTime(section === 'memory' ? record.updatedAt : record.createdAt)}:${Buffer.from(record.id).toString('base64url')}`;

/** Public read APIs use keyset cursors, never offsets or model-ranked recall. */
export function inspectRequest(payload = {}) {
  object(payload, ['section', 'cursor', 'limit'], ['section']);
  if (!['memory', 'skills'].includes(payload.section)) fail('INVALID_REQUEST');
  const { limit } = page({ limit: payload.limit });
  const cursor = payload.cursor ?? null;
  inspectionCursor(cursor, payload.section);
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
  const result = pick(value, ['id', 'schemaVersion', 'revision', 'seq', 'episodeId', 'clientMessageId', 'callId', 'replyKind', 'role', 'text', 'createdAt']);
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
export function inspectionPage(records, limit, key, view = value => value, maxBytes = 256 * 1024) {
  const items = []; let size = 0, lastRecord;
  for (const record of records) {
    if (items.length === limit) break;
    const item = view(record), cost = bytes(item);
    if (cost > maxBytes) fail('OUTPUT_LIMIT');
    if (items.length && size + cost > maxBytes) break;
    items.push(item); size += cost; lastRecord = record;
  }
  return { items, nextCursor: records.length > items.length ? (typeof key === 'function' ? key(lastRecord) : String(items.at(-1)[key])) : null };
}
