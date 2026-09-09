import { createHash } from 'node:crypto';

export const MAX_PROVIDER_STATE_BYTES = 4 * 1024 * 1024;
const PROTOCOLS = new Set(['openai-responses', 'anthropic']);
const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const clone = value => structuredClone(value);
const nonempty = value => typeof value === 'string' && value.length > 0;

export class ProviderStateError extends Error {
  constructor(reason) {
    super(`Provider continuation cannot be replayed safely: ${reason}`);
    this.name = 'ProviderStateError';
    this.code = 'PROVIDER_STATE_INVALID';
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function providerProjectionDigest(message) {
  return hash(stable({ content: message.content || '', toolCalls: (message.toolCalls || []).map(tc => ({
    id: tc.id, name: tc.name, input: tc.input ?? {},
  })) }));
}

export function providerStateBytes(state) {
  try { return Buffer.byteLength(JSON.stringify(state)); } catch { return Infinity; }
}

export function requestOwner(identity) {
  const keys = ['instanceScope', 'ownerScope', 'sessionId', 'vpId', 'threadId'];
  if (!identity || !keys.every(key => nonempty(identity[key]))) return null;
  // Persist opaque scope fingerprints, never local absolute paths/usernames.
  return Object.fromEntries(keys.map(key => [key, hash(identity[key])]));
}

/** Stable, content-free identity: no prompt, model effort, request id or token. */
export function createPromptCacheKey(identity, context) {
  const owner = requestOwner(identity);
  if (!owner || !validOrigin(context?.origin)) return null;
  return `yeaft:${hash({ owner, origin: context.origin }).slice(7, 55)}`;
}

function validOrigin(origin) {
  return origin && ['providerId', 'endpointFingerprint', 'model', 'credentialScopeId'].every(key => nonempty(origin[key]));
}

/** Endpoint recognition is exact, never inferred from a Claude/GPT model name.
 * Unknown/translation endpoints opt in via the existing provider/model config.
 */
export function createProviderContext({ protocol, baseUrl, providerId, credentialScopeId, staticApiKey, model, capabilities = {} }) {
  let endpoint;
  try {
    const url = new URL(baseUrl || (protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'));
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    endpoint = url.toString().replace(/\/+$/, '');
  } catch { endpoint = ''; }
  const native = protocol === 'anthropic' ? endpoint === 'https://api.anthropic.com'
    : endpoint === 'https://api.openai.com/v1';
  // Official static-key routes work with existing configs. Persist only a
  // full cryptographic fingerprint, stable across restart and changed on key
  // rotation. Dynamic credentials and unknown proxies still require an explicit
  // account scope: an expiring access token is not a stable account identity.
  if (!nonempty(credentialScopeId) && native && nonempty(staticApiKey)) {
    credentialScopeId = hash(['static-api-key', staticApiKey]);
  }
  const enabled = key => capabilities.translation !== true && (capabilities[key] ?? native) === true;
  return {
    protocol,
    origin: { providerId: providerId || protocol, endpointFingerprint: hash(endpoint), model, credentialScopeId },
    capabilities: {
      nativeReasoningState: enabled('nativeReasoningState'),
      promptCaching: enabled('promptCaching'),
      parallelToolCalls: enabled('parallelToolCalls'),
    },
    diagnostics: { capabilitySource: capabilities.translation ? 'translation-disabled' : native ? 'native-endpoint' : 'custom-endpoint-unverified' },
  };
}

function projectItems(protocol, items) {
  const projection = { content: '', toolCalls: [] };
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new ProviderStateError('invalid item');
    if (protocol === 'openai-responses') {
      if (item.status && !['completed', 'incomplete'].includes(item.status)) throw new ProviderStateError('unfinished item');
      if (item.type === 'reasoning') {
        if (!nonempty(item.encrypted_content)) throw new ProviderStateError('reasoning missing encrypted content');
      } else if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type !== 'output_text' || typeof part.text !== 'string') throw new ProviderStateError('unsupported message part');
          projection.content += part.text;
        }
      } else if (item.type === 'function_call' && nonempty(item.call_id) && nonempty(item.name) && typeof item.arguments === 'string') {
        projection.toolCalls.push({ id: item.call_id, name: item.name, input: JSON.parse(item.arguments) });
      } else throw new ProviderStateError('unsupported Responses item');
    } else if (protocol === 'anthropic') {
      if (item.type === 'thinking' && typeof item.thinking === 'string' && nonempty(item.signature)) continue;
      if (item.type === 'redacted_thinking' && nonempty(item.data)) continue;
      if (item.type === 'text' && typeof item.text === 'string') projection.content += item.text;
      else if (item.type === 'tool_use' && nonempty(item.id) && nonempty(item.name) && item.input && typeof item.input === 'object') {
        projection.toolCalls.push({ id: item.id, name: item.name, input: item.input });
      } else throw new ProviderStateError('unsupported or unsigned Anthropic block');
    }
  }
  return projection;
}

export function createProviderState({ context, identity, items, responseId }) {
  if (!context?.capabilities?.nativeReasoningState || !validOrigin(context.origin) || !requestOwner(identity)) {
    if (context?.protocol === 'anthropic' && Array.isArray(items)
      && items.some(item => item?.type === 'tool_use')
      && items.some(item => ['thinking', 'redacted_thinking'].includes(item?.type))) {
      throw new ProviderStateError('signed tool turn requires nativeReasoningState, credentialScopeId and request identity; configure the verified native route and start a new context');
    }
    return null;
  }
  if (!Array.isArray(items) || !items.length) return null;
  const state = { version: 1, protocol: context.protocol, origin: clone(context.origin), owner: requestOwner(identity),
    ...(nonempty(responseId) ? { responseId } : {}), items: clone(items) };
  if (!PROTOCOLS.has(state.protocol)) return null;
  if (providerStateBytes(state) > MAX_PROVIDER_STATE_BYTES) throw new ProviderStateError('state exceeds byte budget');
  try { state.projectionDigest = providerProjectionDigest(projectItems(state.protocol, state.items)); }
  catch (error) {
    if (state.protocol === 'anthropic' && items.some(item => item?.type === 'tool_use')
      && items.some(item => ['thinking', 'redacted_thinking'].includes(item?.type))) throw error;
    return null; // unsupported/partial optional Responses state is not replayable
  }
  // Replay checks the final envelope, including its projection digest.
  if (providerStateBytes(state) > MAX_PROVIDER_STATE_BYTES) throw new ProviderStateError('state exceeds byte budget');
  return state;
}

function signedToolState(state, message) {
  return state?.protocol === 'anthropic' && message?.toolCalls?.length > 0
    && (!Array.isArray(state.items) || state.items.some(item => ['thinking', 'redacted_thinking'].includes(item?.type)));
}

export function bindProviderState(state, message) {
  if (!state) return null;
  if (state.projectionDigest !== providerProjectionDigest(message)) {
    if (signedToolState(state, message)) throw new ProviderStateError('assistant projection changed in signed tool turn');
    return null;
  }
  return state;
}

/** Returns cloned native payload only after all fences. Never mutates history. */
export function replayProviderState(message, context, identity) {
  const state = message?.providerState;
  if (!state) return null;
  let reason = '';
  if (state.version !== 1 || !PROTOCOLS.has(state.protocol)) reason = 'unknown schema';
  else if (!context?.capabilities?.nativeReasoningState || state.protocol !== context.protocol) reason = 'protocol/capability changed';
  else if (!validOrigin(context.origin) || hash(state.origin) !== hash(context.origin)) reason = 'origin changed';
  else if (!requestOwner(identity) || hash(state.owner) !== hash(requestOwner(identity))) reason = 'owner changed';
  else if (providerStateBytes(state) > MAX_PROVIDER_STATE_BYTES) reason = 'state exceeds byte budget';
  else {
    try {
      if (state.projectionDigest !== providerProjectionDigest(message)
        || state.projectionDigest !== providerProjectionDigest(projectItems(state.protocol, state.items))) reason = 'projection changed';
    } catch { reason = 'invalid native items'; }
  }
  if (reason) {
    if (signedToolState(state, message)) throw new ProviderStateError(reason);
    return null;
  }
  return clone(state.items);
}

/** Mandatory normalization AFTER extraBody; generated input/storage cannot be overridden. */
export function applyResponsesContinuity(body, { context, identity, input, onProviderDiagnostics }) {
  body.input = input;
  delete body.previous_response_id;
  body.store = false;
  if (context?.capabilities?.nativeReasoningState && validOrigin(context.origin) && requestOwner(identity)) {
    body.include = [...new Set([...(Array.isArray(body.include) ? body.include.filter(v => typeof v === 'string') : []), 'reasoning.encrypted_content'])];
  } else if (Array.isArray(body.include)) {
    body.include = body.include.filter(item => item !== 'reasoning.encrypted_content');
    if (!body.include.length) delete body.include;
  }
  delete body.prompt_cache_key;
  const key = context?.capabilities?.promptCaching && createPromptCacheKey(identity, context);
  if (key) body.prompt_cache_key = key;
  if (context?.capabilities?.parallelToolCalls) {
    // Capability permits parallel calls; it must not override an explicit opt-out.
    if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = true;
  } else delete body.parallel_tool_calls;
  onProviderDiagnostics?.({ ...context?.diagnostics, nativeReasoningState: Boolean(body.include?.includes('reasoning.encrypted_content')),
    promptCaching: key ? 'sent-unverified' : 'not-sent' });
}

/** At most three cache breakpoints. Never modifies signed assistant blocks. */
export function applyAnthropicCaching(body, context, onProviderDiagnostics) {
  // Own the policy after extraBody: do not mix automatic/long-TTL caching or
  // inherit caller breakpoints on unknown translation endpoints.
  delete body.cache_control;
  const withoutCache = block => {
    if (!block || typeof block !== 'object') return block;
    const { cache_control, ...rest } = block;
    return rest;
  };
  if (Array.isArray(body.system)) body.system = body.system.map(withoutCache);
  if (Array.isArray(body.tools)) body.tools = body.tools.map(withoutCache);
  if (Array.isArray(body.messages)) body.messages = body.messages.map(message => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map(block => {
      // Signed native blocks are immutable (and never eligible for caching).
      return ['thinking', 'redacted_thinking'].includes(block?.type) ? block : withoutCache(block);
    }) : message.content,
  }));
  let sent = false;
  if (context?.capabilities?.promptCaching && validOrigin(context.origin)) {
    if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system }];
    if (Array.isArray(body.system) && body.system.length) {
      body.system[body.system.length - 1] = { ...body.system.at(-1), cache_control: { type: 'ephemeral' } };
      sent = true;
    }
    if (body.tools?.length) {
      body.tools[body.tools.length - 1] = { ...body.tools.at(-1), cache_control: { type: 'ephemeral' } };
      sent = true;
    }
    // Latest complete user/tool_result boundary, not every growing message.
    for (let index = (body.messages?.length || 0) - 1; index >= 0; index--) {
      const message = body.messages[index];
      if (message.role !== 'user') continue;
      if (typeof message.content === 'string' && message.content) message.content = [{ type: 'text', text: message.content }];
      const last = Array.isArray(message.content) ? message.content.at(-1) : null;
      if (!['text', 'tool_result'].includes(last?.type)) continue;
      message.content[message.content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      sent = true;
      break;
    }
  }
  onProviderDiagnostics?.({ ...context?.diagnostics, promptCaching: sent ? 'sent-unverified' : 'not-sent' });
}

export function reasoningUsage(usage, protocol) {
  const value = protocol === 'anthropic' ? usage?.output_tokens_details?.thinking_tokens : usage?.output_tokens_details?.reasoning_tokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { reasoningTokens: value } : {};
}
