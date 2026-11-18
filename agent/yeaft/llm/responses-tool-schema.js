/** Yeaft's tool contract is provider-neutral. Only the Responses wire uses
 * this closed, explicitly strict projection. Never mutate the source schema.
 */
import { LLMToolInputError } from './adapter.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const primitive = value => value === null || Number.isFinite(value) || ['string', 'boolean'].includes(typeof value);
const types = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const annotations = new Set(['description', 'title', '$schema', '$comment', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);
const known = new Set(['type', 'anyOf', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']);
const nullable = schema => schema.anyOf?.some(nullable) ?? (
  (schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null'))
    && (!schema.enum || schema.enum.includes(null))
);
const describe = (...parts) => parts.filter(Boolean).join(' ');

function schemaHint(source) {
  const serialized = JSON.stringify(source);
  if (!serialized || serialized === '{}') return '';
  if (serialized.length <= 4000) return `Inner JSON Schema: ${serialized}`;
  // Avoid burying the request in a third-party schema, but still expose the
  // important shape instead of replacing its entire contract with a string.
  const fields = Object.keys(source?.properties ?? {});
  const required = Array.isArray(source?.required) ? source.required : [];
  const summarize = (label, names) => names.length ? `${label}: ${JSON.stringify(names.slice(0, 100)).slice(0, 1500)}.` : '';
  return describe(source?.type ? `Inner type: ${JSON.stringify(source.type).slice(0, 100)}.` : '',
    summarize('Required fields', required), summarize('Other fields', fields.filter(key => !required.includes(key))),
    'The tool still checks its original input contract.');
}

function packed(source, description) {
  // The text is a guide for generating the inner value, not another wire schema.
  const sourceTypes = Array.isArray(source?.type) ? source.type : [source?.type];
  return {
    schema: { type: 'string', description: describe(description, 'Supply this value as JSON text (serialize it once).',
      schemaHint(source)) },
    codec: { kind: 'json', ...(sourceTypes.length && sourceTypes.every(type => types.has(type)) ? { types: sourceTypes } : {}) },
  };
}

function isPresenceXor(schema) {
  return schema.type === 'object' && Array.isArray(schema.oneOf) && schema.oneOf.length >= 2 && schema.oneOf.every(branch =>
    record(branch) && Object.keys(branch).length === 1 && branch.required?.length === 1
    && Object.hasOwn(schema.properties ?? {}, branch.required[0]));
}

// A transformed anyOf needs deterministic branch selection when decoding.
// Discriminated objects (e.g. presentation blocks) can keep their native shape.
function discriminator(branches) {
  return Object.keys(branches[0]?.properties ?? {}).find(key => {
    const values = branches.map(branch => branch.properties?.[key]?.enum);
    return branches.every(branch => branch.required?.includes(key))
      && values.every(list => list?.length && list.every(value => typeof value === 'string'))
      && new Set(values.flat()).size === values.flat().length;
  });
}

function project(source, { external, depth = 1, root = false }) {
  let description = typeof source?.description === 'string' ? source.description : '';
  const fallback = () => packed(source, description);
  if (!record(source) || depth > 9) return fallback();
  const next = { external, depth: depth + 1 };
  const shapeType = source.type;
  const stringShape = shapeType === 'string' || (Array.isArray(shapeType) && shapeType.includes('string'));

  // Keep the portable subset. The original source and tool checks remain the
  // execution contract. For external/unknown rules we preserve the full value
  // via JSON text instead of guessing how to translate the restriction.
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key) || annotations.has(key)) continue;
    if (!external && key === 'uniqueItems' && shapeType === 'array') {
      if (value) description = describe(description, 'Array items must be unique.');
    } else if (!external && key === 'oneOf' && isPresenceXor(source)) {
      description = describe(description, `Set exactly one of ${value.map(branch => branch.required[0]).join(', ')}; leave the others null.`);
    } else if (['minLength', 'maxLength', 'pattern'].includes(key) && stringShape) {
      description = describe(description, key === 'pattern' ? `Must match /${value}/.` :
        `${key === 'minLength' ? 'Minimum' : 'Maximum'} length: ${value} characters.`);
    } else return fallback();
  }
  const details = description ? { description } : {};
  if (Array.isArray(source.anyOf)) {
    if (root || !source.anyOf.length || Object.keys(source).some(key => key !== 'anyOf' && !annotations.has(key))) return fallback();
    const branches = source.anyOf.map(branch => project(branch, next));
    if (branches.every(branch => !branch.codec)) return { schema: { anyOf: branches.map(branch => branch.schema), ...details } };
    if (branches.length === 2 && source.anyOf.filter(branch => branch?.type === 'null').length === 1) {
      const inner = branches[source.anyOf[0].type === 'null' ? 1 : 0];
      // A packed branch is a string even when the inner JSON literal is null.
      if (!nullable(inner.schema)) return { schema: { anyOf: [inner.schema, { type: 'null' }], ...details },
        codec: { kind: 'nullable', value: inner.codec } };
    }
    const key = discriminator(branches.map(branch => branch.schema));
    if (!key) return fallback();
    return { schema: { anyOf: branches.map(branch => branch.schema), ...details }, codec: { kind: 'union', key,
      branches: branches.map(({ schema, codec }) => [schema.properties[key].enum, codec ?? null]) } };
  }

  const enumValues = Object.hasOwn(source, 'const') ? [source.const] : source.enum;
  if (enumValues !== undefined && (!Array.isArray(enumValues) || !enumValues.length || !enumValues.every(primitive)
      || new Set(enumValues).size !== enumValues.length || (source.enum && !enumValues.every(value => source.enum.includes(value))))) return fallback();
  const choices = shapeType === undefined && enumValues ? [...new Set(enumValues.map(value => value === null ? 'null' : typeof value))] :
    Array.isArray(shapeType) ? shapeType : [shapeType];
  if (!choices.length || choices.some(type => !types.has(type)) || new Set(choices).size !== choices.length
      || choices.length > 1 && (choices.length !== 2 || !choices.includes('null'))) return fallback();
  const type = choices.find(type => type !== 'null') ?? 'null';
  const correctlyTyped = value => choices.includes(value === null ? 'null' : typeof value)
    || (type === 'integer' && Number.isInteger(value));
  if (enumValues && (!enumValues.every(correctlyTyped) || !['string', 'number', 'integer', 'boolean', 'null'].includes(type))) return fallback();
  const schema = { type: choices.length === 1 ? type : [type, 'null'], ...details, ...(enumValues ? { enum: enumValues } : {}) };

  if (type === 'object') {
    if ((external && source.additionalProperties !== false)
        || (source.additionalProperties !== undefined && source.additionalProperties !== false)
        || (!record(source.properties) && source.additionalProperties !== false)) return fallback();
    const properties = Object.entries(source.properties || {});
    const required = source.required ?? [];
    if (!Array.isArray(required) || required.some(key => !Object.hasOwn(source.properties ?? {}, key))) return fallback();
    const codecs = [];
    schema.additionalProperties = false;
    schema.required = properties.map(([key]) => key);
    schema.properties = Object.fromEntries(properties.map(([key, child]) => {
      let { schema, codec } = project(child, next);
      if (!required.includes(key)) {
        // For third-party schemas, null can be a meaningful source value.
        // The inner string "null" is distinct from wire null (absent).
        if (external && nullable(schema)) ({ schema, codec } = packed(child, child?.description));
        if (external && codec?.kind === 'json') {
          schema.description = describe(schema.description, 'Send JSON text "null" for an explicit null value if the inner schema permits it.');
        }
        if (!nullable(schema)) {
          const { description: hint, ...nonNull } = schema;
          const optionalType = typeof nonNull.type === 'string'
            ? { ...nonNull, type: [nonNull.type, 'null'] }
            : { anyOf: [nonNull, { type: 'null' }] };
          if (optionalType.enum) optionalType.enum = [...optionalType.enum, null];
          schema = { ...optionalType, ...(hint ? { description: hint } : {}) };
        }
        codecs.push([key, true, codec ?? null]);
      } else if (codec) codecs.push([key, false, codec]);
      return [key, schema];
    }));
    return { schema, codec: codecs.length ? { kind: 'object', fields: codecs } : null };
  }
  if (type === 'array') {
    if (source.items === undefined || Array.isArray(source.items)) return fallback();
    const { schema: items, codec } = project(source.items, next);
    schema.items = items;
    for (const key of ['minItems', 'maxItems']) if (Object.hasOwn(source, key)) {
      if (!Number.isSafeInteger(source[key]) || source[key] < 0) return fallback();
      schema[key] = source[key];
    }
    return { schema, codec: codec ? { kind: 'array', item: codec } : null };
  }
  if (['integer', 'number'].includes(type)) {
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (Object.hasOwn(source, key)) {
      if (!Number.isFinite(source[key]) || key === 'multipleOf' && source[key] <= 0) return fallback();
      schema[key] = source[key];
    }
  }
  return { schema, codec: null };
}

// Documented per-schema budgets. Deep/large third-party schemas fall back to a
// bounded wire shape rather than causing the whole catalogue to fail upstream.
function withinBudget(schema) {
  let properties = 0, enums = 0, characters = 0, fits = true;
  function visit(node) {
    if (node.properties) for (const [name, child] of Object.entries(node.properties)) {
      properties++;
      characters += name.length;
      visit(child);
    }
    if (node.enum) {
      const length = node.enum.reduce((size, value) => size + (typeof value === 'string' ? value.length : 0), 0);
      if (node.enum.length > 250 && length > 15000) fits = false;
      characters += length;
      enums += node.enum.length;
    }
    if (node.items) visit(node.items);
    node.anyOf?.forEach(visit);
  }
  visit(schema);
  return fits && properties <= 5000 && enums <= 1000 && characters <= 120000;
}

function hasOmissions(codec) {
  if (codec?.kind === 'object') return codec.fields.some(([, optional, child]) => optional || hasOmissions(child));
  if (codec?.kind === 'array') return hasOmissions(codec.item);
  if (codec?.kind === 'nullable') return hasOmissions(codec.value);
  if (codec?.kind === 'union') return codec.branches.some(([, child]) => hasOmissions(child));
  return false;
}

/** Project an actual outgoing Responses tool list, including raw function
 * declarations from extraBody. Server-owned (non-function) tools are native. */
export function projectResponsesTools(tools, { external = false } = {}) {
  const codecs = new Map();
  if (!Array.isArray(tools)) return { tools, codecs };
  const wireTools = tools.map(tool => {
    if (tool?.type !== 'function') return tool;
    const source = tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false };
    let { schema, codec } = project(source, { external: external || tool.name?.startsWith('mcp__'), root: true });
    if (schema.type !== 'object' || !withinBudget(schema)) {
      const fallback = packed(source);
      schema = { type: 'object', properties: { argumentsJson: fallback.schema }, required: ['argumentsJson'], additionalProperties: false };
      codec = { kind: 'root-json' };
    }
    if (codec) codecs.set(tool.name, codec);
    else codecs.delete(tool.name);
    const description = describe(tool.description, hasOmissions(codec) ? 'Use null for omitted optional fields.' : '');
    return { ...tool, ...(description ? { description } : {}), strict: true, parameters: schema };
  });
  return { tools: wireTools, codecs };
}

const invalidJson = () => new LLMToolInputError('OpenAI returned invalid JSON-encoded tool input');
function parsePacked(value) {
  if (typeof value !== 'string') throw invalidJson();
  try { return JSON.parse(value); } catch { throw invalidJson(); }
}

/** Decode only the declared paths, never arbitrary strings that look like JSON.
 * This same codec is used to verify persisted native replay items. */
export function decodeResponsesInput(input, codec) {
  if (!codec) return input;
  if (codec.kind === 'root-json') {
    const value = parsePacked(Object.hasOwn(input, 'argumentsJson') && input.argumentsJson);
    if (!record(value) || Object.keys(input).length !== 1) throw invalidJson();
    return value;
  }
  if (codec.kind === 'json') {
    const value = parsePacked(input);
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (codec.types && !codec.types.includes(type) && !(Number.isInteger(value) && codec.types.includes('integer'))) throw invalidJson();
    return value;
  }
  if (codec.kind === 'nullable') return input === null ? input : decodeResponsesInput(input, codec.value);
  if (codec.kind === 'array') return Array.isArray(input) ? input.map(item => decodeResponsesInput(item, codec.item)) : input;
  if (codec.kind === 'union') {
    const tag = record(input) && Object.hasOwn(input, codec.key) ? input[codec.key] : undefined;
    return decodeResponsesInput(input, codec.branches.find(([values]) => values.includes(tag))?.[1]);
  }
  if (codec.kind === 'object') {
    if (!record(input)) return input;
    const result = { ...input };
    for (const [key, optional, child] of codec.fields) {
      if (!Object.hasOwn(input, key)) continue;
      if (optional && input[key] === null) delete result[key];
      else Object.defineProperty(result, key, { value: decodeResponsesInput(input[key], child), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  throw invalidJson();
}

/** Reconstruct arguments for legacy/cross-provider history without native
 * state. Use the currently advertised shape for still-available tools only;
 * native replay above this boundary always preserves the original wire items. */
export function encodeResponsesInput(input, codec) {
  if (!codec) return input;
  if (codec.kind === 'root-json') return { argumentsJson: JSON.stringify(input) };
  if (codec.kind === 'json') return JSON.stringify(input);
  if (codec.kind === 'nullable') return input === null ? input : encodeResponsesInput(input, codec.value);
  if (codec.kind === 'array') return Array.isArray(input) ? input.map(item => encodeResponsesInput(item, codec.item)) : input;
  if (codec.kind === 'union') {
    const tag = record(input) && Object.hasOwn(input, codec.key) ? input[codec.key] : undefined;
    return encodeResponsesInput(input, codec.branches.find(([values]) => values.includes(tag))?.[1]);
  }
  if (codec.kind === 'object' && record(input)) {
    const result = { ...input };
    for (const [key, optional, child] of codec.fields) {
      if (Object.hasOwn(input, key) || optional) Object.defineProperty(result, key, {
        value: Object.hasOwn(input, key) ? encodeResponsesInput(input[key], child) : null,
        enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }
  return input;
}

/** Keep only the decode plan needed by the actual response. No tool schemas or
 * descriptions are persisted. Absent metadata remains valid for old history. */
export function responsesArgumentProjection(items, codecs) {
  if (!codecs.size || !Array.isArray(items)) return undefined;
  const names = new Set(items.filter(item => item?.type === 'function_call').map(item => item.name));
  const tools = [...codecs].filter(([name]) => names.has(name));
  return tools.length ? { version: 1, tools } : undefined;
}
