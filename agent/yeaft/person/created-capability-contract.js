import { bytes, digest, fail, identifier, object, text } from './contracts.js';

export const CREATED_CAPABILITY_LIMITS = Object.freeze({ ids: 32, versions: 32 });
const fields = ['id', 'expectedVersion', 'description', 'useWhen', 'avoidWhen', 'inputDescription', 'outputDescription', 'code', 'tests'];

// Copy only finite JSON, without invoking toJSON/accessors or losing undefined,
// sparse entries, non-JSON objects or cycles. Each test value has its own budget.
function testValue(value) {
  let remaining = 4096;
  const ancestors = new Set();
  const spend = n => { remaining -= n; if (remaining < 0) fail('INVALID_REQUEST'); };
  const copy = (v, depth) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      spend(bytes(JSON.stringify(v))); return v === 0 ? 0 : v;
    }
    if (!v || typeof v !== 'object' || depth >= 32 || ancestors.has(v)) fail('INVALID_REQUEST');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (!array && proto !== Object.prototype && proto !== null) fail('INVALID_REQUEST');
    const keys = Object.keys(v);
    if (Reflect.ownKeys(v).length !== keys.length + (array ? 1 : 0) || (array && keys.length !== v.length)) fail('INVALID_REQUEST');
    spend(2 + Math.max(0, keys.length - 1));
    ancestors.add(v);
    const result = array ? [] : {};
    for (const key of array ? keys : keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!Object.hasOwn(descriptor, 'value') || (array && key !== String(result.length))) fail('INVALID_REQUEST');
      if (!array) spend(bytes(JSON.stringify(key)) + 1);
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(v);
    return result;
  };
  return copy(value, 0);
}

/** Model-authored definition only. Evidence/ownership/version fields are rejected.
 * Returns an independent normalized copy with the same public input shape.
 */
export function validateCreatedDefinition(definition) {
  object(definition, fields);
  if (typeof definition.id !== 'string' || !/^Script\.[a-z][a-z0-9-]{0,47}$/.test(definition.id) ||
      !Number.isSafeInteger(definition.expectedVersion) || definition.expectedVersion < 0) fail('INVALID_REQUEST');
  const normalized = { id: definition.id, expectedVersion: definition.expectedVersion };
  for (const field of fields.slice(2, 7)) normalized[field] = text(definition[field], 400, field === 'avoidWhen');
  normalized.code = text(definition.code, 8192);
  if (!Array.isArray(definition.tests) || definition.tests.length < 1 || definition.tests.length > 8) fail('INVALID_REQUEST');
  normalized.tests = Array.from(definition.tests, test => {
    object(test, ['input', 'expected']);
    return { input: testValue(test.input), expected: testValue(test.expected) };
  });
  if (bytes(normalized) > 24576) fail('INVALID_REQUEST');
  return normalized;
}

/** Internal repository API: evidence MUST come from the runtime executor, never
 * from model proposal fields. The repository validates its shape, not execution.
 */
export function validateCreatedCapability(input) {
  object(input, ['definition', 'evidence', 'callId']);
  const definition = validateCreatedDefinition(input.definition);
  const { evidence, callId } = input;
  object(evidence, ['engine', 'testsPassed', 'testedAt']);
  if (evidence.engine !== 'quickjs' || !Number.isSafeInteger(evidence.testsPassed) || evidence.testsPassed !== definition.tests.length ||
      typeof evidence.testedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidence.testedAt) ||
      !Number.isFinite(Date.parse(evidence.testedAt)) || new Date(evidence.testedAt).toISOString() !== evidence.testedAt) fail('INVALID_REQUEST');
  identifier(callId);
  return { definition, evidence: { engine: 'quickjs', testsPassed: evidence.testsPassed, testedAt: evidence.testedAt }, callId };
}

/** Flat current/revision record. created* identifies THIS immutable version's
 * creating call, not the first version; timestamps are ISO strings in both DBs.
 * revision hashes only {version, definition}, never evidence or ownership.
 */
export function createdCapabilityRecord(definition, evidence, { episode, callId, now }) {
  const validated = validateCreatedCapability({ definition, evidence, callId });
  const { expectedVersion, ...stored } = validated.definition;
  const version = expectedVersion + 1, timestamp = now.toISOString();
  return { ...stored, version, revision: digest({ version, definition: stored }), evidence: validated.evidence,
    createdEpisodeId: episode.id, createdCallId: callId, createdAt: timestamp, updatedAt: timestamp };
}
