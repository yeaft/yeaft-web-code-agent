import { Worker } from 'node:worker_threads';
import { createEmbedding } from './local-memory-embedding.js';

// ONNX's native addon is not reliably reloadable in replacement Node threads.
// Keep it in this disposable process; SQLite/tokenization/ranking use a worker
// thread. The Agent supervises the whole process, including blocked native work.
let worker;
let embedder;
let closing = false;
process.on('message', message => {
  if (message.init) {
    if (worker) return;
    const options = message.init;
    worker = new Worker(new URL('./local-memory-worker.js', import.meta.url), { workerData: options });
    worker.on('message', async response => {
      if (response.embeddingRequest) {
        const { id, texts, type } = response.embeddingRequest;
        try {
          embedder ??= createEmbedding({ ...options.embedding, yeaftDir: options.yeaftDir });
          const value = await embedder.embed(texts, type);
          worker.postMessage({ embeddingResult: { id, value } });
        } catch {
          worker.postMessage({ embeddingResult: { id, error: true } });
        }
      } else if (response.closed) {
        closing = true;
        try { await embedder?.close(); }
        finally { process.disconnect(); }
      } else {
        process.send?.(response);
      }
    });
    worker.on('error', () => process.exit(1));
    worker.on('exit', code => { if (!closing || code) process.exit(1); });
    return;
  }
  worker?.postMessage(message);
});
// Agent crash/IPC teardown must not leave the model process or its thread alive.
process.on('disconnect', () => process.exit(0));
