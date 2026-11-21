import { createHash } from 'node:crypto';
import { makeModelImagePreview, MODEL_IMAGE_TARGET_BYTES } from './model-image-preview.js';
import { ProviderContextBudgetError } from './llm/provider-state.js';

const RECENT_TOOL_BATCHES = 3;
// Rolling a signed prefix costs a summary. Keep a short image history even on
// this route, but don't buy a summary for every three tiny tool batches.
const FROZEN_TOOL_IMAGE_COUNT = 12;
const FROZEN_TOOL_IMAGE_BASE64_CHARS = 3 * 1024 * 1024;
const MAX_NEW_PREVIEWS_PER_REQUEST = 4;
const TARGET_BASE64_CHARS = Math.ceil(MODEL_IMAGE_TARGET_BYTES / 3) * 4;
const imagesIn = message => Array.isArray(message.content) ? message.content : [];
const inlineImage = part => part?.type === 'image' && part.source?.type === 'base64'
  && typeof part.source.data === 'string' && part.source.data.length > 0;

export class ToolImagePrefixBudgetError extends ProviderContextBudgetError {
  constructor() { super('older tool images are locked in the signed prefix'); }
}

function reference(message, paths) {
  const path = paths.get(message);
  return path ? ` Original: ${JSON.stringify(path)}. Use ViewImage to reopen it or crop the original for more detail.`
    : ' See the tool result for the original; use a crop if more detail is needed.';
}

/** Make a query-local provider projection, not a transcript edit. Only tool
 * images are rewritten: rows, IDs, errors, text, documents, uploads and native
 * signed content stay intact. */
export function createActiveToolImageProjector({ paths = new WeakMap(), preview = makeModelImagePreview } = {}) {
  const keys = new WeakMap();
  const previews = new Map();
  const keyFor = part => {
    if (!keys.has(part)) {
      const { media_type, mediaType, data } = part.source;
      keys.set(part, `${media_type ?? mediaType ?? ''}:${part.detail ?? ''}:${createHash('sha256').update(data).digest('hex')}`);
    }
    return keys.get(part);
  };

  return async function project(messages, { frozenLength = 0, canRollover = false, signal } = {}) {
    const seen = new Set();
    let frozenToolImages = 0, frozenToolChars = 0;
    let recentBatches = 0, newPreviews = 0;
    let inToolBatch = false;
    let duplicateImages = 0, staleImages = 0, previewImages = 0;
    for (let i = 0; i < frozenLength; i++) {
      const message = messages[i];
      // A mutable upload could be trimmed later by the byte or token fitter.
      // Only use it as a deduplication anchor once it is part of the prefix.
      if (message.role !== 'user' && message.role !== 'tool') continue;
      for (const part of imagesIn(message)) {
        if (!inlineImage(part)) continue;
        seen.add(keyFor(part));
        if (message.role === 'tool') {
          frozenToolImages++;
          frozenToolChars += part.source.data.length;
        }
      }
    }
    const out = messages.slice();
    let retainedCount = frozenToolImages, retainedChars = frozenToolChars;
    // Latest mutable occurrence wins, including repeated reads of the same
    // content under different paths. A frozen occurrence always wins.
    for (let i = messages.length - 1; i >= frozenLength; i--) {
      const message = messages[i];
      if (message.role !== 'tool') { inToolBatch = false; continue; }
      if (!inToolBatch) { recentBatches++; inToolBatch = true; }
      const content = imagesIn(message);
      let next;
      for (let p = content.length - 1; p >= 0; p--) {
        const part = content[p];
        if (!inlineImage(part)) continue;
        const key = keyFor(part);
        const duplicate = seen.has(key);
        if (duplicate || recentBatches > RECENT_TOOL_BATCHES) {
          if (duplicate) duplicateImages++;
          else staleImages++;
          (next ??= content.slice())[p] = { type: 'text', text: (duplicate ? '[Duplicate image bytes not sent.'
            : '[Older tool image not sent.') + reference(message, paths) + ']' };
          continue;
        }
        seen.add(key);
        let fitted = part;
        if (part.source.data.length > TARGET_BASE64_CHARS) {
          if (!previews.has(key) && newPreviews < MAX_NEW_PREVIEWS_PER_REQUEST) {
            newPreviews++;
            const candidate = await preview(part, { signal });
            if (previews.size >= 128) previews.delete(previews.keys().next().value);
            previews.set(key, candidate);
            if (candidate) keys.set(candidate, key); // a frozen preview stands for its original bytes
          }
          fitted = previews.get(key) ?? part;
        }
        const exceedsBudget = retainedCount >= FROZEN_TOOL_IMAGE_COUNT
          || (retainedChars + fitted.source.data.length > FROZEN_TOOL_IMAGE_BASE64_CHARS && retainedCount >= 2);
        if (exceedsBudget && canRollover && frozenToolImages > 0) throw new ToolImagePrefixBudgetError();
        if (exceedsBudget) {
          staleImages++;
          (next ??= content.slice())[p] = { type: 'text', text: '[Tool image not sent: image retention budget.' + reference(message, paths) + ']' };
          continue;
        }
        retainedCount++;
        retainedChars += fitted.source.data.length;
        if (fitted !== part) {
          previewImages++;
          (next ??= content.slice())[p] = [{ type: 'text', text: '[Model image preview.' + reference(message, paths) + ']' }, fitted];
        }
      }
      if (next) {
        const projected = { ...message, content: next.flat() };
        const path = paths.get(message);
        if (path) paths.set(projected, path);
        out[i] = projected;
      }
    }
    return { messages: duplicateImages || staleImages || previewImages ? out : messages,
      duplicateImages, staleImages, previewImages };
  };
}
