import { imageDimensionsFromBase64 } from './image-dimensions.js';
import { makeImagePreview } from './image-preview.js';
import { LLMAbortError } from './llm/adapter.js';

export const MODEL_IMAGE_TARGET_BYTES = 200 * 1024;
export const MODEL_IMAGE_TARGET_BASE64_CHARS = 4 * Math.ceil(MODEL_IMAGE_TARGET_BYTES / 3);

/** Use the route fallback's isolated decoder for large tool images too. The
 * target is binary bytes; small tool images and user uploads stay untouched. */
export async function makeModelImagePreview(part, { signal } = {}) {
  if (signal?.aborted) throw new LLMAbortError();
  if ((part.source?.data?.length ?? 0) <= MODEL_IMAGE_TARGET_BASE64_CHARS) return null;
  const dimensions = imageDimensionsFromBase64(part.source.data);
  if (!dimensions) return null;
  const maxEdge = Math.min(8000, Math.max(dimensions.width, dimensions.height));
  const maxBase64Bytes = 4 * Math.floor(MODEL_IMAGE_TARGET_BYTES / 3);
  const preview = await makeImagePreview(part, maxEdge, maxBase64Bytes, signal);
  if (!preview || Buffer.byteLength(preview.source.data, 'base64') > MODEL_IMAGE_TARGET_BYTES) return null;
  return { ...part, source: preview.source };
}
