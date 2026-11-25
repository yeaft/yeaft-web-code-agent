import { basename } from 'node:path';
import { SESSION_SCENE_IDS } from '../../sessions/scene-ids.js';
import { compactMessageExcerpt, isShortContinuationQuery } from '../../session-discovery/route-scorer.js';
import {
  boundedText,
  clampConfidence,
  composeDecisionSystemPrompt,
  fallbackShortTitle,
} from './shared.js';

const VALID_DECISIONS = new Set(['match', 'create']);
export const AUTO_ROUTE_SESSION_SCENARIO_ID = 'auto-route-session';
export const DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE = 0.7;
export const DEFAULT_AUTO_ROUTE_SHORT_CONT_MIN_CONFIDENCE = 0.5;

export const AUTO_ROUTE_SESSION_PROMPT = composeDecisionSystemPrompt(`Route a Sessionless user message: continue ONE candidate Session or create a new Session.

Return JSON only (keep "reason" <= 15 words):
- Match: {"decision":"match","sessionId":"exact_id","answeredRequestId":null,"confidence":0.9,"reason":"..."}
- Create: {"decision":"create","sessionId":null,"answeredRequestId":null,"confidence":0.9,"sceneId":"general","workDir":"","title":"short title","reason":"..."}

Rules:
1. Compare ALL candidates (running + idle) together by reading their actual recent messages, project/workDir, and relative age ("1m ago" vs "2d ago").
2. Immediate confirmation priority: if one session's latest assistant message just offered an action or asked for confirmation minutes ago (e.g. "等你确认后我更新..." -> "帮我升级最新proxy", "要不要动手改？" -> "去做吧"), match THAT immediate session over older sessions.
3. Running sessions do NOT automatically win: only match a running session if the message answers its pendingQuestion, supplements it, or clearly continues its task. If an idle session clearly owns the topic or recurring command, pick that idle session.
4. Pending AskUser: set answeredRequestId ONLY when the message directly answers that specific pendingQuestion; otherwise null.
5. META-DIAGNOSTIC TRAP: If the user asks to inspect/debug WHY another Session X failed, hung, stalled, or had no output ("看看 X 这个 session 为什么挂了/没回复"), NEVER route INTO Session X; route to the engineering/debugging session (or create one).
6. Match vs Create:
   - "match": continues an ongoing thread, is a short/deictic follow-up ("继续","好了吗","下一步做什么","全帮我修复吧","下面这个被挡住了") matching the session left waiting or discussing that object, repeats a recurring command, OR is another bugfix/feature/config question on the SAME specific codebase/product actively worked on by a candidate session.
   - "create": user explicitly requests a new topic/session, OR query is an unrelated domain/standalone task (finance/stocks, writing an article, travel, cooking, tutoring, standalone script/Q&A not tied to an active project), OR target project is absent from candidates.
7. When "create":
   - sceneId MUST be in allowedScenes: general (everyday/travel/networking/lifestyle/cross-domain), software (backend/CLI/DevOps/scripts/DB), frontend (UI/CSS/layout/animation), writing (articles/editing/copy/changelog/emails), short-video (short-video scripts/hooks), video-editing (FFmpeg/cutting/captions), primary-education (K-6 tutoring), investment (stocks/funds/valuation/macro).
   - workDir: "" (for non-repo/standalone/general questions) OR an EXACT path copied verbatim from candidateFolders[].path when clearly tied to that repo.
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

export function buildAutoRouteSessionUserPrompt({
  candidates = [],
  allowedScenes = SESSION_SCENE_IDS,
  candidateFolders = [],
  newQuery = '',
} = {}) {
  const scenes = resolveAllowedScenes(allowedScenes);
  const payload = {
    candidates: (candidates || []).slice(0, 10).map(item => {
      const pendingQuestions = normalizePendingQuestions(item);
      const msgs = Array.isArray(item?.recentMessages)
        ? item.recentMessages
        : (Array.isArray(item?.windowMessages) ? item.windowMessages : []);
      const recent = msgs.slice(-3).map(m => ({
        r: m?.role === 'user' ? 'u' : 'a',
        t: compactMessageExcerpt(m?.text ?? m?.content ?? '', 220),
      })).filter(m => m.t);
      const project = item?.workDir ? basename(item.workDir) : '';
      return {
        id: boundedText(item?.sessionId || '', 160),
        title: boundedText(item?.title || '', 80),
        state: boundedText(item?.state || (pendingQuestions.length ? 'waiting_input' : (item?.isRunning ? 'running' : 'idle')), 32),
        ...(item?.ageText ? { age: boundedText(item.ageText, 24) } : {}),
        ...(project ? { project: boundedText(project, 80) } : {}),
        ...(item?.sceneId ? { scene: boundedText(item.sceneId, 40) } : {}),
        ...(pendingQuestions.length ? { pendingQuestions } : {}),
        ...(item?.matchedOlderSnippet ? { olderMatch: compactMessageExcerpt(item.matchedOlderSnippet, 140) } : {}),
        recent,
      };
    }).filter(c => c.id),
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
    : (isShortContinuationQuery(newQuery)
      ? DEFAULT_AUTO_ROUTE_SHORT_CONT_MIN_CONFIDENCE
      : DEFAULT_AUTO_ROUTE_MATCH_MIN_CONFIDENCE);

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
  defaultTimeoutMs: 10_000,
  buildSystemPrompt: () => AUTO_ROUTE_SESSION_PROMPT,
  buildUserPrompt: buildAutoRouteSessionUserPrompt,
  validate: validateAutoRouteSessionOutput,
  fallback: fallbackAutoRouteSession,
});
