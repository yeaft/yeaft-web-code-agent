/**
 * Creation Categories Registry, Workflow Statuses, Quick-Edit Presets,
 * Review Lenses, and Inline Diff Utility.
 *
 * Pure browser ES module — no Node-only APIs or external dependencies.
 */

export const CREATION_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'article',
    defaultKind: 'book',
    swatchClass: 'is-book',
    labelKey: 'creation.category.article',
    descKey: 'creation.category.articleDesc',
  }),
  Object.freeze({
    id: 'book',
    defaultKind: 'book',
    swatchClass: 'is-book',
    labelKey: 'creation.category.book',
    descKey: 'creation.category.bookDesc',
  }),
  Object.freeze({
    id: 'office_doc',
    defaultKind: 'book',
    swatchClass: 'is-deck',
    labelKey: 'creation.category.office_doc',
    descKey: 'creation.category.office_docDesc',
  }),
  Object.freeze({
    id: 'deck',
    defaultKind: 'deck',
    swatchClass: 'is-deck',
    labelKey: 'creation.category.deck',
    descKey: 'creation.category.deckDesc',
  }),
  Object.freeze({
    id: 'sheet',
    defaultKind: 'book',
    swatchClass: 'is-gallery',
    labelKey: 'creation.category.sheet',
    descKey: 'creation.category.sheetDesc',
  }),
  Object.freeze({
    id: 'media',
    defaultKind: 'video',
    swatchClass: 'is-video',
    labelKey: 'creation.category.media',
    descKey: 'creation.category.mediaDesc',
  }),
]);

export const DOC_WORKFLOW_STATUSES = Object.freeze(['draft', 'review', 'final']);

const CATEGORY_MAP = new Map(CREATION_CATEGORIES.map((c) => [c.id, c]));

const QUICK_EDIT_PRESETS = Object.freeze({
  article: Object.freeze(['polish', 'concise', 'expand']),
  book: Object.freeze(['polish', 'vivid', 'pace']),
  office_doc: Object.freeze(['concise', 'formal', 'bullets']),
  deck: Object.freeze(['punchy', 'bullets', 'concise']),
  sheet: Object.freeze(['clarify', 'concise', 'bullets']),
  media: Object.freeze(['hook', 'spoken', 'pace']),
});

const REVIEW_LENSES = Object.freeze({
  book: Object.freeze(['logic_continuity', 'prose_craft', 'pacing_engagement']),
  article: Object.freeze(['chief_editor', 'fact_argument', 'reader_hook']),
  office_doc: Object.freeze(['executive_decision', 'consistency_clarity', 'risk_execution']),
  deck: Object.freeze(['storyline', 'slide_density', 'tough_qa']),
  sheet: Object.freeze(['formula_metric', 'anomaly_boundary', 'conclusion_alignment']),
  media: Object.freeze(['opening_retention', 'audiovisual_storyboard', 'platform_compliance']),
});

/**
 * Return the legacy `kind` ('book' | 'deck' | 'video') corresponding to a category id.
 * @param {string} categoryId
 * @returns {'book' | 'deck' | 'video'}
 */
export function defaultKindForCategory(categoryId) {
  const entry = CATEGORY_MAP.get(String(categoryId || '').trim());
  return entry ? entry.defaultKind : 'book';
}

/**
 * Infer a default Creation category id from a legacy `kind` value.
 * @param {string} kind
 * @returns {string}
 */
export function inferCategoryFromKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'deck') return 'deck';
  if (k === 'gallery' || k === 'video') return 'media';
  return 'book';
}

/**
 * Resolve a valid category id from a Creation object, falling back to `kind`.
 * @param {object|null|undefined} creation
 * @returns {string}
 */
export function resolveCreationCategory(creation) {
  const raw = String(creation?.category || '').trim();
  if (raw && CATEGORY_MAP.has(raw)) return raw;
  return inferCategoryFromKind(creation?.kind);
}

/**
 * Return the 3 category-specific inline quick-edit presets.
 * @param {string} categoryId
 * @returns {Array<{ id: string, labelKey: string }>}
 */
export function quickEditPresetsForCategory(categoryId) {
  const key = CATEGORY_MAP.has(categoryId) ? categoryId : 'book';
  const ids = QUICK_EDIT_PRESETS[key] || QUICK_EDIT_PRESETS.book;
  return ids.map((id) => ({
    id,
    labelKey: `creation.inlineEdit.${id}`,
  }));
}

/**
 * Return the 3 category-specific review lenses (all default-selected).
 * @param {string} categoryId
 * @returns {Array<{ id: string, labelKey: string, descKey: string, defaultSelected: boolean }>}
 */
export function reviewLensesForCategory(categoryId) {
  const key = CATEGORY_MAP.has(categoryId) ? categoryId : 'book';
  const ids = REVIEW_LENSES[key] || REVIEW_LENSES.book;
  return ids.map((id) => ({
    id,
    labelKey: `creation.review.lens.${id}`,
    descKey: `creation.review.lens.${id}Desc`,
    defaultSelected: true,
  }));
}

// Tokenize into CJK single characters, Latin/alphanumeric words, newlines, whitespace runs, or any single code unit fallback.
const INLINE_TOKEN_RE = /(\r?\n|[ \t]+|[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]|[A-Za-z0-9_'-]+|[\s\S])/g;
const MAX_LCS_CELLS = 160000;

function tokenizeInline(text) {
  if (!text) return [];
  return text.match(INLINE_TOKEN_RE) || [];
}

function mergeHunks(ops) {
  const merged = [];
  for (const op of ops) {
    if (!op.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.type === op.type) {
      prev.text += op.text;
    } else {
      merged.push({ type: op.type, text: op.text });
    }
  }
  return merged;
}

function computeLcsOps(a, b) {
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);

  for (let i = m - 1; i >= 0; i -= 1) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[row + j] = dp[nextRow + j + 1] + 1;
      } else {
        const down = dp[nextRow + j];
        const right = dp[row + j + 1];
        dp[row + j] = down >= right ? down : right;
      }
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ type: 'del', text: a[i] });
    i += 1;
  }
  while (j < n) {
    ops.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return ops;
}

function splitLinesPreserve(text) {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+/g) || [];
}

function diffSlices(a, b) {
  // Trim common prefix & suffix first for speed and determinism.
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops = [];
  if (start > 0) {
    ops.push({ type: 'equal', text: a.slice(0, start).join('') });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length === 0 && midB.length > 0) {
    ops.push({ type: 'add', text: midB.join('') });
  } else if (midB.length === 0 && midA.length > 0) {
    ops.push({ type: 'del', text: midA.join('') });
  } else if (midA.length > 0 && midB.length > 0) {
    if (midA.length * midB.length <= MAX_LCS_CELLS) {
      ops.push(...computeLcsOps(midA, midB));
    } else {
      // Fallback for huge diffs: whole-block del + add so UI never freezes.
      ops.push({ type: 'del', text: midA.join('') });
      ops.push({ type: 'add', text: midB.join('') });
    }
  }

  if (endA < a.length) {
    ops.push({ type: 'equal', text: a.slice(endA).join('') });
  }

  return mergeHunks(ops);
}

/**
 * Compute a fast, deterministic inline diff between `original` and `revised`.
 * Tokenizes CJK chars, Latin words, whitespace, and newlines; falls back to
 * line-level diff when token count would exceed the safe LCS table ceiling.
 *
 * @param {string} original
 * @param {string} revised
 * @returns {Array<{ type: 'equal' | 'del' | 'add', text: string }>}
 */
export function computeInlineDiff(original, revised) {
  const aStr = String(original ?? '');
  const bStr = String(revised ?? '');
  if (aStr === bStr) {
    return aStr ? [{ type: 'equal', text: aStr }] : [];
  }
  if (!aStr) return [{ type: 'add', text: bStr }];
  if (!bStr) return [{ type: 'del', text: aStr }];

  const tokensA = tokenizeInline(aStr);
  const tokensB = tokenizeInline(bStr);

  // Trim common prefix/suffix count to check actual LCS table size.
  let start = 0;
  const minLen = Math.min(tokensA.length, tokensB.length);
  while (start < minLen && tokensA[start] === tokensB[start]) start += 1;
  let endA = tokensA.length;
  let endB = tokensB.length;
  while (endA > start && endB > start && tokensA[endA - 1] === tokensB[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  if ((endA - start) * (endB - start) <= MAX_LCS_CELLS) {
    return diffSlices(tokensA, tokensB);
  }

  // Huge input fallback: line-level diff.
  return diffSlices(splitLinesPreserve(aStr), splitLinesPreserve(bStr));
}
