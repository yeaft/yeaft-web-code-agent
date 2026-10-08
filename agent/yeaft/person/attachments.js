import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { bytes, digest, fail, LIMITS, object, text } from './contracts.js';

// Keep Server's reference resolver limits aligned. No paths, URLs or browser bytes are accepted there.
export const ATTACHMENT_LIMITS = Object.freeze({ count: 4, fileBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, inputBytes: 24 * 1024 });
const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const extensions = new Set('.txt .md .markdown .json .csv .tsv .js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .java .c .h .cpp .hpp .cs .sh .bash .zsh .ps1 .sql .html .css .xml .yaml .yml .toml .ini .log'.split(' '));
const textMimes = new Set(['application/json', 'application/ld+json', 'application/javascript', 'application/xml', 'application/yaml']);
export const attachmentMetadata = ({ id, name, mimeType, size, sha256, kind }) => ({ id, name, mimeType, size, sha256, kind });

/** Validate the trusted relay's canonical envelope again before durable admission. */
export function validateFiles(files = [], input = '', kind = 'send') {
  text(input, LIMITS.inputBytes, true);
  if (!Array.isArray(files) || files.length > ATTACHMENT_LIMITS.count || (kind === 'dream' && files.length)) fail('INVALID_ATTACHMENT');
  let total = 0, inputBytes = bytes(input);
  const result = files.map(file => {
    object(file, ['name', 'mimeType', 'data'], undefined, 'INVALID_ATTACHMENT');
    text(file.name, 255, false, 'INVALID_ATTACHMENT');
    if (/[\\/\u0000-\u001f\u007f]/u.test(file.name)) fail('INVALID_ATTACHMENT');
    text(file.mimeType, 128, true, 'INVALID_ATTACHMENT');
    if (typeof file.data !== 'string' || file.data.length > 4 * Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) ||
        (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))) fail('INVALID_ATTACHMENT');
    const buffer = Buffer.from(file.data, 'base64');
    if (buffer.toString('base64') !== file.data) fail('INVALID_ATTACHMENT');
    total += buffer.length;
    if (buffer.length > ATTACHMENT_LIMITS.fileBytes || total > ATTACHMENT_LIMITS.totalBytes) fail('ATTACHMENT_LIMIT');
    const mimeType = file.mimeType.toLowerCase().split(';')[0].trim();
    let content = null, fileKind;
    if (images.has(mimeType)) {
      const valid = mimeType === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : mimeType === 'image/jpeg' ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
          : mimeType === 'image/gif' ? /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))
            : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
      if (!valid) fail('INVALID_ATTACHMENT');
      fileKind = 'image';
    } else {
      const extension = extname(file.name).toLowerCase();
      // MIME/extension claims never make PDF, binary controls or invalid UTF-8 readable text.
      if (mimeType === 'application/pdf' || extension === '.pdf' || buffer.subarray(0, 5).toString() === '%PDF-' ||
          !(mimeType.startsWith('text/') || textMimes.has(mimeType) || extensions.has(extension))) fail('UNSUPPORTED_ATTACHMENT');
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('UNSUPPORTED_ATTACHMENT'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) fail('UNSUPPORTED_ATTACHMENT');
      inputBytes += bytes(content);
      if (inputBytes > ATTACHMENT_LIMITS.inputBytes) fail('ATTACHMENT_LIMIT');
      fileKind = 'text';
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const id = digest([file.name, mimeType, sha256]);
    return { id, name: file.name, mimeType, size: buffer.length, sha256, kind: fileKind, data: file.data, content };
  });
  if (kind === 'send' && !input.trim() && !result.length) fail('INVALID_REQUEST');
  return result;
}

// Preserve legacy text-only hashes; a retry can use new upload IDs for identical bytes.
export const attachmentRequestHash = (kind, input, files) => files.length
  ? digest([kind, input, files.map(({ name, mimeType, sha256 }) => ({ name, mimeType, sha256 }))]) : digest([kind, input]);
