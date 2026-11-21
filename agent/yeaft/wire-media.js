const IMAGE_TYPES = new Set(['image', 'image_url', 'input_image']);
const BINARY_TYPES = new Set([...IMAGE_TYPES, 'document', 'input_file']);

// Only inspect the known unified media fields. Never search arbitrary tool
// text, assistant state, or signed native provider blocks for base64.
function inlineMediaPayload(part) {
  if (!BINARY_TYPES.has(part?.type)) return null;
  if (typeof part.source?.data === 'string') return part.source.data;
  if (typeof part.file_data === 'string') return part.file_data;
  const url = part.source?.url ?? part.image_url?.url ?? part.image_url;
  return typeof url === 'string' && url.startsWith('data:') ? url : null;
}

function mapWireMedia(messages, replace) {
  return messages.map(message => {
    if (!['user', 'tool'].includes(message?.role) || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map(part => {
      if (!BINARY_TYPES.has(part?.type)) return part;
      const next = replace(part, message);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? { ...message, content } : message;
  });
}

function wireMediaMarker(part, message) {
  return { type: 'text', text: IMAGE_TYPES.has(part.type)
    ? `[Image not sent. Use its saved path${message.role === 'tool' ? ' in the tool result' : ' in the upload list'}, if available, with ViewImage; otherwise ask for the original.]`
    : '[Attachment not sent. Use its saved path if available; otherwise ask for the original.]' };
}

export function omitHistoricalImages(messages) {
  return mapWireMedia(messages, (part, message) => IMAGE_TYPES.has(part.type) ? wireMediaMarker(part, message) : part);
}

export function inlineMediaBytes(messages) {
  let bytes = 0;
  for (const message of messages) {
    if (!['user', 'tool'].includes(message?.role) || !Array.isArray(message.content)) continue;
    // Canonical base64 is ASCII. Use actual UTF-8 bytes for legacy aliases too.
    for (const part of message.content) {
      const payload = inlineMediaPayload(part);
      if (payload) bytes += Buffer.byteLength(payload, 'utf8');
    }
  }
  return bytes;
}

/** A payload-only target, not a wire-size estimate. The adapter checks the final JSON. */
export function trimWireMedia(messages, budget) {
  let excess = inlineMediaBytes(messages) - budget;
  if (excess <= 0) return messages;
  return mapWireMedia(messages, (part, message) => {
    const payload = inlineMediaPayload(part);
    if (!payload || excess <= 0) return part;
    const marker = wireMediaMarker(part, message);
    const saved = Buffer.byteLength(payload, 'utf8') - Buffer.byteLength(marker.text, 'utf8');
    if (saved <= 0) return part;
    excess -= saved;
    return marker;
  });
}

/** Move only freshly observed tool images to a new segment, not native tool arcs. */
export function wireToolImageEvidence(messages, paths, isImageAnnotation = () => false) {
  return messages.flatMap(message => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return [];
    const isImage = part => IMAGE_TYPES.has(part?.type) && inlineMediaPayload(part);
    const evidence = message.content.filter(part => isImage(part) || isImageAnnotation(part));
    if (!evidence.some(isImage)) return evidence;
    const path = paths.get(message);
    // Copy the path as text next to the evidence: it must survive both an
    // imperfect summary and removal of the inline image from the seed.
    const reference = path ? `; reopen with ViewImage(file_path=${JSON.stringify(path)}) if needed` : '';
    return [{ type: 'text', text: `\nImage evidence from completed tool result ${JSON.stringify(message.toolCallId)}${reference}:\n` }, ...evidence];
  });
}
