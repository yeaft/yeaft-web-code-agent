// Internal one-shot decoder. Native crashes cannot terminate the Agent.
// Communicate over pipes; never put image data or credentials in argv.
import sharp from 'sharp';
import { imageMimeFromHeader } from './image-dimensions.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 32_000_000;
const SMALL_TARGET_BYTES = 200 * 1024;
// Lossless WebP at effort 1 costs roughly 0.6 s per megapixel on a desktop
// CPU (a 3840x1080 frame took 3.2 s and produced 4.9 MB). Above this size it
// is slower than the whole lossy ladder and almost never meets the target.
const LOSSLESS_MAX_PIXELS = 2_500_000;
// The parent kills the process 10 s after spawning it. Measured from process
// start (process.uptime), so loading sharp and reading stdin count too.
const ENCODE_BUDGET_MS = 8000;
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
const encode = (target, options, seconds) => sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS, pages: 1 })
  .timeout({ seconds }).autoOrient().resize({ width: target, height: target, fit: 'inside', withoutEnlargement: true })
  .webp(options).toBuffer();

/** Best-first ladder. An oversized result moves to the next, smaller rung; a
 * timeout or error jumps to the cheapest one. Neither gives up early. Only
 * small (model-preview) targets get the 1920/1440/1024 rungs. */
function ladder({ width, height }) {
  const scale = Math.min(1, edge / Math.max(width, height));
  const rungs = [];
  // Lossless keeps flat UI screenshots crisp, but it never shrinks a
  // photographic (JPEG) source and is hopeless when the source alone, scaled
  // to the output size, is far above the target.
  if (mime !== 'image/jpeg' && width * height * scale * scale <= LOSSLESS_MAX_PIXELS
      && input.length * scale * scale <= maxBytes * 1.5) rungs.push([edge, { lossless: true, effort: 1 }]);
  rungs.push([Math.min(edge, 2560), { quality: 85, effort: 1 }]);
  if (maxBytes <= SMALL_TARGET_BYTES) {
    rungs.push([Math.min(edge, 1920), { quality: 80, effort: 1 }],
      [Math.min(edge, 1440), { quality: 78, effort: 1 }], [Math.min(edge, 1024), { quality: 72, effort: 1 }]);
  }
  return rungs;
}

try {
  const metadata = await sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS, pages: 1 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('unreadable image');
  const rungs = ladder(metadata);
  for (let i = 0; i < rungs.length; i++) {
    // Never start a rung that could outlive the parent's kill timer.
    const seconds = Math.min(3, Math.floor((ENCODE_BUDGET_MS - process.uptime() * 1000) / 1000));
    if (seconds < 1) break;
    let output;
    try {
      output = await encode(rungs[i][0], rungs[i][1], seconds);
    } catch {
      // A slow or failed rung predicts slow neighbours: go straight to the
      // cheapest one instead of giving up or spending the budget in between.
      if (i < rungs.length - 2) i = rungs.length - 2;
      continue;
    }
    if (output.length <= maxBytes) {
      process.stdout.write(output);
      break;
    }
  }
} catch {
  process.exitCode = 1;
}
