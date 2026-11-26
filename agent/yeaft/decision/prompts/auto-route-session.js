import { basename } from 'node:path';
import { SESSION_SCENE_IDS } from '../../sessions/scene-ids.js';
import { compactMessageExcerpt, formatRelativeAge } from '../../session-discovery/route-scorer.js';
import {
  boundedText,
  clampConfidence,
  composeDecisionSystemPrompt,
  fallbackShortTitle,
} from './shared.js';

const VALID_DECISIONS = new Set(['match', 'create']);
export const AUTO_ROUTE_SESSION_SCENARIO_ID = 'auto-route-session';
// Point-in-time replay of real multi-Session history showed that arbiter matches
// scored 0.5-0.7 are right far more often than the "create" they used to be
// downgraded to (a create always loses the conversation the user is continuing).
export const DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE = 0.5;
/** @deprecated Short continuations share DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE; kept for existing importers. */
export const DEFAULT_AUTO_ROUTE_SHORT_CONT_MIN_CONFIDENCE = DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE;

// Per-candidate excerpt budgets (characters). The latest reply gets the most
// room and keeps more of its tail, where offers and questions usually sit.
const LAST_REPLY_CHARS = 640;
const LAST_USER_CHARS = 280;
const EARLIER_CHARS = 160;
const MAX_PROMPT_CANDIDATES = 10;

export const AUTO_ROUTE_SESSION_PROMPT = composeDecisionSystemPrompt(`Route ONE new user message, typed into a global input box without choosing a Session, to the existing Session the user means, or create a new Session.

The user runs several Sessions in parallel, often on the same repository, and usually types right after reading one Session's latest reply. Candidates are ordered most recently active first. Each candidate has: status (replied | running | waiting_input | interrupted = its last request got no final reply), age, lastUser (the user's latest request there), lastReply (the latest assistant message, which the user may be reacting to), earlier turns, optional olderMatch (an older message similar to the new one) and pendingQuestions.

Return JSON only (reason <= 15 words):
- Match: {"decision":"match","sessionId":"<exact id>","answeredRequestId":null,"confidence":0.0-1.0,"reason":"..."}
- Create: {"decision":"create","sessionId":null,"answeredRequestId":null,"confidence":0.0-1.0,"sceneId":"general","workDir":"","title":"short title","reason":"..."}

Decide in this order:
1. Pending question: if the message answers a candidate's pendingQuestion (one of its options or a direct reply to it), match that Session and set answeredRequestId to that question's requestId. Otherwise answeredRequestId is null.
2. Explicit anchor: the message names something only one candidate is working on (Session title, PR/issue/build number, branch, file, service, port, URL, error text, person or entity), so match that candidate.
3. Meta-diagnostics: if the message asks why another Session X failed, stopped, hung or gave no reply, never route into X; route to the candidate that has been diagnosing Sessions/agent problems, else create.
4. Reaction to a reply: acknowledgments, approvals, follow-up questions, corrections and short commands ("很好/可以/行，去做吧", "去merge吧", "这个是什么意思？", "现在怎么样了？", "继续") continue the Session whose lastReply they respond to, i.e. the reply offered, proposed, asked or reported exactly that. Judge by content first; only when content fits several replies equally, prefer the most recent reply. "继续/请继续/怎么停了" also fit an interrupted or running Session.
5. Topic continuation: the same task as a candidate's current work (same feature, PR, document, bug or artifact) continues the candidate whose CURRENT work it is, not merely one on the same repository.
6. New work on a project: if exactly one candidate is that project's own Session (its title or project is the repository/product itself and it handles assorted work there), continue it so the project context carries over. If the project's candidates are each dedicated to other specific features or tasks (titles like "X - Design", "X - PR", "Daily-Limitation"), a new feature, requirement or goal gets a new Session.
7. Create when the message explicitly asks for a new topic/session ("新开…", "这个session是用来做…", "我现在要做一个新feature…"), starts work no candidate is doing per rule 6, or is an unrelated domain/standalone question.
Twins: if two candidates show identical history, pick the most recently active one.

Confidence: 0.9+ for an answer or explicit anchor, 0.7-0.9 for a clear content fit, 0.5-0.7 for the best guess among similar Sessions. When the message continues existing work, return your best match rather than create.

When "create":
- sceneId MUST be in allowedScenes: general (everyday/travel/networking/lifestyle/cross-domain), software (backend/CLI/DevOps/scripts/DB), frontend (UI/CSS/layout/animation), writing (articles/editing/copy/changelog/emails), short-video (short-video scripts/hooks), video-editing (FFmpeg/cutting/captions), primary-education (K-6 tutoring), investment (stocks/funds/valuation/macro).
- workDir: "" (non-repo/standalone/general questions) OR an EXACT path copied verbatim from candidateFolders[].path when clearly tied to that repo.
- title: concise 4-18 Chinese chars or 2-7 English words in the user's language.`);

function resolveAllowedScenes(allowedScenes) {
  const list = Array.isArray(allowedScenes) && allowedScenes.length > 0
    ? allowedScenes.filter(id => SESSION_SCENE_IDS.includes(id))
    : [...SESSION_SCENE_IDS];
  return list.length > 0 ? [...new Set(list)] : ['general'];
}

function normalizePendingQuestions(item) {
  const raw = Array.isArray(item?.pendingQuestions)
    ? item.pendingQuestions
    : (item?.pendingQuestion ? [item.pendingQuestion] : []);
  return raw.slice(0, 6).map(pq => ({
    ...(pq?.requestId ? { requestId: boundedText(pq.requestId, 160) } : {}),
    question: boundedText(pq?.question || '', 400),
    options: Array.isArray(pq?.options)
      ? pq.options.slice(0, 8).map(opt => boundedText(String(opt), 120))
      : [],
  })).filter(pq => pq.question);
}

function messageText(message) {
  return String(message?.text ?? message?.content ?? '').trim();
}

/**
 * Project one candidate Session into the compact turn-state view the arbiter
 * reasons over: what the user last asked there, what the Session last replied
 * (and how long ago), whether that turn finished, plus a little earlier context.
 *
 * @param {object} item - Scored candidate (running or idle) from auto-route.
 * @param {number} now - Routing clock (ms).
 * @returns {object|null}
 */
export function describeRouteCandidate(item, now = Date.now()) {
  const id = boundedText(item?.sessionId || '', 160);
  if (!id) return null;
  const source = Array.isArray(item?.windowMessages) && item.windowMessages.length > 0
    ? item.windowMessages
    : (Array.isArray(item?.recentMessages) ? item.recentMessages : []);
  const msgs = source.filter(m => (m?.role === 'user' || m?.role === 'assistant') && messageText(m));
  let lastUserIdx = -1;
  let lastReplyIdx = -1;
  for (let i = msgs.length - 1; i >= 0 && (lastUserIdx < 0 || lastReplyIdx < 0); i -= 1) {
    if (msgs[i].role === 'user' && lastUserIdx < 0) lastUserIdx = i;
    if (msgs[i].role === 'assistant' && lastReplyIdx < 0) lastReplyIdx = i;
  }
  const pendingQuestions = normalizePendingQuestions(item);
  const running = item?.isRunning === true || item?.state === 'running' || item?.state === 'waiting_input';
  let status = 'replied';
  if (pendingQuestions.length) status = 'waiting_input';
  else if (running) status = 'running';
  else if (lastUserIdx > lastReplyIdx) status = 'interrupted';

  const ageOf = message => {
    const ts = Number(message?.createdAt);
    return Number.isFinite(ts) && ts > 0 ? formatRelativeAge(now - ts) : undefined;
  };
  const turnStart = [lastUserIdx, lastReplyIdx].filter(i => i >= 0);
  const cut = turnStart.length ? Math.min(...turnStart) : msgs.length;
  const earlier = msgs.slice(Math.max(0, cut - 2), cut).map(m => ({
    r: m.role === 'user' ? 'u' : 'a',
    t: compactMessageExcerpt(messageText(m), EARLIER_CHARS),
  }));
  const project = item?.workDir ? basename(item.workDir) : '';
  const lastUser = lastUserIdx >= 0 ? msgs[lastUserIdx] : null;
  const lastReply = lastReplyIdx >= 0 ? msgs[lastReplyIdx] : null;
  return {
    id,
    title: boundedText(item?.title || '', 80),
    status,
    ...(item?.ageText ? { age: boundedText(item.ageText, 24) } : {}),
    ...(project ? { project: boundedText(project, 80) } : {}),
    ...(item?.sceneId ? { scene: boundedText(item.sceneId, 40) } : {}),
    ...(pendingQuestions.length ? { pendingQuestions } : {}),
    ...(lastUser ? { lastUser: { ...(ageOf(lastUser) ? { age: ageOf(lastUser) } : {}), t: compactMessageExcerpt(messageText(lastUser), LAST_USER_CHARS, 0.6) } } : {}),
    ...(lastReply ? { lastReply: { ...(ageOf(lastReply) ? { age: ageOf(lastReply) } : {}), t: compactMessageExcerpt(messageText(lastReply), LAST_REPLY_CHARS, 0.4) } } : {}),
    ...(earlier.length ? { earlier } : {}),
    ...(item?.matchedOlderSnippet ? { olderMatch: compactMessageExcerpt(item.matchedOlderSnippet, 140) } : {}),
  };
}

function candidateActiveAt(item) {
  const ts = Number(item?.activeAt);
  return Number.isFinite(ts) && ts > 0 ? ts : (item?.isRunning ? Number.MAX_SAFE_INTEGER : 0);
}

export function buildAutoRouteSessionUserPrompt({
  candidates = [],
  allowedScenes = SESSION_SCENE_IDS,
  candidateFolders = [],
  newQuery = '',
  now = Date.now(),
} = {}) {
  const scenes = resolveAllowedScenes(allowedScenes);
  // Most recently active first: matches the "reacting to the latest reply" prior
  // and keeps the model's positional bias aligned with recency.
  const ordered = (candidates || [])
    .slice(0, MAX_PROMPT_CANDIDATES)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => candidateActiveAt(b.item) - candidateActiveAt(a.item) || a.index - b.index)
    .map(({ item }) => item);
  const payload = {
    candidates: ordered.map(item => describeRouteCandidate(item, now)).filter(Boolean),
    allowedScenes: scenes,
    candidateFolders: (candidateFolders || []).slice(0, 10).map(folder => {
      const path = typeof folder === 'string' ? folder : folder?.path || '';
      return {
        path: boundedText(path, 512),
        ...(folder?.name ? { name: boundedText(folder.name, 80) } : {}),
        ...(folder?.label ? { label: boundedText(folder.label, 50) } : {}),
      };
    }).filter(f => f.path),
    newQuery: boundedText(newQuery, 1000),
  };
  return JSON.stringify(payload);
}

export function fallbackAutoRouteSession({
  newQuery = '',
  allowedScenes = SESSION_SCENE_IDS,
  preferredSceneId = null,
  preferredWorkDir = '',
  candidateFolders = [],
} = {}, reason = 'fallback') {
  const scenes = resolveAllowedScenes(allowedScenes);
  const sceneId = preferredSceneId && scenes.includes(preferredSceneId)
    ? preferredSceneId
    : (scenes.includes('general') ? 'general' : scenes[0]);
  const allowedPaths = new Set((candidateFolders || [])
    .map(f => (typeof f === 'string' ? f : f?.path || '').trim())
    .filter(Boolean));
  const workDir = preferredWorkDir && allowedPaths.has(preferredWorkDir) ? preferredWorkDir : '';
  return {
    decision: 'create',
    sessionId: null,
    answeredRequestId: null,
    confidence: 0,
    sceneId,
    workDir,
    title: fallbackShortTitle(newQuery, '新对话'),
    reason,
  };
}

export function validateAutoRouteSessionOutput(parsed, {
  candidates = [],
  newQuery = '',
  allowedScenes = SESSION_SCENE_IDS,
  candidateFolders = [],
  preferredSceneId = null,
  preferredWorkDir = null,
  minConfidence,
} = {}) {
  if (!parsed) return null;
  const decision = VALID_DECISIONS.has(parsed.decision) ? parsed.decision : null;
  if (!decision) return null;

  const sessionMap = new Map();
  for (const s of candidates || []) {
    const sid = boundedText(s?.sessionId || '', 160);
    if (!sid) continue;
    const reqIds = new Set(normalizePendingQuestions(s).map(q => q.requestId).filter(Boolean));
    sessionMap.set(sid, reqIds);
  }

  const scenes = resolveAllowedScenes(allowedScenes);
  const sceneSet = new Set(scenes);
  const allowedPaths = new Set((candidateFolders || [])
    .map(f => (typeof f === 'string' ? f : f?.path || '').trim())
    .filter(Boolean));

  const confidence = clampConfidence(parsed.confidence, decision === 'match' ? 0.8 : 0);
  const reason = boundedText(parsed.reason || '', 400);

  const effectiveMinConfidence = Number.isFinite(minConfidence)
    ? minConfidence
    : DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE;

  const buildCreate = (fallbackReason = '') => {
    const rawScene = typeof parsed.sceneId === 'string' ? parsed.sceneId.trim() : '';
    const sceneId = (preferredSceneId && sceneSet.has(preferredSceneId))
      ? preferredSceneId
      : (sceneSet.has(rawScene) ? rawScene : (sceneSet.has('general') ? 'general' : scenes[0]));
    const rawWorkDir = typeof parsed.workDir === 'string' ? parsed.workDir.trim() : '';
    const hasExplicitWorkDir = typeof preferredWorkDir === 'string';
    const workDir = hasExplicitWorkDir
      ? (preferredWorkDir && allowedPaths.has(preferredWorkDir) ? preferredWorkDir : '')
      : (rawWorkDir && allowedPaths.has(rawWorkDir) ? rawWorkDir : '');
    const title = typeof parsed.title === 'string' && parsed.title.trim()
      ? boundedText(parsed.title, 80)
      : fallbackShortTitle(newQuery, '新对话');
    return {
      decision: 'create',
      sessionId: null,
      answeredRequestId: null,
      confidence,
      sceneId,
      workDir,
      title,
      reason: fallbackReason || reason,
    };
  };

  if (decision === 'match') {
    const sessionId = boundedText(parsed.sessionId || '', 160);
    if (!sessionId || !sessionMap.has(sessionId)) {
      return buildCreate(reason || 'invalid_session_id');
    }
    if (confidence < effectiveMinConfidence) {
      return buildCreate(reason || 'low_confidence');
    }
    const rawReqId = boundedText(parsed.answeredRequestId || '', 160);
    const validReqIds = sessionMap.get(sessionId);
    const answeredRequestId = rawReqId && validReqIds.has(rawReqId) ? rawReqId : null;
    return {
      decision: 'match',
      sessionId,
      answeredRequestId,
      confidence,
      sceneId: null,
      workDir: '',
      title: '',
      reason,
    };
  }

  return buildCreate();
}

export const autoRouteSessionScenario = Object.freeze({
  id: AUTO_ROUTE_SESSION_SCENARIO_ID,
  maxTokens: 1024,
  defaultTimeoutMs: 12_000,
  buildSystemPrompt: () => AUTO_ROUTE_SESSION_PROMPT,
  buildUserPrompt: buildAutoRouteSessionUserPrompt,
  validate: validateAutoRouteSessionOutput,
  fallback: fallbackAutoRouteSession,
});
