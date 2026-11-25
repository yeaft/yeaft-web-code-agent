/**
 * route-scorer.js — Pure, zero-LLM local candidate scoring and high-precision
 * fast-path routing for Sessionless auto-routing.
 *
 * Designed as Stage 0 ahead of the compact single-shot LLM arbiter:
 *   1. Extracts content-bearing Latin identifiers, version numbers, and CJK
 *      bigrams (filtering conversational/generic stopwords).
 *   2. Computes scale-invariant normalized IDF (`relIdf` in (0, 1]) so scores
 *      remain calibrated whether a user has 5 or 100 active Sessions.
 *   3. Detects meta-diagnostic references ("看看 X 这个 session 为什么挂了") so
 *      the inspected Session is penalized rather than wrongly targeted.
 *   4. Resolves unmistakable cases locally in <5 ms with 0 LLM calls:
 *        - Rule 0: Exact unambiguous match to a single pending AskUser option
 *        - Rule 1: Exact/near-exact repeated user utterance in one Session
 *        - Rule 2: Strong scale-invariant lexical margin in a fresh (<24h) Session
 *        - Rule 3: Multiple unique-term hits in a recently active (<2h) Session
 *        - Rule 4: Short/anaphoric continuation when only ONE Session was active
 *                  within 30m and no other Session was active within 3h
 */

import { basename } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are', 'was', 'were',
  'not', 'but', 'you', 'your', 'can', 'will', 'should', 'would', 'could', 'what',
  'when', 'where', 'why', 'how', 'all', 'any', 'some', 'one', 'two', 'about', 'into',
  'out', 'use', 'using', 'used', 'make', 'get', 'set', 'add', 'fix', 'check', 'look',
  'see', 'just', 'now', 'still', 'also', 'only', 'then', 'than', 'very', 'more',
  'most', 'need', 'want', 'like', 'please', 'help', 'tell', 'give', 'show', 'let',
  'try', 'run', 'new', 'old', 'same', 'other', 'here', 'there', 'session', 'sessions',
  'message', 'messages', 'user', 'assistant', 'ai', 'ok', 'yes', 'no', 'hi', 'hello',
]);

// High-frequency Chinese functional/conversational chars that carry no topic signal alone.
const ZH_FUNC_CHARS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也',
  '和', '与', '或', '但', '而', '个', '一', '不', '没', '有', '要', '会', '能', '可', '以',
  '把', '被', '给', '让', '到', '对', '为', '从', '比', '跟', '很', '太', '更', '最', '还',
  '再', '又', '已', '刚', '才', '只', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '嘛', '啦',
  '啥', '么', '什', '怎', '哪', '谁', '几', '多', '少', '好', '行', '中', '上', '下', '里',
  '内', '外', '前', '后', '大', '小', '看', '帮', '去', '来', '做', '说', '问', '想', '觉',
  '感', '应', '该', '需', '希', '望', '知', '道', '明', '白', '确', '定', '其', '实', '如',
  '果', '因', '所', '虽', '然', '过', '另', '且', '并', '之', '于', '着', '得', '地', '等',
  '请', '谢', '别', '非', '常', '较', '直', '接', '先', '进', '出', '起', '回', '开', '关',
]);

const ZH_STOP_BIGRAMS = new Set([
  '帮我', '你帮', '我看', '看看', '你去', '去帮', '可以', '不是', '还是', '就是', '觉得',
  '感觉', '应该', '没有', '一下', '一个', '这个', '那个', '什么', '怎么', '为什么', '是不是',
  '能不能', '有没有', '还有', '另外', '然后', '如果', '但是', '因为', '所以', '或者', '而且',
  '现在', '目前', '已经', '之前', '刚才', '这样', '那样', '的话', '问题', '地方', '东西',
  '内容', '情况', '时候', '方面', '功能', '需要', '希望', '麻烦', '谢谢', '非常', '比较',
  '直接', '继续', '开始', '完成', '实现', '修改', '修复', '优化', '分析', '确认', '检查',
  '处理', '一些', '这种', '那种', '所有', '其他', '自己', '我们', '你们', '他们', '这里',
  '那里', '上面', '下面', '里面', '外面', '可能', '大概', '好像', '似乎', '真的', '其实',
  '当然', '确实', '不过', '只是', '只要', '哪怕', '对了', '好的', '明白', '知道', '了解',
  '清楚', '不错', '挺好', '很好', '有点', '一点', '很多', '不少', '主要',
  // Generic ops/meta words that appear across unrelated projects and should not solo-trigger fast-path.
  '版本', '新版', '最新', '日志', '发布', '更新', '改成', '服务', '部署', '停止', '更加',
  '三个', '两个',
]);

const EXPLICIT_NEW_SESSION_RE = /(?:^|[\s,，。])(?:新开一个|另开一个|开个新|新建一个|换个话题|聊点别的|说个别的|写一个独立的|写一份通用的|写一篇|推荐几本|推荐两本|start a new|new topic|new session|standalone\s)/iu;

const SHORT_CONTINUATION_RE = /^(?:(?:你看看|你看|帮我看看|帮我看|那|可是|但是|对了)[，,\s]*)?(?:继续|好了吗|创建了吗|创建好了吗|做完了吗|执行完了吗|你是都执行完了吗|可以|好|好的|行|没问题|试试|去吧|去做吧|执行吧|继续吧|继续别停|继续帮我|下一步|然后呢|那这个|这个|下面这个|上面这个|刚才那个|全帮我|帮我修复|你做什么了|回答我|非常好|非常版|很棒|不错)/iu;

const ANAPHORIC_CONTINUATION_RE = /(?:这个图|这个表|这个服务|这个\s*folder|你这个|下面这个|上面那个|刚才那个|再给我生成|也生产了吗|也生成了吗|怎么中间停止了|继续啊|继续别停|继续帮我|下一步咱们|执行完了吗|创建好了吗|创建了吗)/iu;

const META_SESSION_DIAGNOSTIC_RE = /(?:这个\s*session|session\s*(?:是|叫|里|中|老|一直|为什么)|为什么.*(?:挂|停|失败|没回复|没有回复|没有\s*response|正常终止|断)|老是自己停止|怎么挂|又挂了|最新\s*message|pr\s*都开始|一个\s*(?:delta|response|回复).*都没有)/iu;

export function normalizeRouteText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().trim();
}

export function normalizeForExactUtterance(text) {
  return normalizeRouteText(text).replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Format elapsed milliseconds as a compact, human-readable relative age
 * ("just now", "5m ago", "3h ago", "2d ago") for LLM routing context.
 */
export function formatRelativeAge(ageMs) {
  const min = Math.max(0, Math.round(Math.max(0, Number(ageMs) || 0) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Compact a message excerpt by preserving BOTH head (topic/opening) and tail
 * (final conclusion, version/PR number, or pending question).
 */
export function compactMessageExcerpt(text, maxChars = 220) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 12) return clean.slice(0, maxChars);
  const headLen = Math.floor(maxChars * 0.56);
  const tailLen = Math.max(1, maxChars - headLen - 3);
  let head = clean.slice(0, headLen);
  if (head.length > 0) {
    const lastCode = head.charCodeAt(head.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1);
  }
  let tail = clean.slice(-tailLen);
  if (tail.length > 0) {
    const firstCode = tail.charCodeAt(0);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) tail = tail.slice(1);
  }
  return `${head.trim()} … ${tail.trim()}`;
}

/**
 * Extract content-bearing lexical terms from a query or message.
 * Keeps Latin/code identifiers, 3+ digit numbers (versions/ports/status codes),
 * and non-stopword CJK bigrams.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function extractRoutingTerms(text) {
  const norm = normalizeRouteText(text);
  const terms = new Map();
  const add = (term, weight = 1) => {
    terms.set(term, (terms.get(term) || 0) + weight);
  };

  // 1. Latin / numeric / dotted or hyphenated identifiers (e.g. zy.yeaft.com, response.failed, gpt-6.2)
  for (const m of norm.matchAll(/[a-z0-9][a-z0-9._/-]{1,48}/g)) {
    const raw = m[0].replace(/[._/-]+$/, '');
    if (raw.length < 2) continue;
    const isNumberOnly = /^\d+$/.test(raw);
    if (!EN_STOPWORDS.has(raw) && (!isNumberOnly || raw.length >= 3)) {
      add(raw, isNumberOnly ? 1.2 : 1.5);
    }
    const parts = raw
      .split(/[._/-]+/)
      .filter(p => p.length >= 2 && !EN_STOPWORDS.has(p) && (!/^\d+$/.test(p) || p.length >= 3));
    if (parts.length > 1) {
      for (const part of parts) add(part, 1.0);
    }
  }

  // 2. CJK content bigrams
  for (const m of norm.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const run = m[0];
    if (run.length < 2) continue;
    for (let i = 0; i < run.length - 1; i += 1) {
      const bg = run.slice(i, i + 2);
      if (ZH_STOP_BIGRAMS.has(bg)) continue;
      if (ZH_FUNC_CHARS.has(bg[0]) && ZH_FUNC_CHARS.has(bg[1])) continue;
      const weight = (!ZH_FUNC_CHARS.has(bg[0]) && !ZH_FUNC_CHARS.has(bg[1])) ? 1.4 : 0.7;
      add(bg, weight);
    }
  }

  return terms;
}

export function isExplicitNewSessionIntent(query) {
  return EXPLICIT_NEW_SESSION_RE.test(String(query || ''));
}

export function isShortContinuationQuery(query) {
  const clean = normalizeRouteText(query);
  if (!clean || clean.length > 40 || EXPLICIT_NEW_SESSION_RE.test(clean)) return false;
  if (SHORT_CONTINUATION_RE.test(clean)) return true;
  if (clean.length <= 36 && ANAPHORIC_CONTINUATION_RE.test(clean)) return true;
  const terms = extractRoutingTerms(clean);
  return clean.length <= 22
    && terms.size <= 3
    && /(?:这个|那个|它|上面|下面|继续|好了|完了|修复|实现|帮我|怎么|挡住|吗\??$)/u.test(clean);
}

/**
 * Identify candidate Sessions being inspected as meta-diagnostic subjects
 * (e.g. "帮我看看 ZhongYi 这个 session 为什么挂了"), so we avoid routing into
 * the broken/inspected Session itself.
 *
 * @param {string} query
 * @param {Array<{ sessionId: string, title?: string }>} candidates
 * @returns {Set<string>}
 */
export function detectMetaSessionReferences(query, candidates = []) {
  const normQ = normalizeRouteText(query);
  if (!META_SESSION_DIAGNOSTIC_RE.test(normQ)) return new Set();
  const excluded = new Set();
  for (const c of candidates) {
    const titleNorm = normalizeRouteText(c?.title || '');
    if (!titleNorm || titleNorm.length < 3) continue;
    if (normQ.includes(titleNorm)) excluded.add(c.sessionId);
  }
  return excluded;
}

function getPendingQuestions(candidate) {
  if (Array.isArray(candidate?.pendingQuestions) && candidate.pendingQuestions.length > 0) {
    return candidate.pendingQuestions.filter(q => q?.question);
  }
  if (candidate?.pendingQuestion?.question) return [candidate.pendingQuestion];
  return [];
}

/**
 * Score all candidate Sessions (running + idle) against an incoming query using
 * scale-invariant IDF, recency-weighted TF, exact utterance matching, and
 * older-turn snippet extraction.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {Array<object>} params.candidates
 * @param {number} [params.now=Date.now()]
 * @param {number} [params.activeWindowDays=5]
 * @returns {{ scored: Array<object>, metaExcluded: Set<string>, queryTerms: Map<string, number> }}
 */
export function scoreRouteCandidates({
  query = '',
  candidates = [],
  now = Date.now(),
  activeWindowDays = 5,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const qTerms = extractRoutingTerms(query);
  const qNormExact = normalizeForExactUtterance(query);
  const metaExcluded = detectMetaSessionReferences(query, list);
  const N = Math.max(1, list.length);
  const windowMs = Math.max(1, Number(activeWindowDays) || 5) * DAY_MS;

  const df = new Map();
  const perCandidate = new Map();

  for (const cand of list) {
    const messages = Array.isArray(cand?.windowMessages) && cand.windowMessages.length > 0
      ? cand.windowMessages
      : (Array.isArray(cand?.recentMessages) ? cand.recentMessages : []);

    const recentMsgs = messages.slice(-8);
    const olderMsgs = messages.slice(-40, -8).filter(m => !m?.createdAt || (now - m.createdAt) <= windowMs);

    const recentTerms = new Map();
    const olderTerms = new Map();
    const projectName = cand?.workDir ? basename(cand.workDir) : '';
    const titleTerms = extractRoutingTerms(`${cand?.title || ''} ${projectName}`);
    const userExactSet = new Set();

    recentMsgs.forEach((m, i) => {
      const text = String(m?.text ?? m?.content ?? '');
      if (!text) return;
      const recencyW = 0.5 + 0.5 * ((i + 1) / recentMsgs.length);
      const roleW = m?.role === 'user' ? 1.25 : 0.85;
      const msgTs = Number.isFinite(m?.createdAt) && m.createdAt > 0 ? m.createdAt : (cand?.activeAt || now);
      const ageHours = Math.max(0, (now - msgTs) / 3_600_000);
      const timeW = 1 / (1 + ageHours / 24);
      const weight = recencyW * roleW * (0.4 + 0.6 * timeW);
      for (const [term, count] of extractRoutingTerms(text.slice(0, 1800))) {
        recentTerms.set(term, (recentTerms.get(term) || 0) + Math.min(count, 3) * weight);
      }
      if (m?.role === 'user') {
        const normExact = normalizeForExactUtterance(text);
        if (normExact.length >= 6) userExactSet.add(normExact);
      }
    });

    let bestOlderSnippet = '';
    let bestOlderHitScore = 0;
    for (const m of olderMsgs) {
      const text = String(m?.text ?? m?.content ?? '');
      if (!text) continue;
      const mTerms = extractRoutingTerms(text.slice(0, 900));
      let overlap = 0;
      for (const [term, count] of mTerms) {
        olderTerms.set(term, (olderTerms.get(term) || 0) + Math.min(count, 2) * 0.35);
        if (qTerms.has(term)) overlap += qTerms.get(term);
      }
      if (overlap > bestOlderHitScore) {
        bestOlderHitScore = overlap;
        bestOlderSnippet = text.slice(0, 180);
      }
      if (m?.role === 'user') {
        const normExact = normalizeForExactUtterance(text);
        if (normExact.length >= 6) userExactSet.add(normExact);
      }
    }

    // If caller supplied a pre-matched FTS snippet and no older message beat it, keep it.
    if (!bestOlderSnippet && typeof cand?.matchedOlderSnippet === 'string' && cand.matchedOlderSnippet.trim()) {
      bestOlderSnippet = cand.matchedOlderSnippet.trim().slice(0, 180);
      bestOlderHitScore = 3.0;
    }

    const docTermSet = new Set([...recentTerms.keys(), ...olderTerms.keys(), ...titleTerms.keys()]);
    for (const term of docTermSet) df.set(term, (df.get(term) || 0) + 1);
    perCandidate.set(cand.sessionId, {
      recentTerms,
      olderTerms,
      titleTerms,
      userExactSet,
      bestOlderSnippet,
      bestOlderHitScore,
    });
  }

  const maxIdf = Math.log(1 + (N - 0.5) / 1.5) + 0.35;
  let totalQueryWeight = 0;
  for (const [, qw] of qTerms) totalQueryWeight += qw;

  const scored = [];
  for (const cand of list) {
    const info = perCandidate.get(cand.sessionId);
    const isMetaTarget = metaExcluded.has(cand.sessionId);

    let exactUtteranceMatch = false;
    if (qNormExact.length >= 6 && !isMetaTarget) {
      if (info.userExactSet.has(qNormExact)) {
        exactUtteranceMatch = true;
      } else if (qNormExact.length >= 16) {
        const qHead = qNormExact.slice(0, 20);
        for (const prev of info.userExactSet) {
          if (prev.length >= 16 && (prev.includes(qHead) || qNormExact.includes(prev.slice(0, 20)))) {
            exactUtteranceMatch = true;
            break;
          }
        }
      }
    }

    let lexScore = 0;
    let matchedQueryWeight = 0;
    let distinctiveHits = 0;
    let uniqueHits = 0;
    const matchedTerms = [];

    for (const [term, qw] of qTerms) {
      const dFreq = df.get(term) || 0;
      if (dFreq === 0) continue;
      const rawIdf = Math.log(1 + (N - dFreq + 0.5) / (dFreq + 0.5)) + 0.35;
      // Scale-invariant normalized IDF in (0, 1.0]: independent of pool size N.
      const relIdf = rawIdf / Math.max(1, maxIdf);
      const rTf = info.recentTerms.get(term) || 0;
      const oTf = info.olderTerms.get(term) || 0;
      const tTf = isMetaTarget ? 0 : (info.titleTerms.get(term) || 0);
      const tf = Math.log1p(rTf) * 1.4 + Math.log1p(oTf) * 0.55 + Math.log1p(tTf) * 0.6;
      if (tf > 0) {
        const contrib = qw * (relIdf * 2.0) * tf;
        lexScore += contrib;
        matchedQueryWeight += qw;
        if (relIdf >= 0.58 && rTf > 0) distinctiveHits += 1;
        if (dFreq === 1 && (rTf > 0 || oTf > 0)) uniqueHits += 1;
        matchedTerms.push({ term, contrib });
      }
    }

    if (isMetaTarget) lexScore *= 0.15;

    const normFactor = Math.sqrt(Math.max(3, qTerms.size));
    const normLex = lexScore / normFactor;
    const queryCoverage = totalQueryWeight > 0 ? matchedQueryWeight / totalQueryWeight : 0;

    const activeAt = Number.isFinite(cand?.activeAt) && cand.activeAt > 0
      ? cand.activeAt
      : (cand?.isRunning ? now : 0);
    const ageMs = activeAt > 0 ? Math.max(0, now - activeAt) : Number.MAX_SAFE_INTEGER;
    const ageMin = ageMs / 60_000;
    const recencyScore = ageMin <= 10 ? 1.8
      : ageMin <= 30 ? 1.3
      : ageMin <= 120 ? 0.8
      : ageMin <= 720 ? 0.4
      : 0.15;

    const totalScore = (exactUtteranceMatch ? 20 : 0)
      + normLex * 2.5
      + (normLex > 0.3 ? recencyScore : recencyScore * 0.2);

    matchedTerms.sort((a, b) => b.contrib - a.contrib);
    scored.push({
      ...cand,
      activeAt,
      ageMs,
      ageMin: Number.isFinite(ageMin) ? Math.round(ageMin) : 999_999,
      ageText: activeAt > 0 ? formatRelativeAge(ageMs) : 'unknown',
      exactUtteranceMatch,
      isMetaTarget,
      normLex: Math.round(normLex * 100) / 100,
      queryCoverage: Math.round(queryCoverage * 100) / 100,
      distinctiveHits,
      uniqueHits,
      totalScore: Math.round(totalScore * 100) / 100,
      matchedTerms: matchedTerms.slice(0, 4).map(x => x.term),
      matchedOlderSnippet: normLex >= 1.5 && info.bestOlderHitScore >= 3.0 ? info.bestOlderSnippet : '',
    });
  }

  scored.sort((a, b) => b.totalScore - a.totalScore || a.ageMs - b.ageMs || a.sessionId.localeCompare(b.sessionId));
  return { scored, metaExcluded, queryTerms: qTerms };
}

/**
 * Attempt Stage 0 zero-LLM fast-path routing. Returns a complete decision object
 * ONLY when confidence is overwhelmingly high; returns `null` whenever there is
 * any ambiguity so Stage 1 LLM arbiter decides.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {Array<object>} params.scoredCandidates
 * @param {Set<string>} [params.metaExcluded]
 * @returns {object | null}
 */
export function tryFastPathRoute({
  query = '',
  scoredCandidates = [],
  metaExcluded = new Set(),
} = {}) {
  if (!Array.isArray(scoredCandidates) || scoredCandidates.length === 0) return null;

  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return null;

  // Rule 0: Exact unambiguous match against a single pending AskUser option.
  const waitingSessions = scoredCandidates
    .map(c => ({ candidate: c, questions: getPendingQuestions(c) }))
    .filter(x => x.questions.length > 0);
  if (waitingSessions.length > 0) {
    if (waitingSessions.length === 1 && waitingSessions[0].questions.length === 1) {
      const { candidate, questions } = waitingSessions[0];
      const pq = questions[0];
      const opts = Array.isArray(pq.options)
        ? pq.options.map(o => normalizeRouteText(String(o || ''))).filter(Boolean)
        : [];
      const normQ = normalizeRouteText(cleanQuery);
      if (opts.length > 0 && opts.includes(normQ)) {
        return {
          action: 'continue',
          tier: 'running',
          sessionId: candidate.sessionId,
          title: candidate.title || candidate.sessionId,
          sceneId: candidate.sceneId || null,
          workDir: candidate.workDir || '',
          answeredQuestion: pq.requestId ? pq : null,
          confidence: 0.99,
          reason: 'fast_path:exact_ask_user_option',
          routeSource: 'fast_path',
          fastPathRule: 'exact_ask_user_option',
          decisionModel: null,
        };
      }
    }
    // Whenever any AskUser prompt is pending and the reply isn't an exact option
    // match, always defer to the LLM arbiter so we never miss or falsely settle it.
    return null;
  }

  if (isExplicitNewSessionIntent(cleanQuery) || metaExcluded.size > 0) return null;

  const top1 = scoredCandidates[0];
  const top2 = scoredCandidates[1] || null;

  const buildHit = (candidate, confidence, rule, detail = '') => ({
    action: 'continue',
    tier: candidate.isRunning ? 'running' : 'recent',
    sessionId: candidate.sessionId,
    title: candidate.title || candidate.sessionId,
    sceneId: candidate.sceneId || null,
    workDir: candidate.workDir || '',
    answeredQuestion: null,
    confidence,
    reason: detail ? `fast_path:${rule}(${detail})` : `fast_path:${rule}`,
    routeSource: 'fast_path',
    fastPathRule: rule,
    decisionModel: null,
  });

  // Rule 1: Exact / near-exact repeated user utterance in one unique Session.
  if (top1.exactUtteranceMatch && (!top2 || !top2.exactUtteranceMatch)) {
    return buildHit(top1, 0.98, 'exact_utterance');
  }

  // Rule 2: Strong scale-invariant lexical match with clear margin in a fresh (<24h) Session.
  const lexRatio = top2 ? (top1.normLex / Math.max(0.15, top2.normLex)) : 10;
  const sameWorkDir = Boolean(top2 && top1.workDir && top1.workDir === top2.workDir);
  if (
    top1.ageMin <= 24 * 60
    && top1.normLex >= 2.8
    && top1.distinctiveHits >= 2
    && top1.queryCoverage >= 0.25
    && (lexRatio >= 2.0 || (sameWorkDir && lexRatio >= 1.3 && top1.ageMin <= 60))
  ) {
    return buildHit(top1, 0.94, 'strong_lexical', top1.matchedTerms.join(','));
  }

  // Rule 3: Multiple unique-term hits in a recently active (<2h) Session.
  if (
    top1.ageMin <= 120
    && top1.normLex >= 2.0
    && top1.uniqueHits >= 2
    && top1.queryCoverage >= 0.22
    && (!top2 || top1.normLex >= top2.normLex * 2.2)
  ) {
    return buildHit(top1, 0.92, 'unique_recent', top1.matchedTerms.join(','));
  }

  // Rule 4: Short/anaphoric continuation when ONLY ONE Session was active
  // within 30 minutes and no other Session was active within 3 hours.
  const byAge = [...scoredCandidates].sort((a, b) => a.ageMs - b.ageMs);
  if (
    isShortContinuationQuery(cleanQuery)
    && byAge[0].ageMin <= 30
    && (!byAge[1] || byAge[1].ageMin >= 180)
  ) {
    return buildHit(byAge[0], 0.92, 'sole_recent_continuation');
  }

  return null;
}

/**
 * Select the compact bounded candidate list for Stage 1 LLM routing:
 *   - All currently running Sessions
 *   - Top scored (lexical + recency) idle Sessions
 *   - Top 2 most-recently-active idle Sessions (so short continuations never drop out)
 */
export function selectCandidatesForLlm({
  scoredCandidates = [],
  maxTotal = 7,
} = {}) {
  const limit = Math.max(1, Math.min(12, Math.floor(Number(maxTotal) || 7)));
  const chosen = [];
  const seen = new Set();

  // 1. All running Sessions (highest visibility, never omitted).
  for (const c of scoredCandidates) {
    if (c.isRunning && !seen.has(c.sessionId)) {
      chosen.push(c);
      seen.add(c.sessionId);
    }
  }

  // 2. Top relevance-scored idle Sessions (leave up to 2 slots for most-recent idle).
  const relevanceCap = Math.max(chosen.length, limit - 2);
  for (const c of scoredCandidates) {
    if (chosen.length >= relevanceCap) break;
    if (seen.has(c.sessionId)) continue;
    chosen.push(c);
    seen.add(c.sessionId);
  }

  // 3. Top 2 most-recently-active idle Sessions.
  const byRecency = scoredCandidates
    .filter(c => !c.isRunning && !seen.has(c.sessionId))
    .sort((a, b) => a.ageMs - b.ageMs);
  for (const c of byRecency) {
    if (chosen.length >= limit) break;
    chosen.push(c);
    seen.add(c.sessionId);
  }

  // 4. Fill any remaining slots from relevance order.
  for (const c of scoredCandidates) {
    if (chosen.length >= limit) break;
    if (seen.has(c.sessionId)) continue;
    chosen.push(c);
    seen.add(c.sessionId);
  }

  return chosen;
}
