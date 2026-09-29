import { prepareModelCache } from './local-memory-cache.js';

export const LOCAL_MODEL = 'Xenova/multilingual-e5-small';
export const LOCAL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
// SHA-256 of the exact revision's files (LFS oid for tokenizer/ONNX). Update this
// manifest with LOCAL_REVISION, never from mutable download response metadata.
export const LOCAL_ARTIFACTS = Object.freeze({
  'config.json': Object.freeze({ size: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' }),
  'tokenizer_config.json': Object.freeze({ size: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' }),
  'tokenizer.json': Object.freeze({ size: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' }),
  'onnx/model_quantized.onnx': Object.freeze({ size: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' }),
});
export const VECTOR_DIMENSION = 384;
export const CHUNK_SIZE = 320;
export const CHUNK_OVERLAP = 64;
// Version the complete space, not just the model name. A change invalidates derived chunks.
export const MODEL_FINGERPRINT = `${LOCAL_MODEL}@${LOCAL_REVISION}:q8:mean:l2:384:e5-prefix:codepoints-${CHUNK_SIZE}-${CHUNK_OVERLAP}:segmenter-v1`;

/** Worker-only lazy adapter. Only model artifacts use the network; text goes to local ONNX. */
export function createEmbedding({ yeaftDir, allowDownload = true, threads = 2 } = {}) {
  let extractor;
  async function load() {
    if (extractor) return extractor;
    const modelDir = await prepareModelCache({ yeaftDir, model: LOCAL_MODEL, revision: LOCAL_REVISION, artifacts: LOCAL_ARTIFACTS, allowDownload });
    const { pipeline, env } = await import('@huggingface/transformers');
    // Never let Transformers' non-atomic FileCache write model artifacts. The
    // validated local snapshot is complete, including when restarting offline.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '';
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = { async match() {}, async put() { throw new Error('unexpected_model_cache_write'); } };
    // 3.8.1 also uses this flag to pass the ONNX *path* to the native runtime.
    // The custom cache above prevents its unsafe FileCache from being instantiated.
    env.useFSCache = true;
    extractor = await pipeline('feature-extraction', modelDir, {
      revision: LOCAL_REVISION, dtype: 'q8', device: 'cpu',
      local_files_only: true,
      session_options: { intraOpNumThreads: Math.max(1, Math.min(4, threads)), interOpNumThreads: 1 },
    });
    return extractor;
  }
  return {
    async embed(texts, type) {
      const model = await load();
      const output = await model(texts.map(text => `${type === 'query' ? 'query' : 'passage'}: ${text}`), {
        pooling: 'mean', normalize: true, truncation: true, max_length: 512,
      });
      return output.tolist();
    },
    async close() { if (extractor) await extractor.dispose(); extractor = null; },
  };
}
