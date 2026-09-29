import path from 'node:path';

export const LOCAL_MODEL = 'Xenova/multilingual-e5-small';
export const LOCAL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
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
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(yeaftDir, 'person', 'models');
    env.allowRemoteModels = allowDownload;
    // Offline cache reads require allowLocalModels in transformers 3.8.1. Keep
    // its additional local lookup instance-scoped instead of the default ./models.
    env.allowLocalModels = true;
    env.localModelPath = path.join(env.cacheDir, 'local', LOCAL_REVISION);
    extractor = await pipeline('feature-extraction', LOCAL_MODEL, {
      revision: LOCAL_REVISION, dtype: 'q8', device: 'cpu',
      cache_dir: env.cacheDir, local_files_only: !allowDownload,
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
