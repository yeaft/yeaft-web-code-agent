import { graphemeSegments } from '../vendor/unicode-segmenter/grapheme.js';

const LEADING_CONTEXT = 32;
const PREVIEW_LENGTH = 200;
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

// Older browsers without Intl.Segmenter still use Unicode grapheme boundaries.
// Scan the prefix only once and retain only the clusters overlapping the preview.
function fallbackContaining(text, start, end) {
  const nearby = [];
  for (const segment of graphemeSegments(text)) {
    if (segment.index > end) break;
    if (segment.index + segment.segment.length > start) nearby.push(segment);
  }
  return offset => nearby.find(({ index, segment }) => offset >= index && offset < index + segment.length);
}

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
  const sourceStart = offset => offsets?.[offset] ?? offset;
  const sourceEnd = offset => {
    if (!offsets) return offset;
    while (offsets[offset] === offsets[offset - 1]) offset++;
    return offsets[offset];
  };
  const firstStart = firstHit < 0 ? 0 : sourceStart(firstHit);
  const firstEnd = firstHit < 0 ? 0 : sourceEnd(firstHit + needle.length);
  // Budget the preceding context separately so it can't push typical long
  // phrases past the mobile line clamp. A genuinely oversized hit starts first.
  const hitWidth = firstEnd - firstStart;
  const context = hitWidth <= 24 ? Math.min(LEADING_CONTEXT, 48 - hitWidth) : 0;
  const windowStart = Math.max(0, firstStart - context);
  const windowEnd = Math.min(text.length, Math.max(firstEnd, windowStart + PREVIEW_LENGTH));
  const segments = graphemes?.segment(text);
  const containing = segments ? offset => segments.containing(offset) : fallbackContaining(text, windowStart, windowEnd);
  const clusterStart = offset => containing(offset)?.index ?? offset;
  const clusterEnd = offset => {
    const segment = containing(offset);
    return segment && offset !== segment.index ? segment.index + segment.segment.length : offset;
  };
  const start = clusterStart(windowStart);
  const end = clusterEnd(windowEnd);
  const parts = [];
  let cursor = start;
  for (let hit = firstHit; hit >= 0; hit = folded.indexOf(needle, hit + needle.length)) {
    const originalEnd = sourceEnd(hit + needle.length);
    if (originalEnd > end) break;
    const from = clusterStart(sourceStart(hit)), to = clusterEnd(originalEnd);
    if (from < cursor) continue;
    if (from > cursor) parts.push({ text: text.slice(cursor, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    cursor = to;
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end), match: false });
  return { parts, leading: start > 0, trailing: end < text.length };
}
