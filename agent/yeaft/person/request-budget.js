import { bytes, PROPOSAL_INSTRUCTIONS } from './contracts.js';

// Request reserves, not a minimum model window. Runtime still accounts for the
// actual Soul, state, scripts, attachments and execution transcript per dispatch.
export const PERSON_ENVELOPE_TOKENS_RESERVED = 1024;
export const PERSON_FINAL_CONTEXT_RESERVE_BYTES = 16384;
export const personFinalContextReserveBytes = executionInstructions =>
  Math.max(0, bytes(PROPOSAL_INSTRUCTIONS) - bytes(executionInstructions)) + PERSON_FINAL_CONTEXT_RESERVE_BYTES;

/** Static lower bound for the complete native execution schemas and both phases.
 * Schemas come from PersonCapabilities.executionTools(), never a copied list.
 * The service injects this value so the provider has no static tool/runtime imports. */
export function personMinimumRequestBytes(toolSchemas, executionInstructions) {
  return (toolSchemas.length ? bytes(toolSchemas) : 0) + bytes(executionInstructions) + 2 +
    personFinalContextReserveBytes(executionInstructions);
}

/** Standalone provider callers use the same schemas. Lazy imports avoid the
 * provider -> native tools -> Engine dependency cycle during module evaluation. */
export async function defaultPersonMinimumRequestBytes(config) {
  const [{ PersonCapabilities }, { EXECUTION_INSTRUCTIONS }, { allowedNativeToolIds }] = await Promise.all([
    import('./capabilities.js'), import('./execution-protocol.js'), import('./native-tools.js'),
  ]);
  const capabilities = new PersonCapabilities(null, null, { toolHost: { allowedToolIds: () => allowedNativeToolIds(config) } });
  return personMinimumRequestBytes(capabilities.executionTools(), EXECUTION_INSTRUCTIONS);
}
