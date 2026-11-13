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

/** Recoverable capacity failure, distinct from invalid ownership/signatures. */
export class ProviderContextBudgetError extends ProviderStateError {
  constructor(reason) {
    super(reason);
    this.name = 'ProviderContextBudgetError';
    this.message = `Provider context budget requires compaction: ${reason}`;
    this.code = 'PROVIDER_CONTEXT_BUDGET';
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

/** Opaque credential identity; never persist the credential itself. */
export function createCredentialScopeId(credential, kind = 'static-api-key') {
  return nonempty(credential) ? hash([kind, credential]) : undefined;
}

/** Protocol selects the native block format, not a hostname allowlist.
 * Optional wire features still require a recognized endpoint or explicit opt-in.
 * Translation routes can explicitly disable native replay.
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
  // A static gateway credential fences accounts just as an official key does.
  // Dynamic providers pass the scope of the source credential used for exchange,
  // not a rotating access token or a provider name shared by every account.
  if (!nonempty(credentialScopeId)) credentialScopeId = createCredentialScopeId(staticApiKey);
  const enabled = key => capabilities.translation !== true
    && (capabilities[key] ?? (key === 'nativeReasoningState' && protocol === 'anthropic' ? Boolean(endpoint) : native)) === true;
  return {
    protocol,
    origin: { providerId: providerId || protocol, endpointFingerprint: hash(endpoint), model, credentialScopeId },
    capabilities: {
      nativeReasoningState: enabled('nativeReasoningState'),
      promptCaching: enabled('promptCaching'),
      parallelToolCalls: enabled('parallelToolCalls'),
      eagerInputStreaming: protocol === 'anthropic' && enabled('eagerInputStreaming'),
    },
    diagnostics: { capabilitySource: capabilities.translation ? 'translation-disabled' : native ? 'native-endpoint' : 'custom-endpoint-protocol' },
  };
}

/** Models with documented prefix binding and native runtime instruction updates.
 * Do not apply modern-only wire requirements to legacy extended-thinking routes.
 */
export function supportsAnthropicPreservedThinking(model) {
  const id = String(model || '').toLowerCase().split('/').at(-1)
    .replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '');
  const suffix = '(?:[-@]\\d{8})?(?:-v\\d+(?::\\d+)?)?(?:-latest)?$';
  return new RegExp('^claude-(?:fable|mythos)-5(?:[-.][12])?' + suffix).test(id)
    || new RegExp('^claude-opus-(?:5(?:[.-]5)?|4[.-]8)' + suffix).test(id)
    || new RegExp('^claude-(?:sonnet|haiku)-5[.-]5' + suffix).test(id);
}

// These are replay-only server content, never client tool calls. Keep the list
// explicit: accepting arbitrary *_tool_result or unknown blocks would also let
// malformed/unsigned reasoning hide inside a supposedly replayable envelope.
const ANTHROPIC_TOOL_USES = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);
const ANTHROPIC_SERVER_RESULTS = new Set([
  'web_search_tool_result', 'web_fetch_tool_result', 'code_execution_tool_result',
  'bash_code_execution_tool_result', 'text_editor_code_execution_tool_result',
  'tool_search_tool_result', 'mcp_tool_result',
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function opaqueAnthropicBlock(item) {
  if (item.type === 'fallback') return nonempty(item.model);
  if (['server_tool_use', 'mcp_tool_use'].includes(item.type)) {
    return nonempty(item.id) && nonempty(item.name) && record(item.input);
  }
  if (ANTHROPIC_SERVER_RESULTS.has(item.type)) {
    return nonempty(item.tool_use_id) && (typeof item.content === 'string'
      || (item.content !== null && typeof item.content === 'object'));
  }
  return item.type === 'container_upload' && nonempty(item.file_id);
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
      if (opaqueAnthropicBlock(item)) continue;
      if (item.type === 'text' && typeof item.text === 'string') projection.content += item.text;
      else if (item.type === 'tool_use' && nonempty(item.id) && nonempty(item.name) && item.input && typeof item.input === 'object') {
        projection.toolCalls.push({ id: item.id, name: item.name, input: item.input });
      } else throw new ProviderStateError('unsupported or unsigned Anthropic block');
    }
  }
  return projection;
}

export function createProviderState({ context, identity, items, responseId, requestBody }) {
  if (!context?.capabilities?.nativeReasoningState || !validOrigin(context.origin) || !requestOwner(identity)) {
    if (context?.protocol === 'anthropic' && Array.isArray(items)
      && items.some(item => ANTHROPIC_TOOL_USES.has(item?.type))
      && items.some(item => ['thinking', 'redacted_thinking'].includes(item?.type))) {
      const missing = [!context?.capabilities?.nativeReasoningState && 'nativeReasoningState (disabled by route policy)',
        !validOrigin(context?.origin) && 'credentialScopeId (configure a route credential)',
        !requestOwner(identity) && 'request identity (instance/owner/session/VP/thread)'].filter(Boolean).join(', ');
      throw new ProviderStateError(`signed tool turn requires ${missing}; preserve the signed response and correct the route before retrying`);
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
    if (state.protocol === 'anthropic' && items.some(item => ANTHROPIC_TOOL_USES.has(item?.type))
      && items.some(item => ['thinking', 'redacted_thinking'].includes(item?.type))) throw error;
    return null; // unsupported/partial optional Responses state is not replayable
  }
  if (state.protocol === 'anthropic' && requestBody && hasThinking(items)
      && supportsAnthropicPreservedThinking(requestBody.model)) {
    state.requestPrefix = anthropicRequestPrefix(requestBody);
  }
  // Replay checks the final envelope, including its projection digest.
  if (providerStateBytes(state) > MAX_PROVIDER_STATE_BYTES) throw new ProviderStateError('state exceeds byte budget');
  return state;
}

const hasThinking = items => items.some(item => ['thinking', 'redacted_thinking'].includes(item?.type));
const withoutCacheMarker = block => {
  if (!block || typeof block !== 'object') return block;
  const { cache_control, ...rest } = block;
  return rest;
};

// Only strip protocol cache markers, not identically named keys in tool inputs.
function anthropicRequestPrefix(body, messageCount = body?.messages?.length) {
  if (!Array.isArray(body?.messages) || !Number.isSafeInteger(messageCount)
    || messageCount < 0 || messageCount > body.messages.length) {
    throw new ProviderStateError('invalid Anthropic request prefix');
  }
  const thinkingChain = [];
  const messages = body.messages.slice(0, messageCount).map(message => ({ ...message,
    content: Array.isArray(message.content) ? message.content.filter(block => {
      if (!['thinking', 'redacted_thinking'].includes(block?.type)) return true;
      thinkingChain.push(hash(stable(block)));
      return false;
    }).map(withoutCacheMarker) : typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }] : message.content,
  }));
  return { version: 1, digest: hash(stable({
    // Adding a cache breakpoint converts shorthand text into a block array.
    // Canonicalize that equivalent representation, not arbitrary business data.
    system: Array.isArray(body.system) ? body.system.map(withoutCacheMarker)
      : typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system,
    tools: Array.isArray(body.tools) ? body.tools.map(withoutCacheMarker) : [],
    messages,
  })), thinkingChain };
}

/** Validate finalized Anthropic wire prefixes after translation, caching and extraBody.
 * Entries refer to the actual wire assistant index, not a UnifiedMessage index.
 * No prompt content is persisted; legacy states without prefix metadata remain readable.
 * This deliberately fails closed, never rewriting or silently dropping signed blocks.
 * @param {object} body finalized wire request (system, tools, messages)
 * @param {{state: object, messageIndex: number}[]} entries replayed native states
 */
export function validateAnthropicRequestPrefixes(body, entries) {
  for (const { state, messageIndex } of entries) {
    if (state?.protocol !== 'anthropic' || !state.requestPrefix) continue;
    const expected = state.requestPrefix;
    if (expected.version !== 1 || !Array.isArray(expected.thinkingChain)
      || body?.messages?.[messageIndex]?.role !== 'assistant') {
      throw new ProviderStateError('invalid Anthropic request prefix metadata');
    }
    const actual = anthropicRequestPrefix(body, messageIndex);
    // Removing only the oldest reasoning is allowed; a gap or reintroduced block
    // is not. Message edits remain fenced by the independent content digest.
    const offset = expected.thinkingChain.length - actual.thinkingChain.length;
    if (expected.digest !== actual.digest || offset < 0
      || actual.thinkingChain.some((value, index) => value !== expected.thinkingChain[offset + index])) {
      throw new ProviderStateError('Anthropic request prefix changed; keep system, tools and earlier messages unchanged or start a new context');
    }
  }
}

function signedToolState(state, message) {
  return state?.protocol === 'anthropic'
    && (message?.toolCalls?.length > 0 || state.items?.some?.(item => ANTHROPIC_TOOL_USES.has(item?.type)))
    && (!Array.isArray(state.items) || hasThinking(state.items));
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

/** Which counters the provider actually reported, before legacy zero defaults. */
export function hasUsageCounts(usage, fields = ['input_tokens', 'output_tokens']) {
  return fields.every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0);
}

export function reportedUsageFields(usage, protocol) {
  const counts = { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens,
    cacheReadTokens: protocol === 'anthropic' ? usage?.cache_read_input_tokens : usage?.input_tokens_details?.cached_tokens,
    cacheWriteTokens: protocol === 'anthropic' ? usage?.cache_creation_input_tokens : undefined,
    reasoningTokens: protocol === 'anthropic' ? usage?.output_tokens_details?.thinking_tokens : usage?.output_tokens_details?.reasoning_tokens };
  return Object.keys(counts).filter(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
}
