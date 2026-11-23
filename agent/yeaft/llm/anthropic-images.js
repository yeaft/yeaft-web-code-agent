import { imageDimensionsFromBase64 } from '../image-dimensions.js';

// Conservative Messages-compatible limits for native and gateway routes. The
// first-party API supports a higher total on some models; 20 is the point
// where the per-image dimension limit tightens, not the total allowance.
export const ANTHROPIC_IMAGE_LIMITS = Object.freeze({
  count: 100, manyCount: 20, manyEdge: 3000, edge: 8000, base64Bytes: 10_000_000,
});

export class LLMImageLimitError extends Error {
  constructor(message, { blockedByPrefix = false, gatewayManyImages = false } = {}) {
    super(message);
    this.name = 'LLMImageLimitError';
    this.reasonCode = 'request_image_limit';
    this.blockedByPrefix = blockedByPrefix;
    this.gatewayManyImages = gatewayManyImages;
    if (gatewayManyImages) this.statusCode = 400;
  }
}

export function classifyAnthropicImageLimit(status, body) {
  if (status !== 400) return null;
  let message = body;
  try {
    const error = JSON.parse(body);
    message = error?.error?.message ?? error?.message;
  } catch { /* Some gateways return plain text. */ }
  if (typeof message !== 'string' || !/\bmany[- ]image requests?\b/i.test(message)
      || !/\b(?:pixels?|dimensions?)\b/i.test(message)) return null;
  return new LLMImageLimitError('Anthropic gateway rejected the dimensions in a many-image request.', { gatewayManyImages: true });
}

// Follow protocol content containers only. In particular, never inspect tool
// input, arbitrary metadata, or strings that happen to contain image JSON.
function scanContent(content, visit, depth = 0) {
  if (!Array.isArray(content) || depth > 3) return;
  for (const part of content) {
    if (part?.type === 'image') visit(part);
    else if (isResultBlock(part)) scanContent(part.content, visit, depth + 1);
  }
}

const isResultBlock = part => typeof part?.type === 'string' && /(?:^|_)tool_result$/.test(part.type);

function imageInfo(part) {
  const data = part.source?.type === 'base64' && typeof part.source.data === 'string' ? part.source.data : null;
  const dimensions = data && imageDimensionsFromBase64(data);
  // Opaque images (URLs/files or unrecognized headers) still count. Do not
  // assume they satisfy the stricter dimensions or fetch them to find out.
  return { edge: dimensions ? Math.max(dimensions.width, dimensions.height) : null,
    bytes: data == null ? 0 : Buffer.byteLength(data, 'utf8') };
}

function emptyBudget() { return { count: 0, wide: false }; }

function fits(budget, image, limits) {
  return budget.count < limits.count && (image.edge ?? 0) <= limits.edge
    && image.bytes <= limits.base64Bytes
    && (budget.count < limits.manyCount || (!budget.wide && image.edge != null && image.edge <= limits.manyEdge));
}

function add(budget, image, limits) {
  budget.count++;
  budget.wide ||= image.edge == null || image.edge > limits.manyEdge;
}

export function validateAnthropicImages(body, limits) {
  const budget = emptyBudget();
  const inspect = part => {
    const info = imageInfo(part);
    if (!fits(budget, info, limits)) {
      throw new LLMImageLimitError('Anthropic image limits exceeded. Use fewer images or smaller previews; original images are preserved.');
    }
    add(budget, info, limits);
  };
  scanContent(body.system, inspect);
  for (const message of body.messages) scanContent(message.content, inspect);
}

function replaceContent(content, replace, depth = 0) {
  if (!Array.isArray(content) || depth > 3) return content;
  let changed = false;
  const next = [];
  for (const part of content) {
    if (part?.type === 'image') {
      const replacement = replace(part);
      if (replacement) {
        next.push(...replacement);
        changed = true;
        continue;
      }
    } else if (isResultBlock(part)) {
      const nested = replaceContent(part.content, replace, depth + 1);
      if (nested !== part.content) {
        next.push({ ...part, content: nested });
        changed = true;
        continue;
      }
    }
    next.push(part);
  }
  return changed ? next : content;
}

/** Fit an Anthropic request copy, never the conversation tape. The newest
 * images get first choice of slots; frozen rows and native items stay intact. */
export async function fitAnthropicImages(messages, limits, {
  frozenLength = 0, canRollover = false, preview, pathForImage, imageKey, isToolEvidence,
} = {}) {
  const budget = emptyBudget();
  const mutable = [];
  const seen = new Set();
  const fixed = part => {
    const info = imageInfo(part);
    if (!fits(budget, info, limits)) {
      throw new LLMImageLimitError('The frozen Anthropic context exceeds this route’s image limits. Original images are preserved.', { blockedByPrefix: true });
    }
    add(budget, info, limits);
    const key = imageKey?.(part);
    if (key) seen.add(key);
  };
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      if (message.providerState?.protocol === 'anthropic') scanContent(message.providerState.items, fixed);
      return;
    }
    if (index < frozenLength || message.role !== 'user' && message.role !== 'tool') scanContent(message.content, fixed);
    else {
      let ordinal = 0;
      scanContent(message.content, part => mutable.push({ part, index, ordinal: ordinal++ }));
    }
  });
  const newest = emptyBudget();
  const replacements = new Map();
  let omitted = 0, previews = 0, previewAttempts = 0;
  for (let i = mutable.length - 1; i >= 0; i--) {
    const { part, index, ordinal } = mutable[i];
    const info = imageInfo(part);
    let candidate = part;
    let effective = info;
    const deduplicate = messages[index].role === 'tool' || isToolEvidence?.(part);
    let duplicate = deduplicate && seen.has(imageKey?.(part));
    if (duplicate) candidate = null;
    else if (!fits(budget, info, limits)) {
      // In a signed continuation every mutable image is unsent. If removing
      // the prefix would make room alongside the newer images, use a fresh
      // segment rather than losing one image in a new comparison batch.
      const edge = budget.count >= limits.manyCount ? limits.manyEdge : limits.edge;
      const blockedByPrefix = canRollover && fits(newest, info, limits);
      // A user upload keeps its original through a fresh segment. A tool
      // screenshot is already a model preview by policy: a route-sized copy
      // is far cheaper and safer than rebuilding the whole context for it.
      if (blockedByPrefix && !deduplicate) {
        throw new LLMImageLimitError('The newest image cannot fit alongside the frozen Anthropic context.', { blockedByPrefix: true });
      }
      candidate = null;
      // Don't resize old images just to maximize the size of the request. An
      // individually oversized newest image still gets a usable preview.
      if (preview && (newest.count === 0 || blockedByPrefix) && previewAttempts < 3 && info.edge != null
          && fits(budget, { edge, bytes: 0 }, limits)) {
        previewAttempts++;
        candidate = await preview(part, edge, limits.base64Bytes);
        if (candidate) effective = imageInfo(candidate);
        if (candidate && !fits(budget, effective, limits)) candidate = null;
      }
      if (!candidate && blockedByPrefix) {
        throw new LLMImageLimitError('The newest image cannot fit alongside the frozen Anthropic context.', { blockedByPrefix: true });
      }
    }
    const key = candidate && imageKey?.(candidate);
    if (key && deduplicate && seen.has(key)) {
      duplicate = true;
      candidate = null;
    }
    if (candidate) {
      if (key) seen.add(key);
      add(budget, effective, limits);
      add(newest, effective, limits);
      if (candidate === part) continue;
      previews++;
    } else omitted++;
    const path = pathForImage?.(part);
    const reference = path ? ` Original: ${JSON.stringify(path)}.` : ' The original is unchanged; see the upload list or tool output for its path.';
    const needsSmallerCopy = (info.edge ?? 0) > limits.edge || info.bytes > limits.base64Bytes;
    const text = candidate ? `[Image preview sent to fit the model route. Dimensions or encoding may differ from the original.${reference}]`
      : duplicate ? `[Image not included in this result (duplicate content).${reference}]`
      : `[Image not sent: model route image limit.${reference} ${needsSmallerCopy
        ? 'Use a smaller copy or crop if more detail is needed.'
        : 'Reopen with ViewImage if needed for the current task.'}]`;
    if (!replacements.has(index)) replacements.set(index, new Map());
    replacements.get(index).set(ordinal, candidate ? [{ type: 'text', text }, candidate] : [{ type: 'text', text }]);
  }
  return { count: budget.count, omitted, previews, messages: replacements.size === 0 ? messages : messages.map((message, index) => {
    const edits = replacements.get(index);
    if (!edits) return message;
    let ordinal = 0;
    return { ...message, content: replaceContent(message.content, () => edits.get(ordinal++)) };
  }) };
}
