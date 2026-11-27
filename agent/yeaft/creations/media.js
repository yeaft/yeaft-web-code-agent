export function readMediaChunk(store, { requestId, creationId, mediaKind, mediaId, start, end, expectedVersion = null }) {
  const { bytes, ...info } = store.readMediaRange(creationId, mediaKind, mediaId, start, end, { expectedVersion });
  return { type: 'creation_media_chunk', requestId, creationId, mediaKind, mediaId, ok: true, ...info, data: bytes.toString('base64') };
}
