const TOOL_LIKE_BLOCK_TYPES = new Set([
  'tool_use',
  'tool_call',
  'function_call',
  'server_tool_use',
  'call',
]);

/**
 * Claude Code stream-json has changed its tool-call block spelling more than
 * once. Normalize every known tool-like assistant content block to the
 * Anthropic-compatible `tool_use` shape used by the rest of the app.
 *
 * @param {unknown} block
 * @returns {unknown}
 */
export function normalizeAssistantContentBlock(block) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'tool_use') return block;
  if (!TOOL_LIKE_BLOCK_TYPES.has(block.type)) return block;

  const input = normalizeToolInput(block);
  const name = block.name
    || block.tool_name
    || block.toolName
    || block.function?.name
    || block.action?.name
    || input?.name
    || 'tool';
  const id = block.id
    || block.tool_use_id
    || block.toolUseId
    || block.tool_call_id
    || block.toolCallId
    || block.call_id
    || block.callId
    || stableFallbackToolId(name, block);

  return {
    type: 'tool_use',
    id,
    name,
    input,
  };
}

/**
 * @param {unknown} content
 * @returns {unknown}
 */
export function normalizeAssistantContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map(normalizeAssistantContentBlock);
}

/**
 * @param {unknown} message
 * @returns {unknown}
 */
export function normalizeClaudeMessage(message) {
  if (!message || typeof message !== 'object') return message;
  if (message.type !== 'assistant' || !message.message) return message;
  const content = message.message.content;
  const normalized = normalizeAssistantContent(content);
  if (normalized === content) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: normalized,
    },
  };
}

/**
 * Stream events should only emit text deltas from actual text blocks. Newer
 * Claude Code builds may emit text-looking deltas while a tool-call block is
 * being assembled (`call`, transient id, JSON argument text). Those bytes are
 * transport detail, not assistant prose; the final complete assistant message
 * carries the real tool_use block.
 *
 * @param {string|undefined|null} blockType
 * @returns {boolean}
 */
export function shouldForwardTextDeltaForBlockType(blockType) {
  if (!blockType) return true; // Back-compat for older CLIs without start events.
  return blockType === 'text';
}

function stableFallbackToolId(name, block) {
  const raw = stableStringify(block);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${name}-${hash.toString(36)}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeToolInput(block) {
  const raw = block.input
    ?? block.arguments
    ?? block.args
    ?? block.parameters
    ?? block.function?.arguments
    ?? block.action?.arguments
    ?? {};

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
      return { arguments: raw };
    }
  }
  if (raw && typeof raw === 'object') return raw;
  return {};
}
