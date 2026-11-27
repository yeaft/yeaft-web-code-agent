// Verify the declared type against the beginning of the representation, not
// the requested byte range. Unknown or ambiguous formats are downloads.
export const CREATION_MEDIA_SNIFF_BYTES = 4096;

export function matchesCreationMediaType(bytes, mimeType) {
  const at = (signature, offset = 0) => bytes.subarray(offset, offset + signature.length).equals(signature);
  const text = (signature, offset) => at(Buffer.from(signature, 'latin1'), offset);
  switch (mimeType) {
    case 'image/png': return text('\x89PNG\r\n\x1a\n');
    case 'image/jpeg': return text('\xff\xd8\xff');
    case 'image/gif': return text('GIF87a') || text('GIF89a');
    case 'image/webp': return text('RIFF') && text('WEBP', 8);
    case 'image/svg+xml': {
      // SVG has no binary signature. Require an SVG root after an optional
      // XML declaration/comments; callers must also apply a sandbox CSP.
      const prefix = bytes.subarray(0, CREATION_MEDIA_SNIFF_BYTES).toString('utf8');
      return /^\s*(?:<\?xml\s+[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?=[\s/>])/.test(prefix);
    }
    case 'application/pdf': return text('%PDF-');
    case 'video/mp4': return bytes.length >= 16 && bytes.readUInt32BE(0) >= 16 && text('ftyp', 4);
    case 'video/webm': return text('\x1a\x45\xdf\xa3') && bytes.subarray(4, 256).includes(Buffer.from('\x42\x82\x84webm', 'latin1'));
    case 'audio/mpeg': return text('ID3') || (bytes.length >= 4 && bytes[0] === 0xff
      && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0
      && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c);
    case 'audio/wav': return text('RIFF') && text('WAVE', 8);
    case 'audio/ogg': return text('OggS\x00');
    default: return false;
  }
}
