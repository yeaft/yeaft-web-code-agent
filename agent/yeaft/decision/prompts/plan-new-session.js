import { SESSION_SCENE_IDS } from '../../sessions/scene-ids.js';
import {
  boundedText,
  composeDecisionSystemPrompt,
  fallbackShortTitle,
} from './shared.js';

export const PLAN_NEW_SESSION_SCENARIO_ID = 'plan-new-session';

const SCENE_DESCRIPTIONS = Object.freeze({
  general: 'Everyday questions, research, planning, life/admin tasks, or cross-domain requests',
  software: 'Backend/full-stack software engineering, debugging, architecture, scripts, Git, DevOps, code review',
  frontend: 'Web/UI/CSS/component layout, interaction design, browser rendering, frontend polish',
  writing: 'Drafting, editing, translating, articles, emails, documentation prose, storytelling',
  'short-video': 'Short-video topic selection, scriptwriting, hooks, channel positioning, content ops',
  'video-editing': 'Video/audio cutting, timeline pacing, captions, FFmpeg/editing workflows',
  'primary-education': 'K-6 / primary-school tutoring, homework guidance, child-friendly explanations',
  investment: 'Stocks, funds, financial statements, valuation, quant research, portfolio & risk analysis',
});

export const PLAN_NEW_SESSION_PROMPT = composeDecisionSystemPrompt(`You choose the initial metadata (sceneId, workDir, title) when creating a new Session from a user's first message.

Return JSON only:
{"sceneId":"string","workDir":"string","title":"short title","reason":"brief debug reason"}

Selection rules:
1. sceneId:
   - Must be one of allowedScenes.
   - Pick a specialized scene ("software", "frontend", "writing", "investment", "short-video", "video-editing", "primary-education") when the user's goal clearly belongs to that domain.
   - Otherwise default to "general".
2. workDir (workspace folder):
   - Must be EITHER "" (empty string — no folder bound) OR an EXACT path string copied verbatim from candidateFolders[].path. Never invent, shorten, or modify a path.
   - For non-workspace questions (general chat, writing prose, investment Q&A without local repo work, tutoring, conceptual coding questions not tied to a local project), return "".
   - When the user mentions a project/repo/directory name, file context, or historical clue that clearly matches one entry in candidateFolders, select that folder's exact path.
   - If multiple folders could apply and the user message gives no signal which project they mean, return "" rather than guessing the wrong repository.
3. title:
   - Concise Session title in the user's language: 4-18 Chinese characters or 2-7 English words summarizing the topic.`);

function resolveAllowedScenes(allowedScenes) {
  const list = Array.isArray(allowedScenes) && allowedScenes.length > 0
    ? allowedScenes.filter(id => SESSION_SCENE_IDS.includes(id))
    : [...SESSION_SCENE_IDS];
  return list.length > 0 ? [...new Set(list)] : ['general'];
}

export function buildPlanNewSessionUserPrompt({
  newQuery = '',
  allowedScenes = SESSION_SCENE_IDS,
  candidateFolders = [],
  historicalHints = [],
} = {}) {
  const scenes = resolveAllowedScenes(allowedScenes);
  const payload = {
    allowedScenes: scenes.map(id => ({
      id,
      description: SCENE_DESCRIPTIONS[id] || id,
    })),
    candidateFolders: (candidateFolders || []).slice(0, 30).map(folder => {
      const path = typeof folder === 'string' ? folder : folder?.path || '';
      return {
        path: boundedText(path, 512),
        ...(folder?.name ? { name: boundedText(folder.name, 120) } : {}),
        ...(folder?.label ? { label: boundedText(folder.label, 160) } : {}),
        ...(Array.isArray(folder?.markers) && folder.markers.length
          ? { markers: folder.markers.slice(0, 6).map(m => boundedText(String(m), 40)) }
          : {}),
        ...(folder?.recent === true ? { recent: true } : {}),
      };
    }).filter(item => item.path),
    ...(Array.isArray(historicalHints) && historicalHints.length > 0 ? {
      historicalHints: historicalHints.slice(0, 3).map(hint => ({
        title: boundedText(hint?.title || '', 160),
        workDir: boundedText(hint?.workDir || '', 320),
        snippet: boundedText(hint?.snippet || '', 240),
      })),
    } : {}),
    newQuery: boundedText(newQuery, 2000),
  };
  return JSON.stringify(payload, null, 2);
}

export function fallbackPlanNewSession({
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
    sceneId,
    workDir,
    title: fallbackShortTitle(newQuery, '新对话'),
    reason,
  };
}

export function validatePlanNewSessionOutput(parsed, {
  newQuery = '',
  allowedScenes = SESSION_SCENE_IDS,
  candidateFolders = [],
} = {}) {
  if (!parsed) return null;
  const scenes = resolveAllowedScenes(allowedScenes);
  const sceneSet = new Set(scenes);
  const rawScene = typeof parsed.sceneId === 'string' ? parsed.sceneId.trim() : '';
  const sceneId = sceneSet.has(rawScene)
    ? rawScene
    : (sceneSet.has('general') ? 'general' : scenes[0]);

  const allowedPaths = new Set((candidateFolders || [])
    .map(f => (typeof f === 'string' ? f : f?.path || '').trim())
    .filter(Boolean));
  const rawWorkDir = typeof parsed.workDir === 'string' ? parsed.workDir.trim() : '';
  // Strict allowlist: never accept a path outside candidateFolders.
  const workDir = rawWorkDir && allowedPaths.has(rawWorkDir) ? rawWorkDir : '';

  const title = typeof parsed.title === 'string' && parsed.title.trim()
    ? boundedText(parsed.title, 80)
    : fallbackShortTitle(newQuery, '新对话');
  const reason = boundedText(parsed.reason || '', 400);

  return {
    sceneId,
    workDir,
    title,
    reason: rawWorkDir && !workDir ? (reason || 'rejected_unlisted_workdir') : reason,
  };
}

export const planNewSessionScenario = Object.freeze({
  id: PLAN_NEW_SESSION_SCENARIO_ID,
  maxTokens: 768,
  defaultTimeoutMs: 8_000,
  buildSystemPrompt: () => PLAN_NEW_SESSION_PROMPT,
  buildUserPrompt: buildPlanNewSessionUserPrompt,
  validate: validatePlanNewSessionOutput,
  fallback: fallbackPlanNewSession,
});
