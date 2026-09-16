// Deterministic, deliberately conservative relevance shared by indexed and
// in-memory turn recall. No provider calls and no transcript mutation.
const MAX_PROMPT_CHARS = 4096;
const MAX_TERMS = 8;
const STOP_WORDS = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please should so that the their them there these they this to was we were what when where which who why will with would you your about again before earlier previous remember recall history message messages conversation turn turns tell show find help need want use using make get know explain answer question code file project problem fix work task test tests implementation implement change thanks continue revisit discuss discussed discussion decide decided follow-up
的 了 是 在 和 与 或 我 你 他 她 它 我们 你们 他们 这个 那个 什么 怎么 如何 为什么 请 请问 帮 帮我 帮忙 可以 能 不能 是否 需要 想 要 再 还 又 也 就 都 把 将 给 对 从 到 上 下 中 里 有 没有 一下 一些 一个 这些 那些 之前 以前 上次 刚才 历史 记得 回忆 召回 消息 对话 问题 回答 内容 事情 继续 现在 今天 昨天 后来 然后 相关 具体 代码 文件 项目 实现 修改 功能 测试 方案 方法 工作 任务 谢谢 好的 好 看看 查找 搜索 查询 处理 解决 进行 使用 讨论 提到 记忆 总结 回顾 提醒`.split(/\s+/u));
for (const word of `system service config configuration settings build run error errors issue issues status result results request requests response responses check checks update updates version versions default option options limit limits page data user users model models tool tools server client input output changes details new old
系统 服务 配置 设置 构建 运行 错误 报错 状态 结果 请求 响应 检查 更新 版本 默认 选项 限制 页面 数据 用户 模型 工具 服务端 客户端 输入 输出 改动 详细 新 旧`.split(/\s+/u)) STOP_WORDS.add(word);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const MIN_COVERAGE = 0.6;
const MIN_DISTINCTIVENESS = 0.5;
const MIN_SCORE = 6.5;

// Paths and concrete issue IDs are strong anchors even when a bounded sample
// contains many discussions of that exact reference. Mere camel/snake casing
// does not make an otherwise common word distinctive.
function isExactReference(term) {
  return term.includes('/')
    || /\.[a-z][a-z0-9]{0,7}$/iu.test(term)
    || /^[a-z][a-z0-9]*(?:[-_:][a-z0-9]+)*[-_:]\d[\da-z_-]*$/iu.test(term)
    || /^(?:[a-z0-9]+[-_:])*[a-f0-9]{8,}$/iu.test(term);
}

function isGenericTerm(term) {
  if (STOP_WORDS.has(term.toLocaleLowerCase())) return true;
  const words = term.replace(/([a-z])([A-Z])/gu, '$1 $2').toLocaleLowerCase().split(/[\s_.:@-]+/u);
  return words.every(word => STOP_WORDS.has(word));
}

/** Automatic recall accepts zero and never exceeds five, even for raw callers. */
export function normalizeRecallLimit(value) {
  const number = typeof value === 'number' || typeof value === 'string' && value.trim()
    ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(5, Math.max(0, Math.floor(number))) : 5;
}

function isIdentifier(term) {
  return /[\p{L}\d][_.:/@-][\p{L}\d]/u.test(term)
    || /\p{L}.*\d|\d.*\p{L}/u.test(term)
    || /[a-z][A-Z]/u.test(term);
}

/** Extract at most eight meaningful lexical terms; generic prompts yield []. */
export function extractRecallTerms(prompt) {
  // VP routing is not subject matter: "@vp-omni 继续" must not recall every
  // earlier message addressed to that VP just because it looks like an ID.
  const text = typeof prompt === 'string'
    ? prompt.slice(0, MAX_PROMPT_CHARS).replace(/@vp-[A-Za-z0-9_-]+\b/gu, ' ') : '';
  const tokens = [];
  // Keep paths, issue IDs, snake_case and camelCase intact before segmentation.
  const rest = text.replace(/(?:\.{0,2}\/)?[\p{L}\p{N}]+(?:[_.:/@-][\p{L}\p{N}]+)+|[A-Za-z][A-Za-z0-9]*/gu, token => {
    tokens.push(token);
    return ' ';
  });
  let singleHan = '';
  const flushHan = () => {
    if (singleHan.length >= 2) tokens.push(singleHan);
    singleHan = '';
  };
  for (const part of segmenter.segment(rest)) {
    // ICU dictionaries sometimes split technical words such as 缓存 into
    // individual Han characters. Preserve short adjacent runs, not stop words.
    if (part.isWordLike && /^\p{Script=Han}$/u.test(part.segment) && !STOP_WORDS.has(part.segment)) {
      singleHan += part.segment;
      if (singleHan.length === 4) flushHan();
    } else {
      flushHan();
      if (part.isWordLike) tokens.push(part.segment);
    }
  }
  flushHan();
  const seen = new Set();
  const terms = tokens.filter(term => {
    const key = term.toLocaleLowerCase();
    if (seen.has(key) || isGenericTerm(term) || /^\d+$/u.test(key)
      || Array.from(key).length < 2 || key.length > 96) return false;
    seen.add(key);
    return true;
  });
  // Identifiers are more useful than prose if a long prompt exhausts the cap.
  return terms.sort((a, b) => Number(isIdentifier(b)) - Number(isIdentifier(a))).slice(0, MAX_TERMS);
}

/**
 * Score full visible turn text. stats.termDocumentFrequency may be a bounded
 * candidate sample, not corpus-wide IDF; its sample size must be explicit.
 * Returns explainable rejection reasons rather than weak positive matches.
 */
export function scoreRecallTurn(promptOrTerms, text, stats = {}) {
  const terms = (Array.isArray(promptOrTerms) ? promptOrTerms : extractRecallTerms(promptOrTerms))
    .filter(term => typeof term === 'string' && !isGenericTerm(term)).slice(0, MAX_TERMS);
  const body = String(text || '').toLocaleLowerCase();
  const matchedTerms = terms.filter(term => {
    const key = term.toLocaleLowerCase();
    if (/^[a-z0-9_]+$/u.test(key) || isIdentifier(term)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const boundary = isIdentifier(term) ? 'a-z0-9_.:/@-' : 'a-z0-9_';
      const suffix = isIdentifier(term) ? '(?![a-z0-9_/@-]|[.:][a-z0-9_])' : `(?![${boundary}])`;
      return new RegExp(`(?<![${boundary}])${escaped}${suffix}`, 'u').test(body);
    }
    return body.includes(key);
  });
  const identifierMatches = matchedTerms.filter(isIdentifier);
  const exactReferenceMatches = matchedTerms.filter(isExactReference);
  const independentTerms = matchedTerms.filter(term => !matchedTerms.some(other => (
    other !== term && other.toLocaleLowerCase().includes(term.toLocaleLowerCase())
  )));
  const coverage = terms.length ? matchedTerms.length / terms.length : 0;
  const sampleSize = Math.max(0, Number(stats.sampleSize) || 0);
  const distinctiveness = matchedTerms.length ? Math.max(...matchedTerms.map(term => {
    const frequency = stats.termDocumentFrequency?.[term.toLocaleLowerCase()];
    return sampleSize >= 8 && Number.isFinite(frequency) ? 1 - frequency / sampleSize : 1;
  })) : 0;
  const rawScore = Math.round((independentTerms.length * 2 + identifierMatches.length * 4
    + coverage * 2 + distinctiveness) * 100) / 100;
  let reason = 'relevant';
  if (!terms.length) reason = 'generic_prompt';
  else if (!matchedTerms.length) reason = 'no_match';
  else if (!identifierMatches.length && independentTerms.length < 2) reason = 'insufficient_keywords';
  else if (coverage < MIN_COVERAGE) reason = 'low_coverage';
  else if (!exactReferenceMatches.length && distinctiveness < MIN_DISTINCTIVENESS) reason = 'low_distinctiveness';
  else if (rawScore < MIN_SCORE) reason = 'low_score';
  const score = reason === 'relevant' ? rawScore : 0;
  return { score, matchedTerms, reason, coverage, distinctiveness, identifierMatches, exactReferenceMatches, sampleSize };
}

export const RECALL_LIMITS = Object.freeze({
  maxTerms: MAX_TERMS,
  maxCandidates: 128,
  candidatesPerTerm: 32,
  shortTermRows: 512,
  maxBoundaryRows: 4096,
  maxTurnRows: 64,
  maxTurnBytes: 64 * 1024,
  maxReadBytes: 256 * 1024,
});
