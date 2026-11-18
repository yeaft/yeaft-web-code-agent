const LEADING_CONTEXT = 32;
const PREVIEW_LENGTH = 200;
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

const splitsSurrogatePair = (text, offset) => (text.charCodeAt(offset - 1) & 0xfc00) === 0xd800
  && (text.charCodeAt(offset) & 0xfc00) === 0xdc00;

// Search uses a literal substring of the stored lowercase text. Map hits back
// to the original casing, including expansions such as İ → i + combining dot.
export function personSearchSnippet(text, query) {
  const folded = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  const firstHit = needle ? folded.indexOf(needle) : -1;
  let offsets;
  if (firstHit >= 0 && folded.length !== text.length) {
    offsets = [];
    let source = 0;
    for (const char of text) {
      for (let i = 0; i < char.toLowerCase().length; i++) offsets.push(source);
      source += char.length;
    }
    offsets.push(source);
  }
  const sourceStart = offset => offsets?.[offset] ?? (offset - Number(splitsSurrogatePair(text, offset)));
  const sourceEnd = offset => {
    if (!offsets) return offset + Number(splitsSurrogatePair(text, offset));
    while (offsets[offset] === offsets[offset - 1]) offset++;
    return offsets[offset];
  };
  const firstStart = firstHit < 0 ? 0 : sourceStart(firstHit);
  const firstEnd = firstHit < 0 ? 0 : sourceEnd(firstHit + needle.length);
  const segments = graphemes?.segment(text);
  const clusterStart = offset => segments?.containing(offset)?.index ?? (offset - Number(splitsSurrogatePair(text, offset)));
  const clusterEnd = offset => {
    const segment = segments?.containing(offset);
    if (!segment) return offset + Number(splitsSurrogatePair(text, offset));
    return offset === segment.index ? offset : segment.index + segment.segment.length;
  };
  // Put long phrases first, rather than spending the mobile line budget on
  // surrounding prose. The line clamp supplies an ellipsis if even the hit is too long.
  const hitWidth = firstEnd - firstStart;
  const context = hitWidth <= 24 ? Math.min(LEADING_CONTEXT, 48 - hitWidth) : 0;
  const start = clusterStart(Math.max(0, firstStart - context));
  const end = clusterEnd(Math.min(text.length, Math.max(firstEnd, start + PREVIEW_LENGTH)));
  const parts = [];
  let cursor = start;
  for (let hit = firstHit; hit >= 0; hit = folded.indexOf(needle, hit + needle.length)) {
    const from = clusterStart(sourceStart(hit)), to = clusterEnd(sourceEnd(hit + needle.length));
    if (to > end) break;
    if (from < cursor) continue;
    if (from > cursor) parts.push({ text: text.slice(cursor, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    cursor = to;
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end), match: false });
  return { parts, leading: start > 0, trailing: end < text.length };
}
