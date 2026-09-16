import { providerProjectionDigest, providerStateBytes, MAX_PROVIDER_STATE_BYTES, ProviderStateError } from './llm/provider-state.js';
/**
 * history-window.js — deterministic history shaping for provider requests.
 *
 * This module never calls an LLM, writes a summary, archives transcript rows,
 * or changes the persisted conversation. It builds bounded copies; callers may
 * replace a disposable runtime cache with one of those copies. The persisted
 * message history remains authoritative; Memory/Dream is the long-lived
 * semantic context.
 */

import { estimateTokens } from './conversation/persist.js';
import { isVisibleConversationRow } from './conversation/internal-control.js';
import { scoreRecallTurn } from './conversation/recall-relevance.js';
import { pairSanitize } from './pair-sanitize.js';
import { truncateToolResultIfNeeded } from './tools/registry.js';
import { countTurns, indexOfNthTurnFromEnd, sliceLastNTurns } from './turn-utils.js';

export const DEFAULT_KEEP_TOOL_TURNS = 3;
export const DEFAULT_RECENT_TURN_CAP = 25;
export const DEFAULT_MESSAGE_TOKEN_BUDGET = 32768;

// Runtime history is a cache, not a second transcript. Keep its hard cap
// independent from a user-configured provider budget so a large config cannot
// turn the bridge cache back into an unbounded transcript.
export const DEFAULT_RUNTIME_CACHE_TURN_CAP = 25;
export const DEFAULT_RUNTIME_CACHE_TOKEN_BUDGET = 32768;
export const DEFAULT_RUNTIME_CACHE_MESSAGE_CAP = 256;

const DEFAULT_PROVIDER_RECENT_TURNS = 10;
const MINIMUM_RECENT_PROVIDER_TURNS = 3;
const IMAGE_PART_TOKEN_COST = 1024;
const DOCUMENT_PART_TOKEN_COST = 2048;
const CONTENT_PART_FRAME_TOKENS = 2;
const TEXT_CHARS_PER_TOKEN = 4;
const BINARY_CHARS_PER_TOKEN = 16;
const OVERSIZED_ATTACHMENT_MARKER = '[attachment omitted from provider context budget]';

function serializeJsonValue(value) {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value ?? '');
    return typeof serialized === 'string' ? serialized : String(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function safeJsonTokenEstimate(value) {
  return estimateTokens(serializeJsonValue(value));
}

function thinkingBlockWirePart(block) {
  if (!block || typeof block !== 'object') return null;
  if (typeof block.signature !== 'string' || !block.signature) return null;
  if (block.redacted) {
    if (typeof block.data !== 'string') return null;
    return { type: 'redacted_thinking', data: block.data, signature: block.signature };
  }
  if (typeof block.thinking !== 'string') return null;
  return { type: 'thinking', thinking: block.thinking, signature: block.signature };
}

function validThinkingBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(block => thinkingBlockWirePart(block));
}

function estimateThinkingBlockTokens(block) {
  const part = thinkingBlockWirePart(block);
  return part ? estimateContentPartTokens(part) : safeJsonTokenEstimate(block);
}

function estimateThinkingBlocksTokens(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  return blocks.reduce((total, block) => total + estimateThinkingBlockTokens(block), CONTENT_PART_FRAME_TOKENS);
}

function binaryPayloadTokenEstimate(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  // Base64/image bytes are not text tokens, so do not charge them at the text
  // ratio. Still count a conservative wire/configuration cost; otherwise a
  // huge content part would bypass the request budget entirely.
  return Math.ceil(value.length / BINARY_CHARS_PER_TOKEN);
}

function partMetadataTokenEstimate(part, fields = []) {
  return fields.reduce((total, field) => {
    const value = part?.[field];
    return total + (typeof value === 'string' ? estimateTokens(value) : 0);
  }, 0);
}

/**
 * Estimate one provider content part. This is a guardrail, not a tokenizer;
 * the provider remains authoritative about the actual context limit.
 *
 * @param {unknown} part
 * @returns {number}
 */
export function estimateContentPartTokens(part) {
  if (typeof part === 'string') return estimateTokens(part);
  if (!part || typeof part !== 'object') return estimateTokens(String(part ?? ''));

  const type = String(part.type || '');
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return estimateTokens(typeof part.text === 'string' ? part.text : '');
  }
  if (type === 'thinking') {
    return 4 + estimateTokens(part.thinking || '') + estimateTokens(part.signature || '');
  }
  if (type === 'redacted_thinking') {
    return 4 + estimateTokens(part.data || '') + estimateTokens(part.signature || '');
  }
  if (type === 'image' || type === 'input_image') {
    const source = part.source && typeof part.source === 'object' ? part.source : part;
    return IMAGE_PART_TOKEN_COST
      + partMetadataTokenEstimate(part, ['title', 'alt', 'image_url'])
      + partMetadataTokenEstimate(source, ['url', 'media_type', 'mediaType'])
      + binaryPayloadTokenEstimate(source.data);
  }
  if (type === 'document' || type === 'input_file') {
    const source = part.source && typeof part.source === 'object' ? part.source : part;
    return DOCUMENT_PART_TOKEN_COST
      + partMetadataTokenEstimate(part, ['title', 'filename', 'file_data'])
      + partMetadataTokenEstimate(source, ['media_type', 'mediaType', 'url'])
      + binaryPayloadTokenEstimate(source.data);
  }
  if (type === 'tool_result') {
    return 4 + estimateContentTokens(part.content);
  }
  if (type === 'function_call_output') {
    return 4 + estimateTokens(serializeJsonValue(part.output));
  }
  return safeJsonTokenEstimate(part);
}

/**
 * Estimate string or array provider content, including multimodal parts.
 *
 * @param {unknown} content
 * @returns {number}
 */
export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    return CONTENT_PART_FRAME_TOKENS
      + content.reduce((total, part) => total + estimateContentPartTokens(part), 0);
  }
  if (content == null) return 0;
  return safeJsonTokenEstimate(content);
}

/**
 * Estimate the provider-token weight of one message.
 *
 * @param {object} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  let total = 2 + estimateContentTokens(message.content);
  // Responses ciphertext has a byte budget, not a text-token cost. Anthropic
  // thinking is plaintext and must be charged, without recounting the native
  // text/tool items already represented by content/toolCalls below.
  if (message.providerState && providerStateBytes(message.providerState) > MAX_PROVIDER_STATE_BYTES) {
    throw new ProviderStateError('state exceeds byte budget');
  }
  if (message.providerState?.protocol === 'anthropic') {
    const thinking = (message.providerState.items || [])
      .filter(item => ['thinking', 'redacted_thinking'].includes(item?.type));
    if (thinking.length > 0) total += estimateContentTokens(thinking);
  } else if (!message.providerState) {
    total += estimateThinkingBlocksTokens(message.thinkingBlocks);
  }
  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      total += 4;
      try {
        const input = typeof toolCall.input === 'string'
          ? toolCall.input
          : JSON.stringify(toolCall.input || {});
        total += estimateTokens(input);
      } catch {
        // Ignore malformed tool input in the approximate guardrail.
      }
      if (toolCall.name) total += estimateTokens(toolCall.name);
    }
  }
  if (message.toolCallId) total += 2;
  return total;
}

/**
 * @param {Array<object>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function hasContentAfterToolStrip(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (typeof part === 'string') return part.trim().length > 0;
      if (!part || typeof part !== 'object') return part != null;
      return typeof part.text === 'string' ? part.text.trim().length > 0 : true;
    });
  }
  return content != null;
}

function toolContentPartCallId(part) {
  if (!part || typeof part !== 'object') return null;
  return part.id || part.tool_use_id || part.call_id || null;
}

function stripToolContentParts(content, selectedCallIds = null) {
  if (!Array.isArray(content)) return content;
  return content.filter(part => {
    if (!part || typeof part !== 'object') return true;
    const isToolPart = part.type === 'tool_use'
      || part.type === 'tool_result'
      || part.type === 'function_call'
      || part.type === 'function_call_output';
    if (!isToolPart) return true;
    return selectedCallIds instanceof Set && selectedCallIds.has(toolContentPartCallId(part));
  });
}

/**
 * Remove old tool payloads from the provider copy while keeping ordinary user
 * and assistant text. The newest tool turns remain lossless so the active tool
 * protocol stays paired; pairSanitize runs after this transform.
 *
 * @param {Array<object>} messages
 * @param {{ keepToolTurns?: number }} [options]
 * @returns {Array<object>}
 */
export function stripToolNoiseFromOlderTurns(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const keepToolTurns = Number.isFinite(options.keepToolTurns) && options.keepToolTurns >= 0
    ? options.keepToolTurns
    : DEFAULT_KEEP_TOOL_TURNS;
  const cutIndex = indexOfNthTurnFromEnd(messages, keepToolTurns);
  if (cutIndex <= 0) return messages.map(message => ({ ...message }));

  const older = messages.slice(0, cutIndex);
  const recent = messages.slice(cutIndex);
  const cleanedOlder = [];
  for (const message of older) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'tool') continue;

    const next = { ...message };
    if (Array.isArray(next.toolCalls)) delete next.toolCalls;
    if (Array.isArray(next.thinkingBlocks)) delete next.thinkingBlocks;
    delete next.providerState;
    if (Array.isArray(next.content)) next.content = stripToolContentParts(next.content);
    if (next.role === 'assistant' && !hasContentAfterToolStrip(next.content)) continue;
    if (next.role === 'user' && Array.isArray(next.content) && next.content.length === 0) continue;
    cleanedOlder.push(next);
  }
  return [...cleanedOlder, ...recent.map(message => ({ ...message }))];
}

function stripAllToolNoise(messages) {
  const cleaned = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.role === 'tool') continue;
    const next = { ...message };
    if (Array.isArray(next.toolCalls)) delete next.toolCalls;
    if (Array.isArray(next.thinkingBlocks)) delete next.thinkingBlocks;
    delete next.providerState;
    if (Array.isArray(next.content)) next.content = stripToolContentParts(next.content);
    if (next.role === 'assistant' && !hasContentAfterToolStrip(next.content)) continue;
    if (next.role === 'user' && Array.isArray(next.content) && next.content.length === 0) continue;
    cleaned.push(next);
  }
  return cleaned;
}

function truncateTextToTokens(text, tokenBudget) {
  if (typeof text !== 'string' || tokenBudget <= 0) return '';
  if (estimateTokens(text) <= tokenBudget) return text;
  let out = text.slice(0, Math.max(0, Math.floor(tokenBudget * TEXT_CHARS_PER_TOKEN)));
  while (out && estimateTokens(out) > tokenBudget) out = out.slice(0, -1);
  return out;
}

function attachmentMarkerPart(remainingTokens) {
  if (remainingTokens < estimateTokens(OVERSIZED_ATTACHMENT_MARKER)) return null;
  return { type: 'text', text: OVERSIZED_ATTACHMENT_MARKER };
}

function fitContentToBudget(content, tokenBudget) {
  if (tokenBudget <= 0) return typeof content === 'string' ? '' : [];
  if (typeof content === 'string') return truncateTextToTokens(content, tokenBudget);
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      const serialized = serializeJsonValue(content);
      return estimateTokens(serialized) <= tokenBudget
        ? content
        : truncateTextToTokens(serialized, tokenBudget);
    }
    return content;
  }

  let remaining = Math.max(0, tokenBudget - CONTENT_PART_FRAME_TOKENS);
  const out = [];
  for (const part of content) {
    const cost = estimateContentPartTokens(part);
    if (typeof part === 'string') {
      const text = truncateTextToTokens(part, remaining);
      if (text) {
        out.push(text);
        remaining -= estimateTokens(text);
      }
      continue;
    }
    if (!part || typeof part !== 'object') {
      if (cost <= remaining) {
        out.push(part);
        remaining -= cost;
      }
      continue;
    }

    const type = String(part.type || '');
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = truncateTextToTokens(typeof part.text === 'string' ? part.text : '', remaining);
      if (text) {
        out.push({ ...part, text });
        remaining -= estimateTokens(text);
      }
      continue;
    }

    if (cost <= remaining) {
      out.push({ ...part });
      remaining -= cost;
      continue;
    }

    // A non-binary structured part may still contain useful text/content.
    // Let the generic text marker path below handle it only when it is
    // genuinely not safely sliceable.
    if (type === 'tool_result' || type === 'function_call_output') {
      const marker = attachmentMarkerPart(remaining);
      if (marker) {
        out.push(marker);
        remaining -= estimateTokens(marker.text);
      }
      continue;
    }

    // A binary part cannot be safely sliced. Replace it with a valid text
    // marker rather than forwarding an oversized/invalid base64 payload.
    const marker = attachmentMarkerPart(remaining);
    if (marker) {
      out.push(marker);
      remaining -= estimateTokens(marker.text);
    }
  }
  return out;
}

function messageOverheadTokens(message) {
  return estimateMessageTokens({ ...message, content: '' });
}

function hasProviderContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (typeof part === 'string') return part.trim().length > 0;
      if (!part || typeof part !== 'object') return part != null;
      if (typeof part.text === 'string') return part.text.trim().length > 0;
      return part.type !== 'tool_use' && part.type !== 'tool_result'
        && part.type !== 'function_call' && part.type !== 'function_call_output';
    });
  }
  return content != null;
}

function dropEmptyAssistantRows(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(message => {
    if (!message || message.role !== 'assistant') return true;
    return hasProviderContent(message.content)
      || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
      || Boolean(message.providerState)
      || (Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0);
  });
}

function shrinkMessageToBudget(message, tokenBudget) {
  if (!message || typeof message !== 'object') return message;
  const next = { ...message };
  const hadThinkingBlocks = Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0;
  const originalThinkingBlocks = validThinkingBlocks(message.thinkingBlocks);
  const messageWithoutThinking = { ...message };
  delete messageWithoutThinking.thinkingBlocks;
  const contentBudget = Math.max(0, tokenBudget - messageOverheadTokens(messageWithoutThinking));
  next.content = fitContentToBudget(message.content, contentBudget);

  // Anthropic signed thinking blocks are atomic. Never truncate their payload
  // or signature. Keep the complete block set only if it fits; otherwise omit
  // the private replay state from this provider copy. Historical text/tool
  // context remains usable, and the durable transcript remains untouched.
  let thinkingBlocksKept = false;
  if (hadThinkingBlocks && originalThinkingBlocks.length === 0) {
    delete next.thinkingBlocks;
  } else if (estimateMessageTokens({ ...next, thinkingBlocks: originalThinkingBlocks }) <= tokenBudget) {
    if (originalThinkingBlocks.length > 0) {
      next.thinkingBlocks = originalThinkingBlocks;
      thinkingBlocksKept = true;
    } else {
      delete next.thinkingBlocks;
    }
  } else {
    delete next.thinkingBlocks;
  }

  // Anthropic requires the signed thinking blocks that precede a tool_use
  // within the same assistant turn. If the atomic thinking replay cannot fit,
  // drop the complete tool arc from this provider copy; pairSanitize removes
  // its role:'tool' rows below. Keeping toolCalls without their signed prefix
  // would produce a protocol-invalid request.
  if (hadThinkingBlocks && !thinkingBlocksKept && Array.isArray(next.toolCalls)) {
    delete next.toolCalls;
  }

  // If tool metadata alone exceeds the allowance, remove the tool calls from
  // this provider copy. pairSanitize will remove any now-orphaned tool rows;
  // the durable transcript remains untouched.
  if (estimateMessageTokens(next) > tokenBudget && Array.isArray(next.toolCalls)) {
    delete next.toolCalls;
  }
  if (next.providerState && providerProjectionDigest(next) !== next.providerState.projectionDigest) {
    // Modified assistant projections must never resurrect removed text/calls.
    const signed = next.providerState.protocol === 'anthropic'
      && next.providerState.items?.some(item => ['thinking', 'redacted_thinking'].includes(item?.type));
    delete next.providerState;
    if (signed) delete next.toolCalls;
  }
  return next;
}

function dropOldestHistoryUntilBudget(messages, tokenBudget) {
  let out = pairSanitize(messages);
  let turns = countTurns(out);
  while (estimateMessagesTokens(out) > tokenBudget && out.length > 0 && turns > 1) {
    const next = pairSanitize(sliceLastNTurns(out, turns - 1));
    if (next.length === out.length) break;
    out = next;
    turns = countTurns(out);
  }
  return out;
}

function dropOldestHistoryUntilMessageCap(messages, maxMessageCount) {
  let out = pairSanitize(messages);
  let turns = countTurns(out);
  while (out.length > maxMessageCount && turns > 1) {
    const next = pairSanitize(sliceLastNTurns(out, turns - 1));
    if (next.length === out.length) break;
    out = next;
    turns = countTurns(out);
  }
  if (out.length > maxMessageCount) {
    out = pairSanitize(out.slice(-maxMessageCount));
  }
  return out;
}

function providerUnits(messages) {
  const units = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls) || message.toolCalls.length === 0) {
      units.push([message]);
      index += 1;
      continue;
    }

    const callIds = new Set(message.toolCalls.map(call => call?.id).filter(Boolean));
    const unit = [message];
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]?.role === 'tool') {
      const toolMessage = messages[nextIndex];
      if (callIds.has(toolMessage.toolCallId)) unit.push(toolMessage);
      nextIndex += 1;
    }
    units.push(unit);
    index = nextIndex;
  }
  return units;
}

function fitProviderUnit(unit, tokenBudget) {
  if (!Array.isArray(unit) || unit.length === 0 || tokenBudget <= 0) return [];
  const [owner, ...toolMessages] = unit;
  const isToolUnit = owner?.role === 'assistant'
    && Array.isArray(owner.toolCalls)
    && owner.toolCalls.length > 0
    && toolMessages.length > 0;
  if (!isToolUnit) {
    const fitted = shrinkMessageToBudget(owner, tokenBudget);
    return dropEmptyAssistantRows([fitted]);
  }

  // Fit the assistant owner first. Signed thinking blocks are atomic; when
  // they cannot fit, shrinkMessageToBudget removes the toolCalls as well, and
  // this whole unit is dropped so no tool_result can become orphaned.
  const fittedOwner = shrinkMessageToBudget(owner, tokenBudget);
  if (!Array.isArray(fittedOwner.toolCalls) || fittedOwner.toolCalls.length === 0) return [];

  const fitted = [fittedOwner];
  let remaining = Math.max(0, tokenBudget - estimateMessageTokens(fittedOwner));
  for (const toolMessage of toolMessages) {
    if (messageOverheadTokens(toolMessage) > remaining) return [];
    const fittedTool = shrinkMessageToBudget(toolMessage, remaining);
    const fittedToolTokens = estimateMessageTokens(fittedTool);
    if (fittedToolTokens > remaining) return [];
    fitted.push(fittedTool);
    remaining -= fittedToolTokens;
  }
  return fitted;
}

function fitMessagesToBudget(messages, tokenBudget) {
  let out = dropOldestHistoryUntilBudget(pairSanitize(messages), tokenBudget);
  if (estimateMessagesTokens(out) <= tokenBudget) return dropEmptyAssistantRows(out);

  // Treat assistant(toolCalls)+tool rows as one provider unit. The newest unit
  // gets the remaining budget first, but its paired tool results share that
  // budget with the assistant owner. This preserves valid tool protocol shape
  // while bounding serialized object output and signed thinking together.
  const units = providerUnits(out);
  const fittedUnits = Array.from({ length: units.length }, () => []);
  let reserved = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const fitted = fitProviderUnit(units[index], Math.max(0, tokenBudget - reserved));
    fittedUnits[index] = fitted;
    reserved += estimateMessagesTokens(fitted);
  }
  out = fittedUnits.flat();
  return dropEmptyAssistantRows(pairSanitize(out));
}

function truncateToolResultsForModel(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.map(message => {
    if (!message || message.role !== 'tool') return { ...message };
    return {
      ...message,
      content: truncateToolResultIfNeeded(message.content, {
        toolName: message.name || message.toolName || 'tool_result',
        language: options.language,
      }),
    };
  });
}

const HISTORY_SOURCE_INDEX = Symbol('historySourceIndex');

function withHistorySourceIndexes(messages, offset = 0) {
  return messages.map((message, index) => (
    message && typeof message === 'object'
      ? { ...message, [HISTORY_SOURCE_INDEX]: Number.isInteger(message[HISTORY_SOURCE_INDEX])
        ? message[HISTORY_SOURCE_INDEX] : offset + index }
      : message
  ));
}

function withoutHistorySourceIndexes(messages) {
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    const next = { ...message };
    delete next[HISTORY_SOURCE_INDEX];
    return next;
  });
}

function completeToolCallIds(messages) {
  const resultIds = new Set(messages
    .filter(message => message?.role === 'tool' && typeof message.toolCallId === 'string')
    .map(message => message.toolCallId));
  const ids = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (let callIndex = message.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const id = message.toolCalls[callIndex]?.id;
      if (typeof id === 'string' && resultIds.has(id)) ids.push(id);
    }
  }
  return ids;
}

function enrichTextBaselineWithTools(textBaseline, toolSource, selectedCallIds) {
  const messagesBySourceIndex = new Map();
  for (const message of textBaseline) {
    if (Number.isInteger(message?.[HISTORY_SOURCE_INDEX])) {
      messagesBySourceIndex.set(message[HISTORY_SOURCE_INDEX], { ...message });
    }
  }

  for (const source of toolSource) {
    const sourceIndex = source?.[HISTORY_SOURCE_INDEX];
    if (!Number.isInteger(sourceIndex)) continue;
    if (source.role === 'tool') {
      if (selectedCallIds.has(source.toolCallId)) {
        messagesBySourceIndex.set(sourceIndex, { ...source });
      }
      continue;
    }
    if (source.role !== 'assistant' || !Array.isArray(source.toolCalls)) continue;

    const selectedCalls = source.toolCalls.filter(call => selectedCallIds.has(call?.id));
    if (selectedCalls.length === 0) continue;
    const selectedIds = new Set(selectedCalls.map(call => call.id));
    const baseline = messagesBySourceIndex.get(sourceIndex);
    const owner = baseline ? { ...baseline } : { ...source };
    owner.toolCalls = selectedCalls;
    if (Array.isArray(source.thinkingBlocks)) owner.thinkingBlocks = source.thinkingBlocks;
    if (Array.isArray(source.content)) {
      const baselineContent = Array.isArray(baseline?.content)
        ? baseline.content
        : stripToolContentParts(source.content);
      const selectedParts = source.content.filter(part => selectedIds.has(toolContentPartCallId(part)));
      owner.content = [...baselineContent, ...selectedParts];
    }
    if (source.providerState) {
      if (providerProjectionDigest(owner) === source.providerState.projectionDigest) {
        owner.providerState = source.providerState;
      } else {
        delete owner.providerState;
        // A changed text baseline or call subset cannot replay this signed
        // turn. Leave its text-only baseline and let pairing drop the results.
        if (hasSignedProviderThinking(source)) continue;
      }
    }
    messagesBySourceIndex.set(sourceIndex, owner);
  }

  return pairSanitize([...messagesBySourceIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message));
}

function preservesTextBaseline(textBaseline, enriched) {
  const projected = stripAllToolNoise(enriched);
  if (projected.length !== textBaseline.length) return false;
  return textBaseline.every((baseline, index) => {
    const candidate = projected[index];
    return candidate?.[HISTORY_SOURCE_INDEX] === baseline?.[HISTORY_SOURCE_INDEX]
      && candidate?.role === baseline?.role
      && serializeJsonValue(candidate?.content) === serializeJsonValue(baseline?.content);
  });
}

function hasSignedProviderThinking(message) {
  return message.providerState?.protocol === 'anthropic'
    && message.providerState.items?.some(item => ['thinking', 'redacted_thinking'].includes(item?.type));
}

function completeToolCallGroups(messages) {
  const completeIds = new Set(completeToolCallIds(messages));
  const groups = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    const ids = message.toolCalls.map(call => call?.id);
    if (hasSignedProviderThinking(message)) {
      // A signed assistant projection binds every call, including their order.
      // A missing result makes the whole group ineligible, not a smaller turn.
      if (ids.length > 0 && ids.every(id => completeIds.has(id))) groups.push(ids);
    } else {
      groups.push(...ids.reverse().filter(id => completeIds.has(id)).map(id => [id]));
    }
  }
  return groups;
}

function addOptionalRecentToolPairs(textBaseline, toolSource, options) {
  const selectedCallIds = new Set();
  let out = pairSanitize(textBaseline);
  for (const callIds of completeToolCallGroups(toolSource)) {
    const trialIds = new Set([...selectedCallIds, ...callIds]);
    const trial = enrichTextBaselineWithTools(textBaseline, toolSource, trialIds);
    if (trial.length > options.maxMessageCount) continue;
    const fitted = fitMessagesToBudget(trial, options.messageTokenBudget);
    const fittedCallIds = new Set(completeToolCallIds(fitted));
    if (![...trialIds].every(id => fittedCallIds.has(id))) continue;
    if (!preservesTextBaseline(textBaseline, fitted)) continue;
    for (const callId of callIds) selectedCallIds.add(callId);
    out = fitted;
  }
  return out;
}

/**
 * Build a bounded, pair-safe copy for one provider request.
 *
 * The transform is deterministic and non-persistent:
 *   1. keep at most `recentTurnCap` turns;
 *   2. build the text-only history baseline and fit it to row/token caps;
 *   3. consider complete tool/function pairs from the newest `keepToolTurns`;
 *   4. add each recent pair only while the fitted text baseline still fits;
 *   5. remove orphan tool pairs.
 *
 * Tool replay is optional enrichment. Text history gets the hard row/token
 * budget first so even recent function payloads cannot evict textual turns.
 *
 * @param {Array<object>} snapshot
 * @param {{ messageTokenBudget?: number, recentTurnCap?: number, maxMessageCount?: number, keepToolTurns?: number, language?: string }} [options]
 * @returns {Array<object>}
 */
export function trimSnapshotForBudget(snapshot, options = {}) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];

  const recentTurnCap = Number.isFinite(options.recentTurnCap) && options.recentTurnCap > 0
    ? Math.floor(options.recentTurnCap)
    : DEFAULT_RECENT_TURN_CAP;
  const messageTokenBudget = Number.isFinite(options.messageTokenBudget) && options.messageTokenBudget > 0
    ? Math.floor(options.messageTokenBudget)
    : DEFAULT_MESSAGE_TOKEN_BUDGET;
  const maxMessageCount = Number.isFinite(options.maxMessageCount) && options.maxMessageCount > 0
    ? Math.floor(options.maxMessageCount)
    : DEFAULT_RUNTIME_CACHE_MESSAGE_CAP;

  const keepToolTurns = Number.isFinite(options.keepToolTurns) && options.keepToolTurns >= 0
    ? Math.floor(options.keepToolTurns)
    : DEFAULT_KEEP_TOOL_TURNS;
  const bounded = withHistorySourceIndexes(sliceLastNTurns(snapshot, recentTurnCap));
  let textBaseline = stripAllToolNoise(bounded);
  textBaseline = dropOldestHistoryUntilMessageCap(textBaseline, maxMessageCount);
  textBaseline = fitMessagesToBudget(textBaseline, messageTokenBudget);

  const toolCutIndex = indexOfNthTurnFromEnd(bounded, keepToolTurns);
  const recentToolSource = keepToolTurns > 0
    ? bounded.slice(toolCutIndex < 0 ? 0 : toolCutIndex)
    : [];
  const truncatedToolSource = truncateToolResultsForModel(recentToolSource, { language: options.language });
  const enriched = addOptionalRecentToolPairs(textBaseline, truncatedToolSource, {
    maxMessageCount,
    messageTokenBudget,
  });
  return withoutHistorySourceIndexes(enriched);
}

// Unlike the legacy runtime-cache slicer, provider buckets never infer user
// identity from text. A repeated question is still a new human turn.
function bucketSourceIds(message) {
  return [...new Set([
    ...(Array.isArray(message?.sourceMessageIds) ? message.sourceMessageIds : []),
    ...(Array.isArray(message?.entry?.sourceMessageIds) ? message.entry.sourceMessageIds : []),
    message?._persistedMessageId, message?.id, message?.messageId,
    message?.anchorMessageId,
  ].filter(id => typeof id === 'string' && id))];
}

function bucketUserKeys(message) {
  const keys = bucketSourceIds(message).map(id => `message:${id}`);
  if (message?.clientMessageId) keys.push(`client:${message.clientMessageId}`);
  if (message?.entryId) keys.push(`entry:${message.entryId}`);
  return keys;
}

function bucketUserBoundary(message) {
  if (message?.role !== 'user' || !isVisibleConversationRow(message)) return false;
  // Anthropic's tool-result carrier is not a human turn boundary.
  return !Array.isArray(message.content) || message.content.some(part => (
    typeof part === 'string' || !['tool_result', 'function_call_output'].includes(part?.type)
  ));
}

function bucketSequence(message) {
  for (const value of [message?.userSeq, message?.entryStartSeq, message?.seq]) {
    if (Number.isFinite(value)) return value;
  }
  for (const id of bucketSourceIds(message)) {
    const match = /^m(\d+)$/.exec(id);
    if (match) return Number(match[1]);
  }
  return null;
}

function bucketTextMessages(messages) {
  return stripAllToolNoise(messages.filter(message => (
    isVisibleConversationRow(message)
    && (message?.role === 'user' || message?.role === 'assistant')
  )));
}

function bucketTurn(messages, index, supplied = {}) {
  const indexedMessages = withHistorySourceIndexes(messages, index ?? 0);
  const user = indexedMessages.find(bucketUserBoundary);
  const sourceIds = [...new Set(indexedMessages.flatMap(bucketSourceIds))];
  const keys = [...new Set(indexedMessages.filter(bucketUserBoundary).flatMap(bucketUserKeys))];
  if (supplied.id) keys.push(`turn:${supplied.id}`);
  if (keys.length === 0 && index != null) keys.push(`snapshot:${index}`);
  const text = bucketTextMessages(indexedMessages);
  return {
    ...supplied,
    id: supplied.id || keys[0] || `snapshot:${index}`,
    keys,
    sourceIds,
    userSeq: Number.isFinite(supplied.userSeq) ? supplied.userSeq : bucketSequence(user),
    index,
    messages: indexedMessages,
    text,
    tokens: estimateMessagesTokens(text),
  };
}

function splitBucketTurns(snapshot) {
  const turns = [];
  let messages = [];
  let keys = new Set();
  let startIndex = 0;
  for (let index = 0; index < snapshot.length; index += 1) {
    const message = snapshot[index];
    if (bucketUserBoundary(message)) {
      const nextKeys = bucketUserKeys(message);
      const sameTurn = nextKeys.some(key => keys.has(key));
      if (messages.length && !sameTurn) {
        turns.push(bucketTurn(messages, startIndex));
        messages = [];
        keys = new Set();
      }
      if (!messages.length) startIndex = index;
      nextKeys.forEach(key => keys.add(key));
    }
    // A leading assistant fragment cannot become a complete historical turn.
    if (messages.length || bucketUserBoundary(message)) messages.push(message);
  }
  if (messages.length) turns.push(bucketTurn(messages, startIndex));
  return turns;
}

function bucketOverlap(left, right) {
  const ids = new Set(left.sourceIds);
  const keys = new Set(left.keys);
  return right.sourceIds.some(id => ids.has(id)) || right.keys.some(key => keys.has(key));
}

function bucketCap(value, fallback, maximum = Infinity) {
  return Number.isFinite(value) && value >= 0
    ? Math.min(maximum, Math.floor(value)) : fallback;
}

function scoreBucketTurn(turn, options, stats = {}) {
  // Relevance belongs to conversation/recall-relevance, not the budget layer.
  // Indexed candidates already carry scores; raw/evicted turns use injection.
  const result = typeof options.scoreTurn === 'function'
    ? options.scoreTurn({
      id: turn.id, userSeq: turn.userSeq, messages: turn.text,
      sourceMessageIds: turn.sourceIds,
    }, options.prompt || '')
    : Number.isFinite(turn.score)
      ? { score: turn.score, matchedTerms: turn.matchedTerms }
      : scoreRecallTurn(options.prompt || '', turn.text.map(message => (
        typeof message.content === 'string' ? message.content
          : Array.isArray(message.content) ? message.content.map(part => (
            typeof part === 'string' ? part : part?.text || ''
          )).join('\n') : ''
      )).join('\n'), stats);
  const score = typeof result === 'number' ? result : result?.score;
  return {
    ...turn,
    score: Number.isFinite(score) && score > 0 && result?.eligible !== false ? score : 0,
    matchedTerms: Array.isArray(result?.matchedTerms) ? result.matchedTerms : [],
  };
}

function bucketBefore(candidate, boundary) {
  if (!boundary) return true;
  if (candidate.index != null && boundary.index != null) return candidate.index < boundary.index;
  return Number.isFinite(candidate.userSeq) && Number.isFinite(boundary.userSeq)
    && candidate.userSeq < boundary.userSeq;
}

function describeBucket(turns, messages = turns.flatMap(turn => turn.text)) {
  return {
    turnCount: turns.length,
    turnIds: turns.map(turn => turn.id),
    sourceMessageIds: [...new Set(turns.flatMap(turn => turn.sourceIds))],
    tokenCount: estimateMessagesTokens(messages),
    messageCount: messages.length,
  };
}

/**
 * Emergency projection for the three-turn floor. It reuses the existing
 * deterministic message fitter against a disposable provider copy, while
 * sharing rows/tokens across the newest three human boundaries. The durable
 * transcript is never rewritten.
 */
function compressRecentTurns(turns, tokenBudget, messageCap) {
  const fitted = [];
  let tokens = tokenBudget;
  let rows = messageCap;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const remaining = turns.length - index;
    let turnTokens = Math.floor(tokens / remaining);
    const minimumRowTokens = Array.isArray(turn.text[0]?.content) ? 5 : 3;
    const turnRows = Math.min(Math.floor(rows / remaining), Math.floor(turnTokens / minimumRowTokens));
    if (turnTokens < minimumRowTokens || turnRows < 1) continue;
    const selected = turn.text.length <= turnRows ? turn.text
      : [turn.text[0], ...(turnRows > 1 ? turn.text.slice(-(turnRows - 1)) : [])];
    const text = [];
    for (let row = 0; row < selected.length; row += 1) {
      const allowance = Math.floor(turnTokens / (selected.length - row));
      const message = shrinkMessageToBudget(selected[row], allowance);
      const cost = estimateMessageTokens(message);
      if (cost <= allowance && hasProviderContent(message.content)) {
        text.push(message);
        turnTokens -= cost;
      } else if (row === 0) break;
    }
    if (!text.some(bucketUserBoundary)) continue;
    const cost = estimateMessagesTokens(text);
    fitted.push({ ...turn, text, tokens: cost });
    tokens -= cost;
    rows -= text.length;
  }
  return fitted;
}

/**
 * Recompute provider history from untrimmed candidates; never mutate/cache the
 * result in the transcript. Past human turn boundaries are retained when the
 * configured recent window fits; tools are optional enrichment, newest first.
 *
 * The active turn is outside both buckets and outside the history budget. Its
 * opening user row is protected by the later whole-request fitter. Prefer ten
 * complete recent turns, reducing the oldest end down to three. If that floor
 * cannot fit, omit recall and compress only those three turns; historical tool
 * replay then narrows from the normal newest three turns to the newest one.
 * Related recall otherwise uses remaining history budget and stays optional and
 * complete. External recall must have
 * comparable userSeq/source identities to establish
 * that it predates recent/current history; unknown chronology fails closed.
 *
 * @param {Array<object>} snapshot Untrimmed history plus the active execution.
 * @param {{ prompt?: string, relatedTurns?: Array<object>, recentTurnCap?: number,
 * relatedTurnCap?: number, messageTokenBudget?: number, maxMessageCount?: number,
 * keepToolTurns?: number, language?: string, currentTurnStartIndex?: number,
 * scoreTurn?: (turn: object, prompt: string) => (number|object) }} [options]
 * @returns {{messages: Array<object>, meta: object}}
 */
export function buildHistoryBuckets(snapshot, options = {}) {
  const source = Array.isArray(snapshot) ? snapshot : [];
  const tokenBudget = bucketCap(options.messageTokenBudget, DEFAULT_MESSAGE_TOKEN_BUDGET);
  const messageCap = bucketCap(options.maxMessageCount, DEFAULT_RUNTIME_CACHE_MESSAGE_CAP);
  const recentCap = bucketCap(options.recentTurnCap, DEFAULT_PROVIDER_RECENT_TURNS);
  const relatedCap = bucketCap(options.relatedTurnCap, 5, 5);
  const keepToolTurns = bucketCap(options.keepToolTurns, DEFAULT_KEEP_TOOL_TURNS);
  const allTurns = splitBucketTurns(source);
  const currentStart = Number.isInteger(options.currentTurnStartIndex)
    ? Math.max(0, Math.min(source.length, options.currentTurnStartIndex))
    : (allTurns.at(-1)?.index ?? source.length);
  const currentSource = source.slice(currentStart);
  const currentIdentity = bucketTurn(currentSource, currentStart);
  // The 32K/default budget owns only rows before currentStart. Keep the active
  // turn intact here; whole-request fitting runs at every provider boundary and
  // uses the actual model context window. Tool bodies may still receive their
  // normal deterministic per-result truncation, without touching the durable
  // transcript or charging that copy against history.
  const current = pairSanitize(truncateToolResultsForModel(
    currentSource.map(message => ({ ...message })), { language: options.language },
  ));
  const availableTokens = tokenBudget;
  const availableRows = messageCap;
  let duplicateCount = 0;
  const past = [];
  for (const turn of splitBucketTurns(source.slice(0, currentStart))) {
    if (bucketOverlap(turn, currentIdentity)) {
      duplicateCount += 1;
      continue;
    }
    const previous = past.findIndex(other => turn.keys.some(key => other.keys.includes(key)));
    if (previous >= 0) {
      // Fan-out may return to the same human question after another question.
      // Keep the first user boundary's position, with all complementary replies
      // in their source order. Only repeated stable message identities disappear.
      const original = past[previous];
      const seen = new Set();
      const messages = [...original.messages, ...turn.messages].filter(message => {
        const ids = bucketSourceIds(message);
        const repeated = ids.length > 0 && ids.every(id => seen.has(id));
        ids.forEach(id => seen.add(id));
        return !repeated;
      });
      past[previous] = bucketTurn(messages, original.index);
      duplicateCount += 1;
    } else past.push(turn);
  }
  let candidates = past.map(turn => scoreBucketTurn(turn, options));
  if (typeof options.scoreTurn !== 'function') {
    // Evicted in-memory turns pass the same distinctiveness gate as indexed
    // turns. Otherwise ubiquitous topic words bypass the index rejection.
    const termDocumentFrequency = Object.create(null);
    for (const turn of candidates) {
      for (const term of turn.matchedTerms) {
        const key = term.toLocaleLowerCase();
        termDocumentFrequency[key] = (termDocumentFrequency[key] || 0) + 1;
      }
    }
    const stats = { sampleSize: past.length, termDocumentFrequency };
    candidates = past.map(turn => scoreBucketTurn(turn, options, stats));
  }
  for (const entry of Array.isArray(options.relatedTurns) ? options.relatedTurns : []) {
    if (!Array.isArray(entry?.messages) || !entry.messages.some(bucketUserBoundary)) continue;
    const turn = bucketTurn(entry.messages, null, entry);
    if (bucketOverlap(turn, currentIdentity)) { duplicateCount += 1; continue; }
    const duplicate = candidates.find(other => bucketOverlap(turn, other));
    if (duplicate) {
      duplicateCount += 1;
      // Preserve the complete untrimmed snapshot turn, but retain the index's
      // qualified score when no raw-turn scorer is installed.
      if (typeof options.scoreTurn !== 'function' && entry.score > (duplicate.score || 0)) {
        duplicate.score = entry.score;
        duplicate.matchedTerms = entry.matchedTerms || [];
      }
      continue;
    }
    candidates.push(scoreBucketTurn(turn, options));
  }
  const eligible = candidates.filter(turn => turn.score > 0 && turn.text.length
    && (currentSource.length === 0 || bucketBefore(turn, currentIdentity)
      // A runtime prompt can lack its persisted sequence. An older persisted
      // past-turn boundary is still a safe fence; never guess from text/time.
      || (turn.index == null && currentIdentity.userSeq == null && past.length > 0
        && bucketBefore(turn, past.at(-1)))));
  // Recent text has first claim on history budget. Drop whole oldest turns down
  // to the three-turn floor before projecting that floor more aggressively.
  let recent = [];
  let recentTokens = 0;
  let recentRows = 0;
  let compressedRecentFloor = false;
  const recentCandidates = recentCap > 0 ? past.slice(-recentCap) : [];
  for (let index = recentCandidates.length - 1; index >= 0; index -= 1) {
    const turn = recentCandidates[index];
    if (recentTokens + turn.tokens > availableTokens
      || recentRows + turn.text.length > availableRows) break;
    recent.unshift(turn);
    recentTokens += turn.tokens;
    recentRows += turn.text.length;
  }
  const recentFloor = Math.min(MINIMUM_RECENT_PROVIDER_TURNS, recentCandidates.length);
  if (recent.length < recentFloor) {
    compressedRecentFloor = true;
    recent = compressRecentTurns(recentCandidates.slice(-recentFloor), availableTokens, availableRows);
  }
  let remainingTokens = availableTokens - recent.reduce((total, turn) => total + turn.tokens, 0);
  let remainingRows = availableRows - recent.reduce((total, turn) => total + turn.text.length, 0);
  const related = [];
  const ranked = compressedRecentFloor ? [] : eligible.slice().sort((a, b) => b.score - a.score
    || (a.userSeq ?? a.index ?? 0) - (b.userSeq ?? b.index ?? 0));
  for (const turn of ranked) {
    if (related.length >= relatedCap) break;
    if (!bucketBefore(turn, recent[0]) || recent.some(other => bucketOverlap(turn, other))
      || related.some(other => bucketOverlap(turn, other)
        // Mixed-source turns require a proven order in either direction.
        // Unknown sequence is not zero; skip rather than invent chronology.
        || (!bucketBefore(turn, other) && !bucketBefore(other, turn)))) continue;
    if (turn.tokens > remainingTokens || turn.text.length > remainingRows) continue;
    related.push(turn);
    remainingTokens -= turn.tokens;
    remainingRows -= turn.text.length;
  }
  related.sort((a, b) => bucketBefore(a, b) ? -1 : bucketBefore(b, a) ? 1 : 0);

  const relatedMessages = related.flatMap(turn => turn.text);
  const recentBaseline = recent.flatMap(turn => turn.text);
  // Enrich only after both complete-text buckets and the active turn are paid.
  // Tool protocol is useful only for immediate continuity; unlike visible text,
  // it never reaches farther back than the configured recent tool window.
  const effectiveKeepToolTurns = compressedRecentFloor ? Math.min(1, keepToolTurns) : keepToolTurns;
  const recentToolSource = effectiveKeepToolTurns > 0
    ? recent.slice(-effectiveKeepToolTurns).flatMap(turn => turn.messages).filter(isVisibleConversationRow)
    : [];
  const recentMessages = withoutHistorySourceIndexes(addOptionalRecentToolPairs(
    recentBaseline,
    truncateToolResultsForModel(recentToolSource, { language: options.language }),
    {
      messageTokenBudget: availableTokens - estimateMessagesTokens(relatedMessages),
      maxMessageCount: availableRows - relatedMessages.length,
    },
  ));
  const messages = [...relatedMessages.map(message => ({ ...message })), ...recentMessages, ...current];
  const retained = [...related, ...recent];
  const droppedTurns = past.filter(turn => !retained.some(other => bucketOverlap(turn, other)
    || turn === other));
  return {
    messages,
    meta: {
      recent: describeBucket(recent, recentMessages),
      related: { ...describeBucket(related), scores: related.map(turn => ({
        id: turn.id, score: turn.score, matchedTerms: turn.matchedTerms,
      })) },
      current: {
        ...describeBucket(currentSource.length ? [currentIdentity] : [], current),
        startIndex: currentStart,
        originalTokenCount: estimateMessagesTokens(currentSource),
      },
      budget: {
        messageTokenBudget: tokenBudget, maxMessageCount: messageCap,
        recentTurnCap: recentCap, relatedTurnCap: relatedCap,
        minimumRecentTurns: recentFloor,
        compressedRecentFloor,
        effectiveKeepToolTurns,
        relatedReservedTokens: 0, availableHistoryTokens: availableTokens,
        usedTokens: estimateMessagesTokens([...relatedMessages, ...recentMessages]),
        usedMessages: relatedMessages.length + recentMessages.length,
        requestTokensBeforeWholeRequestFit: estimateMessagesTokens(messages),
        requestMessagesBeforeWholeRequestFit: messages.length,
      },
      dropped: {
        pastTurnCount: droppedTurns.length,
        sourceMessageIds: [...new Set(droppedTurns.flatMap(turn => turn.sourceIds))],
        duplicateTurnCount: duplicateCount,
        oversizedTurnCount: candidates.filter(turn => turn.tokens > availableTokens
          || turn.text.length > availableRows).length,
        unselectedRelatedTurnCount: eligible.length - related.length,
      },
    },
  };
}

/**
 * Fit one provider-request copy to the actual model window. The caller tells
 * us where current-turn rows begin; only the prefix is subject to the history
 * budget. If the complete request is still too large, old history disappears
 * first, followed by the oldest disposable current-turn protocol units. The
 * source array and durable transcript are never mutated.
 *
 * @param {Array<object>} messages
 * @param {{ contextWindow:number, systemTokens?:number, toolSchemaTokens?:number,
 * outputReserve?:number, historyMessageCount?:number, historyTokenBudget?:number,
 * maxMessageCount?:number, language?:string }} options
 * @returns {{messages:Array<object>, meta:object}}
 */
export function fitProviderRequestToContext(messages, options = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const contextWindow = bucketCap(options.contextWindow, 0);
  const staticTokens = bucketCap(options.systemTokens, 0)
    + bucketCap(options.toolSchemaTokens, 0)
    + bucketCap(options.outputReserve, 0);
  const messageBudget = Math.max(0, contextWindow - staticTokens);
  const split = Math.max(0, Math.min(source.length,
    Number.isInteger(options.historyMessageCount) ? options.historyMessageCount : 0));
  // The runtime cache's 256-row cap is a history-storage concern, not a model
  // request limit. Current-turn tool loops may legitimately exceed it while
  // remaining inside the model window. Only enforce a cap when the caller
  // explicitly supplies one.
  const messageCap = options.maxMessageCount === undefined
    ? Number.MAX_SAFE_INTEGER
    : bucketCap(options.maxMessageCount, Number.MAX_SAFE_INTEGER);
  const historySource = source.slice(0, split);
  const currentSource = source.slice(split);

  let current = pairSanitize(truncateToolResultsForModel(
    currentSource.map(message => ({ ...message })), { language: options.language },
  ));
  if (estimateMessagesTokens(current) > messageBudget || current.length > messageCap) {
    const fitted = [];
    if (current.length > 0 && messageBudget >= 2 && messageCap > 0) {
      const first = shrinkMessageToBudget(stripAllToolNoise([current[0]])[0], messageBudget);
      if (first && estimateMessageTokens(first) <= messageBudget) fitted.push(first);
      let tokens = messageBudget - estimateMessagesTokens(fitted);
      let rows = messageCap - fitted.length;
      const units = providerUnits(pairSanitize(current.slice(1)));
      const tail = [];
      for (let index = units.length - 1; index >= 0; index -= 1) {
        const unit = fitProviderUnit(units[index], tokens);
        const cost = estimateMessagesTokens(unit);
        if (unit.length > rows || cost > tokens) continue;
        tail.unshift(unit);
        tokens -= cost;
        rows -= unit.length;
      }
      fitted.push(...tail.flat());
    }
    current = pairSanitize(fitted);
  }

  const configuredHistoryBudget = bucketCap(
    options.historyTokenBudget, DEFAULT_MESSAGE_TOKEN_BUDGET,
  );
  const remainingTokens = Math.max(0, Math.min(
    configuredHistoryBudget,
    messageBudget - estimateMessagesTokens(current),
  ));
  const remainingRows = Math.max(0, messageCap - current.length);
  const history = remainingTokens >= 2 && remainingRows > 0
    ? trimSnapshotForBudget(historySource, {
        messageTokenBudget: remainingTokens,
        maxMessageCount: remainingRows,
        recentTurnCap: Number.MAX_SAFE_INTEGER,
        language: options.language,
      })
    : [];
  const fittedMessages = [...history, ...current];
  return {
    messages: fittedMessages,
    meta: {
      contextWindow,
      staticTokens,
      messageBudget,
      estimatedTokens: staticTokens + estimateMessagesTokens(fittedMessages),
      historyMessagesBefore: historySource.length,
      historyMessagesAfter: history.length,
      currentMessagesBefore: currentSource.length,
      currentMessagesAfter: current.length,
      droppedHistoryMessages: historySource.length - history.length,
      droppedCurrentMessages: currentSource.length - current.length,
    },
  };
}

/**
 * Bound the Session-level runtime history cache. This is deliberately stricter
 * than the provider configuration: the cache is only a disposable source
 * snapshot, while ConversationStore retains the complete transcript.
 *
 * @param {Array<object>} snapshot
 * @param {{ language?: string }} [options]
 * @returns {Array<object>}
 */
export function trimHistoryCacheForRuntime(snapshot, options = {}) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];
  let trimmed = sliceLastNTurns(snapshot, DEFAULT_RUNTIME_CACHE_TURN_CAP);
  trimmed = stripToolNoiseFromOlderTurns(trimmed, {
    keepToolTurns: DEFAULT_KEEP_TOOL_TURNS,
  });
  trimmed = dropOldestHistoryUntilMessageCap(trimmed, DEFAULT_RUNTIME_CACHE_MESSAGE_CAP);
  trimmed = truncateToolResultsForModel(trimmed, { language: options.language });
  trimmed = pairSanitize(trimmed);
  return fitMessagesToBudget(trimmed, DEFAULT_RUNTIME_CACHE_TOKEN_BUDGET);
}
