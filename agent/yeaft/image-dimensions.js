/**
 * image-dimensions.js — read raster image format and dimensions from header bytes.
 *
 * Shared by ViewImage metadata, provider adapters (format labels) and the
 * provider-request token estimate.
 * Providers bill images by (resized) pixels, so the estimate needs the real
 * frame size, not the encoded byte count. Budget checks run many times per
 * request, so base64 input is read through a random-access window instead of
 * decoding a multi-megabyte payload: PNG, GIF and WebP need their first 30
 * bytes, and JPEG walks segment headers only. The format is sniffed from the
 * bytes, never trusted from a file extension or declared media type.
 *
 * Returns null for unknown, truncated or corrupt data; callers keep their own
 * conservative fallback.
 */

const BASE64_WINDOW = /^[A-Za-z0-9+/]*={0,2}$/;
// Wrapped (MIME) base64 breaks lines every 76 characters, so a non-alphabet
// character in the first window reveals it; offsets would otherwise drift.
const BASE64_PREFIX_CHECK = 1024;
const NON_CANONICAL_BASE64 = /[^A-Za-z0-9+/=]/;
const MAX_JPEG_SEGMENTS = 1024;
// Start-of-frame markers SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
const JPEG_FRAME_MARKERS = new Set([
  0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
]);

function dimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function ascii(read, offset, length) {
  const bytes = read(offset, length);
  return bytes ? bytes.toString('latin1') : null;
}

// Walk segment headers. A naive scan for the first FFC0 can hit the frame
// header of an EXIF thumbnail inside APP1 and report the thumbnail's size.
function jpegDimensions(read) {
  let offset = 2;
  for (let segment = 0; segment < MAX_JPEG_SEGMENTS; segment += 1) {
    const marker = read(offset, 2);
    if (!marker || marker[0] !== 0xFF) return null;
    const type = marker[1];
    if (type === 0xFF) { offset += 1; continue; } // fill byte before a marker
    if (type === 0x01 || (type >= 0xD0 && type <= 0xD7)) { offset += 2; continue; }
    if (type === 0xD9 || type === 0xDA) return null; // no frame header before EOI/SOS
    const length = read(offset + 2, 2)?.readUInt16BE(0);
    if (!length || length < 2) return null;
    if (JPEG_FRAME_MARKERS.has(type)) {
      // Lf(2) P(1) Y(2) X(2): height precedes width.
      const frame = read(offset + 5, 4);
      return frame ? dimensions(frame.readUInt16BE(2), frame.readUInt16BE(0)) : null;
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(read) {
  const chunk = ascii(read, 12, 4);
  if (chunk === 'VP8 ') {
    const size = read(26, 4);
    return size ? dimensions(size.readUInt16LE(0) & 0x3FFF, size.readUInt16LE(2) & 0x3FFF) : null;
  }
  if (chunk === 'VP8L') {
    const bits = read(21, 4);
    if (!bits) return null;
    return dimensions(
      1 + (((bits[1] & 0x3F) << 8) | bits[0]),
      1 + (((bits[3] & 0x0F) << 10) | (bits[2] << 2) | ((bits[1] & 0xC0) >> 6)),
    );
  }
  if (chunk === 'VP8X') {
    const size = read(24, 6);
    return size ? dimensions(
      1 + (size[0] | (size[1] << 8) | (size[2] << 16)),
      1 + (size[3] | (size[4] << 8) | (size[5] << 16)),
    ) : null;
  }
  return null;
}

export function imageMimeFromHeader(header) {
  if (!Buffer.isBuffer(header)) return null;
  if (header.length >= 8 && header.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  const firstSix = header.toString('latin1', 0, 6);
  if (firstSix === 'GIF87a' || firstSix === 'GIF89a') return 'image/gif';
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 16 base64 characters decode to the 12 bytes every signature above needs.
const BASE64_SIGNATURE_CHARS = 16;

/**
 * Sniff the raster format from the start of a base64 payload without decoding
 * the rest. Returns null for unknown formats or non-canonical base64.
 *
 * @param {string} data - Base64 image payload, without a data: URI prefix.
 * @returns {string|null}
 */
export function imageMimeFromBase64(data) {
  if (typeof data !== 'string' || data.length < BASE64_SIGNATURE_CHARS) return null;
  const head = data.slice(0, BASE64_SIGNATURE_CHARS);
  return BASE64_WINDOW.test(head) ? imageMimeFromHeader(Buffer.from(head, 'base64')) : null;
}

/**
 * Providers check the declared type against the bytes; Anthropic rejects a
 * mismatch with HTTP 400 and the whole turn stops. File extensions, browser
 * upload types and attachment metadata are hints, so label an inline image by
 * its sniffed format. Unknown bytes keep their declared type. Tool-result
 * blocks are checked one level down. Unchanged input is returned as-is, never
 * mutated.
 *
 * @param {Array<object>|string|null|undefined} content - Message content.
 * @returns {Array<object>|string|null|undefined}
 */
export function correctImageMediaTypes(content) {
  if (!Array.isArray(content)) return content;
  let corrected = null;
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    let next = part;
    if (part?.type === 'image' && part.source?.type === 'base64') {
      const actual = imageMimeFromBase64(part.source.data);
      if (actual && actual !== part.source.media_type) {
        const { mediaType, ...source } = part.source;
        next = { ...part, source: { ...source, media_type: actual } };
      }
    } else if (typeof part?.type === 'string' && part.type.endsWith('tool_result') && Array.isArray(part.content)) {
      const nested = correctImageMediaTypes(part.content);
      if (nested !== part.content) next = { ...part, content: nested };
    }
    if (next !== part) (corrected ??= content.slice())[i] = next;
  }
  return corrected ?? content;
}

function readDimensions(read) {
  const signature = read(0, 12);
  if (!signature) return null;
  if (signature.readUInt32BE(0) === 0x89504E47 && ascii(read, 12, 4) === 'IHDR') {
    const size = read(16, 8);
    return size ? dimensions(size.readUInt32BE(0), size.readUInt32BE(4)) : null;
  }
  const head = signature.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') {
    // Logical screen size; providers that accept GIFs read the first frame.
    const size = read(6, 4);
    return size ? dimensions(size.readUInt16LE(0), size.readUInt16LE(2)) : null;
  }
  if (signature[0] === 0xFF && signature[1] === 0xD8) return jpegDimensions(read);
  if (signature.toString('latin1', 0, 4) === 'RIFF' && signature.toString('latin1', 8, 12) === 'WEBP') {
    return webpDimensions(read);
  }
  return null;
}

/**
 * @param {Buffer} buffer - Complete or leading image bytes.
 * @returns {{ width: number, height: number } | null}
 */
export function imageDimensionsFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  try {
    return readDimensions((offset, length) => (offset >= 0 && offset + length <= buffer.length
      ? buffer.subarray(offset, offset + length) : null));
  } catch {
    return null;
  }
}

/**
 * Read dimensions from canonical (unwrapped, whitespace-free) base64 without
 * decoding the whole payload. Any non-canonical window yields null.
 *
 * @param {string} data - Base64 image payload, without a data: URI prefix.
 * @returns {{ width: number, height: number } | null}
 */
export function imageDimensionsFromBase64(data) {
  if (typeof data !== 'string' || data.length < 16 || data.length % 4 !== 0
    || NON_CANONICAL_BASE64.test(data.slice(0, BASE64_PREFIX_CHECK))) return null;
  try {
    return readDimensions((offset, length) => {
      const start = Math.floor(offset / 3) * 4;
      const end = Math.ceil((offset + length) / 3) * 4;
      if (offset < 0 || end > data.length) return null;
      const window = data.slice(start, end);
      if (!BASE64_WINDOW.test(window)) return null;
      const bytes = Buffer.from(window, 'base64');
      const skip = offset - (start / 4) * 3;
      return bytes.length >= skip + length ? bytes.subarray(skip, skip + length) : null;
    });
  } catch {
    return null;
  }
}
