// Verify the declared type against the beginning of the representation, not
// the requested byte range. Unknown or ambiguous formats are downloads.
export const CREATION_MEDIA_SNIFF_BYTES = 4096;

function sniffVideo(bytes, totalSize) {
  // ISO BMFF and QuickTime start with a size-prefixed box. Legacy MOV
  // can start directly with a movie/data box instead of a file-type box.
  if (bytes.length >= 8) {
    const box = bytes.toString('latin1', 4, 8);
    let size = bytes.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1 && bytes.length >= 16) {
      size = Number(bytes.readBigUInt64BE(8));
      headerSize = 16;
    }
    if (Number.isSafeInteger(size) && size <= totalSize) {
      if (box === 'ftyp' && size >= headerSize + 8 && (size - headerSize) % 4 === 0
          && bytes.length >= headerSize + 8 && /^[ -~]{4}$/.test(bytes.toString('latin1', headerSize, headerSize + 4))) {
        return 'video/mp4';
      }
      if ((box === 'moov' || box === 'mdat') && size > headerSize) return 'video/mp4';
    }
  }
  // The EBML magic is shared by Matroska; require the WebM DocType as well.
  if (bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
      && bytes.subarray(4, 256).includes(Buffer.from('4282847765626d', 'hex'))) return 'video/webm';
  return null;
}

export function verifiedCreationMediaType(bytes, declaredType, totalSize = bytes.length) {
  if (['application/octet-stream', 'video/quicktime', 'video/mp4', 'video/webm'].includes(declaredType)) {
    return sniffVideo(bytes, totalSize);
  }
  return matchesCreationMediaType(bytes, declaredType) ? declaredType : null;
}

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
    case 'video/mp4':
    case 'video/webm': return sniffVideo(bytes, bytes.length) === mimeType;
    case 'audio/mpeg': return text('ID3') || (bytes.length >= 4 && bytes[0] === 0xff
      && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0
      && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c);
    case 'audio/wav': return text('RIFF') && text('WAVE', 8);
    case 'audio/ogg': return text('OggS\x00');
    default: return false;
  }
}
