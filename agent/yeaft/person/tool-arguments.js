import { fail, identifier, object, page, PersonError, text } from './contracts.js';
import { validateCreatedDefinition } from './created-capability-contract.js';
import { executionReadRequest } from './execution-evidence.js';
import { outputArgs } from './outputs.js';
import { personPresentation } from './presentation.js';
import { scriptInput } from './script-executor.js';
import { validateExecutionGoal } from './execution-goal.js';

/** Pre-dispatch schema check, deliberately separate from execution: rejection
 * here proves that no host effect has begun and can safely become tool feedback.
 * Runtime/IO exceptions after this boundary must never be classified as args. */
export function validateToolArguments(value, schema) {
  const matches = (input, rule) => {
    if (rule === false) return false;
    if (!rule || typeof rule !== 'object') return true;
    if (rule.allOf && !rule.allOf.every(item => matches(input, item))) return false;
    if (rule.not && matches(input, rule.not)) return false;
    if (rule.anyOf && !rule.anyOf.some(item => matches(input, item))) return false;
    if (rule.oneOf && rule.oneOf.filter(item => matches(input, item)).length !== 1) return false;
    if (rule.enum && !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(input))) return false;
    if (Object.hasOwn(rule, 'const') && JSON.stringify(rule.const) !== JSON.stringify(input)) return false;
    const type = input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input;
    if (rule.type && !(Array.isArray(rule.type) ? rule.type : [rule.type]).some(wanted => wanted === type || (wanted === 'integer' && Number.isInteger(input)))) return false;
    if (typeof input === 'string') {
      if (rule.minLength != null && [...input].length < rule.minLength) return false;
      if (rule.maxLength != null && [...input].length > rule.maxLength) return false;
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(input)) return false;
    }
    if (typeof input === 'number' && (!Number.isFinite(input) || (rule.minimum != null && input < rule.minimum) || (rule.maximum != null && input > rule.maximum))) return false;
    if (Array.isArray(input)) {
      if (rule.minItems != null && input.length < rule.minItems) return false;
      if (rule.maxItems != null && input.length > rule.maxItems) return false;
      if (rule.items && !input.every(item => matches(item, rule.items))) return false;
    } else if (input && typeof input === 'object') {
      if ((rule.required ?? []).some(key => !Object.hasOwn(input, key))) return false;
      for (const [key, item] of Object.entries(input)) {
        const known = Object.hasOwn(rule.properties ?? {}, key);
        if (!known && rule.additionalProperties === false) return false;
        if (known && !matches(item, rule.properties[key])) return false;
        if (!known && typeof rule.additionalProperties === 'object' && !matches(item, rule.additionalProperties)) return false;
      }
    }
    return true;
  };
  if (!matches(value, schema)) fail('INVALID_TOOL_INPUT');
}

/** Pure argument checks that JSON Schema cannot fully describe (UTF-8 budgets,
 * URLs and dependent fields). No repository, host dispatch or guest execution.
 * Only this boundary translates known validation errors to retry-safe feedback;
 * callers must not wrap capability execution in the same catch. */
export function validateCapabilityArguments({ id, args }) {
  try {
    if (id === 'Execution.goal') validateExecutionGoal(args);
    else if (id === 'Capability.create') validateCreatedDefinition(args);
    else if (id === 'Execution.read') executionReadRequest(args);
    else if (id === 'Output.publish') outputArgs(args);
    else if (id === 'PresentResponse') personPresentation(args);
    else if (id.startsWith('Script.')) {
      object(args, ['input']); scriptInput(args.input);
    } else if (id === 'catalog.view') {
      object(args, ['id']); identifier(args.id);
    } else if (id === 'catalog.search' || id === 'Recall') {
      object(args, id === 'Recall' ? ['kind', 'query', 'cursor', 'limit'] : ['query', 'cursor', 'limit'], id === 'Recall' ? ['kind'] : []);
      text(args.query ?? '', 200, true);
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      if (id === 'Recall' && !['messages', 'concepts'].includes(args.kind)) fail('INVALID_REQUEST');
      if (args.cursor != null) {
        if (id === 'Recall' && args.kind === 'messages' && !/^lm:[a-f0-9]{32}:\d{1,6}$/.test(args.cursor)) page({ cursor: args.cursor, limit });
        else identifier(args.cursor);
      }
    }
  } catch (error) {
    if (error instanceof PersonError && error.code === 'INVALID_REQUEST') fail('INVALID_TOOL_INPUT');
    throw error;
  }
}
