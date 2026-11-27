import { extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { LIMITS } from './constants.js';

const TEXT_EXT = new Set('txt md markdown json jsonl csv tsv html htm xml yaml yml toml ini log js jsx mjs cjs ts tsx css scss py rb rs go java kt c h cpp hpp cs swift sh bash zsh sql vue svelte r php lua tex'.split(' '));
const TEXT_MIME = /^(text\/|application\/(?:json|xml|javascript|x-yaml)(?:;|$))/i;
const UTF8 = new TextDecoder('utf-8');

function pdfString(token) {
  const bytes = token[0] === '<' ? Buffer.from(token.slice(1, -1).replace(/\s/g, '').replace(/^([a-f0-9]*[a-f0-9])$/i, hex => hex.length % 2 ? `${hex}0` : hex), 'hex')
    : Buffer.from(token.slice(1, -1).replace(/\\([0-7]{1,3}|\r\n|[\s\S])/g, (_, ch) => {
      if (/^[0-7]+$/.test(ch)) return String.fromCharCode(parseInt(ch, 8) & 255);
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\r': '', '\n': '', '\r\n': '' })[ch] ?? ch;
    }), 'latin1');
  return bytes[0] === 0xfe && bytes[1] === 0xff
    ? new TextDecoder('utf-16be').decode(bytes.subarray(2)) : bytes.toString('latin1');
}

// Best effort only: unencrypted PDFs with simple text operators, not OCR or CMaps.
function pdfText(bytes) {
  const raw = bytes.toString('latin1');
  const parts = [];
  let chars = 0;
  const extract = text => {
    // Bound regex work even on a single enormous or malformed stream.
    text = text.slice(0, 1024 * 1024);
    const blocks = /\b(BT|ET)\b/g;
    let start = null;
    for (const block of text.matchAll(blocks)) {
      if (block[1] === 'BT') { start = block.index + 2; continue; }
      if (start === null) continue;
      const body = text.slice(start, block.index);
      start = null;
      for (const match of body.matchAll(/(\[(?:[^\]\\]|\\[\s\S])*\]|\((?:[^()\\]|\\[\s\S])*\)|<[0-9a-f\s]+>)\s*(?:TJ\b|Tj\b|['"])/gi)) {
        const line = [...match[1].matchAll(/\((?:[^()\\]|\\[\s\S])*\)|<[0-9a-f\s]+>/gi)]
          .map(m => pdfString(m[0])).join('');
        if (line) { parts.push(line); chars += line.length + 1; }
        if (chars >= LIMITS.parsedChars) return;
      }
    }
  };
  const stream = /\bstream\r?\n/g;
  let match;
  let inflatedBudget = 4 * 1024 * 1024;
  for (let count = 0; count < 256 && chars < LIMITS.parsedChars && (match = stream.exec(raw)); count++) {
    const end = raw.indexOf('endstream', stream.lastIndex);
    if (end < 0) break;
    const objectStart = raw.lastIndexOf('obj', match.index);
    const dict = raw.slice(Math.max(objectStart, match.index - 4096, 0), match.index);
    const start = stream.lastIndex;
    stream.lastIndex = end + 9;
    if (/\/Filter\s*(?:\/FlateDecode\b|\[\s*\/FlateDecode\s*\])/.test(dict) && inflatedBudget > 0) {
      try {
        const decoded = inflateSync(bytes.subarray(start, end), { maxOutputLength: Math.min(inflatedBudget, 1024 * 1024) });
        inflatedBudget -= decoded.length;
        extract(decoded.toString('latin1'));
      } catch { /* malformed or oversized PDF stream */ }
    } else if (!/\/Filter\b/.test(dict)) extract(raw.slice(start, end));
  }
  if (!parts.length) extract(raw.slice(0, 1024 * 1024));
  return parts.join('\n');
}

export function parseSource(bytes, { name = '', mimeType = 'application/octet-stream' } = {}) {
  const ext = extname(name).slice(1).toLowerCase();
  const pdf = ext === 'pdf' || mimeType === 'application/pdf' || bytes.subarray(0, 5).toString() === '%PDF-';
  const media = /^(image|audio|video)\//i.exec(mimeType)?.[1]?.toLowerCase()
    ?? (/^(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(ext) ? 'image'
      : /^(mp3|wav|ogg|m4a|flac|aac)$/.test(ext) ? 'audio' : /^(mp4|webm|mov|mkv|avi)$/.test(ext) ? 'video' : 'binary');
  let text = '';
  let kind = pdf ? 'pdf' : media;
  if (pdf) text = pdfText(bytes);
  else if (TEXT_EXT.has(ext) || TEXT_MIME.test(mimeType)) {
    if (!bytes.subarray(0, 4096).includes(0)) {
      text = UTF8.decode(bytes.subarray(0, LIMITS.parsedChars * 4));
      kind = 'text';
    }
  } else if (media === 'binary' && !bytes.subarray(0, 4096).includes(0)) {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const candidate = decoder.decode(bytes.subarray(0, LIMITS.parsedChars * 4), { stream: bytes.length > LIMITS.parsedChars * 4 });
      if (candidate && !/[\x00-\x08\x0e-\x1f]/.test(candidate)) { text = candidate; kind = 'text'; }
    } catch { /* binary */ }
  }
  const truncated = text.length > LIMITS.parsedChars || (kind === 'text' && bytes.length > LIMITS.parsedChars * 4);
  text = text.slice(0, LIMITS.parsedChars).replace(/\r\n?/g, '\n').trim();
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + LIMITS.chunkChars);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + LIMITS.chunkChars / 2) end = newline + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push({ index: chunks.length, text: text.slice(start, end) });
    start = end;
  }
  return { version: 1, kind, name, mimeType, byteLength: bytes.length, truncated, chunks,
    summary: text ? text.slice(0, 600) : `${name} (${kind}, ${bytes.length} bytes; no extractable text)` };
}

export function searchTerms(value, limit = 24) {
  return [...new Set((String(value ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,48}/gu) ?? []))].slice(0, limit);
}
