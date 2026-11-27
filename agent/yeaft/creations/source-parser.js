import { extname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inflateSync } from 'node:zlib';
import { LIMITS } from './constants.js';

const TEXT_EXT = new Set('txt md markdown json jsonl csv tsv html htm xml yaml yml toml ini log js jsx mjs cjs ts tsx css scss py rb rs go java kt c h cpp hpp cs swift sh bash zsh sql vue svelte r php lua tex'.split(' '));
const TEXT_MIME = /^(text\/|application\/(?:json|xml|javascript|x-yaml)(?:;|$))/i;
const UTF8 = new TextDecoder('utf-8');

const PDF_INPUT_BYTES = 2 * 1024 * 1024;
const PDF_STREAM_BYTES = 1024 * 1024;
const PDF_DEADLINE_MS = 250;
const PDF_TOKEN_BYTES = LIMITS.parsedChars;
const PDF_SPACE = '\0\t\n\f\r ';
const PDF_DELIMITER = `${PDF_SPACE}()<>[]{}/%'"`;
const PDF_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\r': '', '\n': '' };
const hexDigit = char => char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F';

// Single-pass lexer for a small subset of text operators (no OCR or CMaps).
// Check the deadline even inside an unterminated token or comment.
function extractPdfText(text, expired, append) {
  let i = 0;
  let inText = false;
  let array = false;
  let pieces = [];
  let length = 0;
  let nextCheck = 0;
  let stopped = false;
  const scanning = () => {
    if (stopped || i >= text.length) return false;
    if (i < nextCheck) return true;
    nextCheck = i + 1024;
    stopped = expired();
    return !stopped;
  };
  const reset = () => { pieces = []; length = 0; };
  while (scanning()) {
    const char = text[i++];
    if (PDF_SPACE.includes(char)) continue;
    if (char === '%') {
      while (scanning() && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (char === '(' || (char === '<' && text[i] !== '<')) {
      if (!array) reset();
      const hex = char === '<';
      let depth = 1;
      let token = '';
      let valid = true;
      while (scanning()) {
        let value = text[i++];
        if (hex) {
          if (value === '>') { depth = 0; break; }
          if (PDF_SPACE.includes(value)) continue;
          if (!hexDigit(value)) valid = false;
        } else if (value === '\\' && i < text.length) {
          const escape = text[i++];
          if (escape >= '0' && escape <= '7') {
            let octal = escape;
            while (octal.length < 3 && text[i] >= '0' && text[i] <= '7') octal += text[i++];
            value = String.fromCharCode(parseInt(octal, 8) & 255);
          } else {
            if (escape === '\r' && text[i] === '\n') i++;
            value = PDF_ESCAPES[escape] ?? escape;
          }
        } else if (value === ')' && --depth === 0) break;
        else if (value === '(') depth++;
        if (inText && valid && token.length < PDF_TOKEN_BYTES) token += value;
      }
      if (inText && valid && !depth && token && length < PDF_TOKEN_BYTES && !expired()) {
        const bytes = hex ? Buffer.from(token.length % 2 ? `${token}0` : token, 'hex') : Buffer.from(token, 'latin1');
        const value = bytes[0] === 0xfe && bytes[1] === 0xff
          ? new TextDecoder('utf-16be').decode(bytes.subarray(2)) : bytes.toString('latin1');
        const piece = value.slice(0, PDF_TOKEN_BYTES - length);
        if (piece) { pieces.push(piece); length += piece.length; }
      }
      continue;
    }
    if (char === '<' || char === '>' && text[i] === '>') { i++; reset(); continue; }
    if (char === '[') { array = true; reset(); continue; }
    if (char === ']') { array = false; continue; }
    const start = i - 1;
    if (!PDF_DELIMITER.includes(char) || char === '/') {
      while (scanning() && !PDF_DELIMITER.includes(text[i])) i++;
    }
    const op = i - start <= 2 ? text.slice(start, i) : '';
    if (op === 'BT' || op === 'ET') { inText = op === 'BT'; array = false; reset(); }
    else if (!array) {
      if (inText && length && ['TJ', 'Tj', "'", '"'].includes(op) && !expired() && append(pieces.join(''))) return;
      reset();
    }
  }
}

function pdfText(input) {
  const deadline = performance.now() + PDF_DEADLINE_MS;
  const expired = () => performance.now() >= deadline;
  const bytes = input.subarray(0, PDF_INPUT_BYTES);
  const raw = bytes.toString('latin1');
  const parts = [];
  let chars = 0;
  const extract = text => extractPdfText(text, expired, line => {
    const room = LIMITS.parsedChars + 1 - chars;
    parts.push(line.slice(0, room));
    chars += Math.min(line.length, room) + 1;
    return chars > LIMITS.parsedChars;
  });
  const streams = /\bstream\r?\n/g;
  const flate = /\/Filter[\0\t\n\f\r ]*(?:\/FlateDecode\b|\[[\0\t\n\f\r ]*\/FlateDecode[\0\t\n\f\r ]*\])/;
  let workBudget = 4 * PDF_STREAM_BYTES;
  for (let count = 0; count < 256 && !expired() && chars <= LIMITS.parsedChars; count++) {
    const match = streams.exec(raw);
    if (!match) break;
    const start = streams.lastIndex;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    streams.lastIndex = end + 'endstream'.length;
    // Never scan backwards through the entire file for each candidate stream.
    const prefix = raw.slice(Math.max(0, match.index - 4096), match.index);
    const objectStart = prefix.lastIndexOf('obj');
    const dict = objectStart < 0 ? prefix : prefix.slice(objectStart + 3);
    if (expired()) break;
    if (flate.test(dict)) {
      // Inflate is synchronous. Bound each native call and charge failed attempts
      // against the cumulative output budget as well as successful ones.
      const maxOutputLength = Math.min(workBudget, PDF_STREAM_BYTES);
      if (maxOutputLength <= 0 || end - start > PDF_STREAM_BYTES) continue;
      try {
        const decoded = inflateSync(bytes.subarray(start, end), { maxOutputLength });
        workBudget -= decoded.length;
        if (!expired()) extract(decoded.toString('latin1'));
      } catch { workBudget -= maxOutputLength; }
    } else if (!dict.includes('/Filter')) extract(raw.slice(start, end));
  }
  if (!parts.length && !expired()) extract(raw);
  return { text: parts.join('\n'), truncated: bytes.length < input.length || expired() };
}

export function parseSource(bytes, { name = '', mimeType = 'application/octet-stream' } = {}) {
  const ext = extname(name).slice(1).toLowerCase();
  const pdf = ext === 'pdf' || mimeType === 'application/pdf' || bytes.subarray(0, 5).toString() === '%PDF-';
  const media = /^(image|audio|video)\//i.exec(mimeType)?.[1]?.toLowerCase()
    ?? (/^(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(ext) ? 'image'
      : /^(mp3|wav|ogg|m4a|flac|aac)$/.test(ext) ? 'audio' : /^(mp4|webm|mov|mkv|avi)$/.test(ext) ? 'video' : 'binary');
  let text = '';
  let kind = pdf ? 'pdf' : media;
  let pdfTruncated = false;
  if (pdf) ({ text, truncated: pdfTruncated } = pdfText(bytes));
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
  const truncated = pdfTruncated || text.length > LIMITS.parsedChars || (kind === 'text' && bytes.length > LIMITS.parsedChars * 4);
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
