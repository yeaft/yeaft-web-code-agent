// Internal one-shot decoder. Native crashes cannot terminate the Agent.
// Communicate over pipes; never put image data or credentials in argv.
import sharp from 'sharp';
import { imageMimeFromHeader } from './image-dimensions.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 32_000_000;
const loaders = new Map([
  ['image/png', 'VipsForeignLoadPngBuffer'], ['image/jpeg', 'VipsForeignLoadJpegBuffer'],
  ['image/gif', 'VipsForeignLoadNsgifBuffer'], ['image/webp', 'VipsForeignLoadWebpBuffer'],
]);
const [mime, edgeArg, bytesArg] = process.argv.slice(2);
const edge = Number(edgeArg), maxBytes = Number(bytesArg);
if (!loaders.has(mime) || !Number.isSafeInteger(edge) || edge < 1 || edge > 8000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 7_500_000) process.exit(1);
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_SOURCE_BYTES) process.exit(1);
  chunks.push(chunk);
}
const input = Buffer.concat(chunks, size);
if (imageMimeFromHeader(input) !== mime) process.exit(1);
sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: [loaders.get(mime)] });
const encode = (target, options) => sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS, pages: 1 })
  .timeout({ seconds: 2 }).autoOrient().resize({ width: target, height: target, fit: 'inside', withoutEnlargement: true })
  .webp(options).toBuffer();
try {
  // Try lossless output first. Resizing (when needed) still reduces resolution.
  let output = await encode(edge, { lossless: true, effort: 1 });
  if (output.length > maxBytes) output = await encode(Math.min(edge, 2560), { quality: 85, effort: 1 });
  if (output.length <= maxBytes) process.stdout.write(output);
} catch {
  process.exitCode = 1;
}
