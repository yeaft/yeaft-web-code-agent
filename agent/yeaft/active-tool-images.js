import { createHash } from 'node:crypto';
import { makeModelImagePreview, MODEL_IMAGE_TARGET_BASE64_CHARS } from './model-image-preview.js';
import { ProviderContextBudgetError } from './llm/provider-state.js';

const RECENT_TOOL_BATCHES = 3;
const TOOL_IMAGE_COUNT = 12;
const TOOL_IMAGE_BASE64_CHARS = 3 * 1024 * 1024;
// If previewing fails, a single recent original can still be useful. Never
// combine this exception with other tool images or bypass the route fitter.
const SINGLE_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;
const MAX_NEW_PREVIEWS_PER_REQUEST = 4;
const imagesIn = message => Array.isArray(message.content) ? message.content : [];
const inlineImage = part => part?.type === 'image' && part.source?.type === 'base64'
  && typeof part.source.data === 'string' && part.source.data.length > 0;
const fits = (count, chars, next) => count < TOOL_IMAGE_COUNT
  && (chars + next <= TOOL_IMAGE_BASE64_CHARS || (count === 0 && next <= SINGLE_IMAGE_BASE64_CHARS));

export class ToolImagePrefixBudgetError extends ProviderContextBudgetError {
  constructor() { super('older tool images are locked in the signed prefix'); }
}

/** A query-local projection. Keep tool IDs, text, documents, uploads and
 * frozen messages intact. Digests describe the actual bytes, not object IDs
 * or paths, so matching also works after a signed snapshot is cloned. */
export function createActiveToolImageProjector({ pathForImage, preview = makeModelImagePreview } = {}) {
  const keys = new WeakMap();
  const previews = new Map();
  const pathFor = new WeakMap();
  const imageAnnotations = new WeakSet();
  // A rollover attaches completed tool evidence to a synthetic user row. Its
  // transport role changes, its origin (and retention budget) does not.
  const toolEvidenceParts = new WeakSet();
  const markEvidence = part => { if (inlineImage(part)) toolEvidenceParts.add(part); };
  const copyEvidence = (from, to) => { if (to && toolEvidenceParts.has(from)) markEvidence(to); };
  const copySnapshot = (messages, snapshot) => {
    for (let i = 0; i < messages.length; i++) {
      const originals = imagesIn(messages[i]);
      if (!originals.length) continue;
      const copies = imagesIn(snapshot[i]);
      for (let p = 0; p < originals.length; p++) copyEvidence(originals[p], copies[p]);
    }
    return snapshot;
  };
  const keyFor = part => {
    if (!keys.has(part)) {
      const { media_type, mediaType, data } = part.source;
      keys.set(part, `${media_type ?? mediaType ?? ''}:${part.detail ?? ''}:${createHash('sha256').update(data).digest('hex')}`);
    }
    return keys.get(part);
  };
  const pathOf = part => pathFor.get(part) ?? pathForImage?.(part);
  const marker = (reason, part) => {
    const path = pathOf(part);
    return { type: 'text', text: `[${reason}${path
      ? ` Original: ${JSON.stringify(path)}. Use ViewImage to reopen it or crop the original for more detail.`
      : ' See the tool result for the original; use a crop if more detail is needed.'}]` };
  };

  async function project(messages, { frozenLength = 0, canRollover = false, signal } = {}) {
    const seen = new Set();
    let frozenToolImages = 0, frozenToolChars = 0;
    let mutableCount = 0, mutableChars = 0;
    let recentBatches = 0, newPreviews = 0;
    let inToolBatch = false;
    let duplicateImages = 0, staleImages = 0, previewImages = 0;
    for (let i = 0; i < frozenLength; i++) {
      const message = messages[i];
      if (message.role !== 'user' && message.role !== 'tool') continue;
      for (const part of imagesIn(message)) {
        if (!inlineImage(part)) continue;
        seen.add(keyFor(part));
        if (message.role === 'tool' || toolEvidenceParts.has(part)) {
          frozenToolImages++;
          frozenToolChars += part.source.data.length;
        }
      }
    }
    const out = messages.slice();
    // Latest mutable occurrence wins. Only accepted payloads become anchors.
    for (let i = messages.length - 1; i >= frozenLength; i--) {
      const message = messages[i];
      const toolRow = message.role === 'tool';
      if (!toolRow) inToolBatch = false;
      else if (!inToolBatch) { recentBatches++; inToolBatch = true; }
      if (!toolRow && message.role !== 'user') continue;
      const content = imagesIn(message);
      let next;
      const omit = (index, reason, part) => {
        const text = marker(reason, part);
        imageAnnotations.add(text);
        (next ??= content.slice())[index] = text;
      };
      for (let p = content.length - 1; p >= 0; p--) {
        const part = content[p];
        if (!inlineImage(part) || (!toolRow && !toolEvidenceParts.has(part))) continue;
        const key = keyFor(part);
        let fitted = previews.get(key) ?? part;
        if (seen.has(key) || (fitted !== part && seen.has(keyFor(fitted)))) {
          duplicateImages++;
          // This marker claims nothing about whether the sole copy survives
          // subsequent route/body/token fitting. The path remains usable.
          omit(p, 'Image not included in this tool result (duplicate content).', part);
          continue;
        }
        if (recentBatches > RECENT_TOOL_BATCHES) {
          staleImages++;
          omit(p, 'Older tool image not sent.', part);
          continue;
        }
        if (part.source.data.length > MODEL_IMAGE_TARGET_BASE64_CHARS && !previews.has(key)
            && newPreviews < MAX_NEW_PREVIEWS_PER_REQUEST) {
          newPreviews++;
          const candidate = await preview(part, { signal });
          // Bound the negative cache and preview memory. Don't evict a positive
          // entry while its preview may be an immutable deduplication anchor.
          if (!candidate && previews.size < 128) previews.set(key, null);
          if (candidate) {
            fitted = candidate;
            if (previews.size < 128) previews.set(key, candidate);
          }
        }
        const wireKey = keyFor(fitted);
        if (seen.has(wireKey)) {
          duplicateImages++;
          omit(p, 'Image not included in this tool result (duplicate content).', part);
          continue;
        }
        const chars = fitted.source.data.length;
        if (!fits(frozenToolImages + mutableCount, frozenToolChars + mutableChars, chars)) {
          if (toolRow && canRollover && frozenToolImages > 0 && fits(mutableCount, mutableChars, chars)) throw new ToolImagePrefixBudgetError();
          staleImages++;
          omit(p, 'Tool image not sent: image retention budget.', part);
          continue;
        }
        seen.add(key);
        seen.add(wireKey);
        mutableCount++;
        mutableChars += chars;
        if (fitted !== part) {
          previewImages++;
          // Identical files under distinct paths can share encoded bytes but not
          // provenance. Don't attach a different path to a cached preview object.
          const selected = { ...fitted };
          copyEvidence(part, selected);
          const path = pathOf(part);
          if (path) pathFor.set(selected, path);
          const annotation = marker('Model image preview.', part);
          imageAnnotations.add(annotation);
          (next ??= content.slice())[p] = [annotation, selected];
        }
      }
      if (next) out[i] = { ...message, content: next.flat() };
    }
    return { messages: duplicateImages || staleImages || previewImages ? out : messages,
      duplicateImages, staleImages, previewImages };
  }
  project.pathOf = pathOf;
  project.markEvidence = markEvidence;
  project.copyEvidence = copyEvidence;
  project.copySnapshot = messages => copySnapshot(messages, structuredClone(messages));
  project.isImageAnnotation = part => imageAnnotations.has(part);
  return project;
}
