/**
 * keywords.js — pure-rule keyword extraction shared by memory recall paths.
 *
 * Pure CPU, no LLM, <1ms. Used by `groups/pre-flow.js` to derive FTS
 * query terms from the user message before hitting `memory/preflow.js`.
 */

/** Common stop words filtered out before frequency counting. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'up', 'it', 'its', 'my', 'me', 'i', 'you',
  'your', 'we', 'our', 'they', 'them', 'their', 'this', 'that', 'what',
  'which', 'who', 'whom', 'these', 'those',
  // Chinese stop words
  '的', '了', '在', '是', '我', '有', '和', '就',
  '不', '人', '都', '一', '一个', '上', '也',
  '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这',
  '他', '她', '吗', '呢', '吧', '把', '被',
  '那', '它', '让', '给', '可以', '什么',
  '怎么', '帮', '帮我', '请', '能', '想',
]);

/**
 * Extract keywords from a prompt (pure rules, no LLM).
 *
 * @param {string} prompt
 * @returns {string[]} keywords sorted by frequency descending then alpha.
 */
export function extractKeywords(prompt) {
  if (!prompt || !prompt.trim()) return [];

  // Tokenize: split on whitespace + punctuation, keep CJK chars.
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));

  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
}
