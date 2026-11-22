import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageDimensionsFromBase64, imageMimeFromHeader } from './image-dimensions.js';
import { LLMAbortError } from './llm/adapter.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 32_000_000;
const WORKER = fileURLToPath(new URL('./image-preview-worker.js', import.meta.url));
const supported = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
let active = 0;

function encodeInChild(input, mime, edge, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    // Do not inherit credentials, preload flags or loader configuration.
    const env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(process.execPath, ['--max-old-space-size=64', WORKER, mime, String(edge), String(maxBytes)], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env,
    });
    active++;
    const chunks = [];
    let size = 0, stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, 5000);
    timer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {}); // Decoder may exit before consuming stdin.
    child.on('error', stop);
    child.stdout.on('data', chunk => {
      if (stopped) return;
      size += chunk.length;
      if (size > maxBytes) stop();
      else chunks.push(chunk);
    });
    child.once('close', code => {
      active--;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new LLMAbortError());
      else resolve(!stopped && code === 0 && size ? Buffer.concat(chunks, size) : null);
    });
    if (signal?.aborted) stop();
    else child.stdin.end(input);
  });
}

/** Bounded, best-effort raster conversion. Missing optional decoder, timeout
 * or a failed conversion leaves a reference. Never write over the original. */
export async function makeImagePreview(part, maxEdge, maxBase64Bytes, signal) {
  if (signal?.aborted) throw new LLMAbortError();
  const source = part.source;
  if (active >= 2 || source?.type !== 'base64' || typeof source.data !== 'string'
      || source.data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4) return null;
  const dimensions = imageDimensionsFromBase64(source.data);
  if (!dimensions || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) return null;
  const input = Buffer.from(source.data, 'base64');
  // Decode by the sniffed format: a mislabeled original (a PNG named .jpg)
  // must still get a preview rather than ship its wrong label to the provider.
  const mime = imageMimeFromHeader(input);
  if (input.length > MAX_SOURCE_BYTES || !supported.has(mime)) return null;
  const output = await encodeInChild(input, mime, maxEdge, Math.floor(maxBase64Bytes / 4) * 3, signal);
  return output ? { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: output.toString('base64') } } : null;
}
