import { randomUUID } from 'node:crypto';
import { agents } from '../context.js';
import { CONFIG } from '../config.js';
import { sendToAgent } from '../ws-utils.js';
import { resolveHttpUrl } from './rss-parser.js';

const pending = new Map();
const rate = new Map();
const legacySlotWaiters = new Map(); // Map<agentId, Set<() => void>>
const rateWindow = 600_000;
const keyFor = (agentId, requestId) => JSON.stringify([agentId, requestId]);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function requiredCapabilityForMode(mode = 'brief') {
  if (mode === 'follow_up') return 'cosmic_web_follow_up';
  if (mode === 'topic_radar') return 'cosmic_web_radar';
  return 'cosmic_web_briefing';
}

const hasCapability = (agent, cap = 'cosmic_web_briefing') =>
  Array.isArray(agent?.capabilities) && agent.capabilities.includes(cap);
const owns = (agent, userId, userRole) => CONFIG.skipAuth || (agent.ownerId ? agent.ownerId === userId : userRole === 'admin');

function notifyLegacySlotWaiters(agentId) {
  const set = legacySlotWaiters.get(agentId);
  if (!set || !set.size) return;
  const next = set.values().next().value;
  set.delete(next);
  if (!set.size) legacySlotWaiters.delete(agentId);
  next();
}

function waitForLegacySlot(agentId, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason?.status === 499 ? fail(499, 'Cosmic Web request cancelled') : fail(503, 'Cosmic Web is stopping'));
      return;
    }
    let set = legacySlotWaiters.get(agentId);
    if (!set) {
      set = new Set();
      legacySlotWaiters.set(agentId, set);
    }
    const wake = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      set.delete(wake);
      if (!set.size) legacySlotWaiters.delete(agentId);
      reject(signal.reason?.status === 499 ? fail(499, 'Cosmic Web request cancelled') : fail(503, 'Cosmic Web is stopping'));
    };
    set.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function listCapableAgentsForUser(userId, userRole, mode = 'brief') {
  const required = requiredCapabilityForMode(mode);
  return [...agents]
    .filter(([, agent]) => agent.ws?.readyState === 1 && hasCapability(agent, required) && owns(agent, userId, userRole))
    .map(([id, agent]) => ({
      id,
      agentId: id,
      name: agent.name ?? id,
      capabilities: Array.isArray(agent.capabilities) ? [...agent.capabilities] : [],
      supportsBriefing: hasCapability(agent, 'cosmic_web_briefing'),
      supportsResearch: hasCapability(agent, 'cosmic_web_research'),
      supportsFollowUp: hasCapability(agent, 'cosmic_web_follow_up'),
      supportsRadar: hasCapability(agent, 'cosmic_web_radar'),
      supportsCancel: hasCapability(agent, 'cosmic_web_cancel'),
    }));
}

function settle(key, error, value) {
  const entry = pending.get(key);
  if (!entry) return false;
  pending.delete(key);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener('abort', entry.onAbort);
  notifyLegacySlotWaiters(entry.agentId);
  if (entry.abandoned) return true;
  if (error) entry.reject(error); else entry.resolve(value);
  return true;
}

export async function requestCosmicWebAi({ userId, userRole, agentId, mode, perspective, language, payload, signal }) {
  if (signal?.aborted) {
    throw signal.reason?.status === 499 ? fail(499, 'Cosmic Web request cancelled') : fail(503, 'Cosmic Web is stopping');
  }
  const agent = agents.get(agentId);
  if (!userId || !agent || !owns(agent, userId, userRole)) throw fail(403, 'Agent is not available to this user');
  const requiredCap = requiredCapabilityForMode(mode);
  if (!hasCapability(agent, requiredCap)) {
    throw fail(409, requiredCap === 'cosmic_web_briefing'
      ? 'Agent does not support Cosmic Web briefing'
      : 'Selected Agent requires an update to support this Cosmic Web feature');
  }
  if (agent.ws?.readyState !== 1) throw fail(503, 'Agent is offline');

  const supportsCancel = hasCapability(agent, 'cosmic_web_cancel');
  // Live user concurrency cap (non-abandoned requests) stays strictly <= 2.
  const liveForUser = [...pending.values()].filter(entry => entry.userId === userId && !entry.abandoned).length;
  if (liveForUser >= 2) throw fail(429, 'Too many active briefing requests');

  // For legacy v1 Agents that ignore cancel frames, wait cleanly if remote slots are
  // occupied by abandoned requests rather than blasting into full Agent slots (which would 502).
  while (!supportsCancel && [...pending.values()].filter(entry => entry.agent === agent).length >= 2) {
    const hasAbandoned = [...pending.values()].some(entry => entry.agent === agent && entry.abandoned);
    if (!hasAbandoned) throw fail(429, 'Too many active briefing requests');
    await waitForLegacySlot(agentId, signal);
    if (agents.get(agentId) !== agent || agent.ws?.readyState !== 1) throw fail(503, 'Agent is offline');
    if ([...pending.values()].filter(entry => entry.userId === userId && !entry.abandoned).length >= 2) {
      throw fail(429, 'Too many active briefing requests');
    }
  }

  const now = Date.now();
  for (const [id, times] of rate) if (times.at(-1) <= now - rateWindow) rate.delete(id);
  const times = (rate.get(userId) ?? []).filter(t => t > now - rateWindow);
  if (times.length >= 20) throw fail(429, 'Briefing rate limit reached');
  rate.set(userId, [...times, now]);
  const requestId = randomUUID();
  const key = keyFor(agentId, requestId);
  return new Promise((resolve, reject) => {
    const entry = { userId, userRole, agentId, agent, mode, resolve, reject, timer: null, signal, onAbort: null, sent: false, abandoned: false };
    const timer = setTimeout(() => {
      const wasSent = entry.sent;
      if (settle(key, fail(504, 'Agent briefing timed out')) && wasSent && supportsCancel) {
        void sendToAgent(agent, { type: 'cosmic_web_ai_cancel', requestId }).catch(() => {});
      }
    }, 75_000);
    timer.unref();
    const onAbort = () => {
      const err = signal?.reason?.status === 499 ? fail(499, 'Cosmic Web request cancelled') : fail(503, 'Cosmic Web is stopping');
      const isShutdown = err.status === 503;
      if (!supportsCancel && entry.sent && !isShutdown) {
        // Legacy v1 Agent ignores cancel frames: reject caller now, but keep accounting for
        // the occupied remote slot until the legacy Agent replies, times out, or disconnects.
        entry.abandoned = true;
        entry.signal?.removeEventListener('abort', onAbort);
        reject(err);
        return;
      }
      const wasSent = entry.sent;
      if (settle(key, err) && wasSent && supportsCancel) {
        void sendToAgent(agent, { type: 'cosmic_web_ai_cancel', requestId }).catch(() => {});
      }
    };
    entry.timer = timer;
    entry.onAbort = onAbort;
    pending.set(key, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    sendToAgent(agent, { type: 'cosmic_web_ai_request', schemaVersion: 2, requestId, mode, perspective, language, payload }, {
      shouldSend: () => pending.get(key) === entry && !entry.abandoned && agents.get(agentId) === agent && !signal?.aborted,
    })
      .then(sent => {
        if (!sent) settle(key, fail(503, 'Agent disconnected'));
        else entry.sent = true;
      }, () => settle(key, fail(503, 'Agent send failed')));
  });
}

const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, max = 20_000) => typeof value === 'string' && value.trim() && value.length <= max;

const only = (value, keys) => object(value) && Object.keys(value).every(k => keys.includes(k));
const list = (value, min, max, test) => Array.isArray(value) && value.length >= min && value.length <= max && value.every(test);
const bullet = value => text(value, 500);
const question = value => text(value, 320);

// Keep this rule in sync with agent/yeaft/cosmic-web-briefing.js.
function hasUnsafeMarkdown(markdown) {
  if (/[<>]|(?<=[a-z][a-z0-9+.-]*):\/\/|www\.|\bmailto:|[a-z0-9._%+-]@[a-z0-9._-]+\.[a-z0-9_-]*[a-z0-9]/i.test(markdown)) return true;
  // Reject unescaped brackets (including reference/image syntax). Consume
  // escaped backslashes in pairs so they cannot hide an active bracket.
  for (const [token] of markdown.matchAll(/\\[\\\[\]]|[\[\]]/g)) if (token.length === 1) return true;
  return false;
}
const optional = (value, test) => value === undefined || test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const url = value => !!resolveHttpUrl(value);
const media = value => only(value, ['url', 'kind', 'caption', 'sourceName']) && url(value.url) &&
  ['image', 'gif'].includes(value.kind) && optional(value.caption, v => text(v, 500)) && optional(value.sourceName, v => text(v, 150));
const citation = value => only(value, ['title', 'url', 'sourceName']) && url(value.url) &&
  text(value.title, 500) && optional(value.sourceName, v => text(v, 150));
const highlight = value => only(value, ['platform', 'author', 'quote', 'likes', 'sourceUrl']) &&
  text(value.platform, 80) && text(value.author, 150) && text(value.quote, 1000) &&
  optional(value.likes, count) && optional(value.sourceUrl, url);
const radarItem = value => only(value, ['title', 'url', 'sourceName', 'summaryExcerpt', 'publishedAt', 'mediaUrl']) &&
  text(value.title, 500) && url(value.url) && text(value.sourceName, 150) &&
  typeof value.summaryExcerpt === 'string' && value.summaryExcerpt.length <= 1000 &&
  optional(value.publishedAt, v => count(v) || (text(v, 64) && Number.isFinite(Date.parse(v)))) && optional(value.mediaUrl, url);
const answers = result => list(result.media, 0, 6, media) && list(result.citations, 0, 8, citation) &&
  list(result.followUps, 0, 3, question) && typeof result.researched === 'boolean' && count(result.searchCount) &&
  optional(result.evidenceCount, count);

export function validateCosmicWebAiResult(result, mode) {
  if (!object(result)) return false;
  if (mode === 'topic_radar') return !!(only(result, ['items', 'searchCount']) && list(result.items, 0, 20, radarItem) && count(result.searchCount));
  if (mode === 'follow_up') return !!(only(result, ['question', 'answer', 'bullets', 'media', 'citations', 'followUps', 'researched', 'searchCount', 'evidenceCount']) &&
    text(result.question, 500) && text(result.answer, 6000) && !hasUnsafeMarkdown(result.answer) && list(result.bullets, 0, 6, bullet) && answers(result));
  if (!text(result.fullMarkdown, mode === 'daily_briefing' ? 12_000 : 16_000) || hasUnsafeMarkdown(result.fullMarkdown)) return false;
  if (mode === 'daily_briefing') {
    return only(result, ['headline', 'overview', 'sections', 'signalsToWatch', 'followUps', 'fullMarkdown']) &&
      text(result.headline, 250) && text(result.overview, 1500) &&
      list(result.sections, 0, 8, s => only(s, ['domain', 'bullets']) && text(s.domain, 150) && list(s.bullets, 1, 5, bullet)) &&
      list(result.signalsToWatch, 0, 8, bullet) && list(result.followUps, 0, 5, question);
  }
  if (!['brief', 'synthesize'].includes(mode) || !text(result.tldr, 500) || !text(result.impact, 1000)) return false;
  if (only(result, ['tldr', 'bullets', 'impact', 'followUps', 'fullMarkdown'])) {
    return list(result.bullets, 3, 5, bullet) && list(result.followUps, 2, 3, question);
  }
  return only(result, ['tldr', 'sections', 'bullets', 'impact', 'media', 'communityHighlights', 'citations', 'followUps', 'researched', 'searchCount', 'evidenceCount', 'fullMarkdown']) &&
    list(result.sections, 1, 6, section => only(section, ['heading', 'body']) && text(section.heading, 250) && text(section.body, 4000)) &&
    list(result.bullets, 2, 6, bullet) && list(result.communityHighlights, 0, 6, highlight) && answers(result);
}

export function handleCosmicWebAiResponse(agentId, msg) {
  if (!object(msg) || (msg.type != null && msg.type !== 'cosmic_web_ai_response') || !text(msg.requestId, 64)) return false;
  const key = keyFor(agentId, msg.requestId);
  const entry = pending.get(key);
  if (!entry || agents.get(agentId) !== entry.agent || !owns(entry.agent, entry.userId, entry.userRole) || !hasCapability(entry.agent, requiredCapabilityForMode(entry.mode))) return false;
  if (msg.ok === false || msg.error != null) return settle(key, fail(502, 'Agent could not generate a briefing'));
  const result = msg.result ?? msg.response;
  if (msg.ok !== true || !validateCosmicWebAiResult(result, entry.mode)) {
    return settle(key, fail(502, 'Agent returned an invalid briefing'));
  }
  return settle(key, null, result);
}

export function clearCosmicWebAiRequestsForAgent(agentId, targetAgent = null) {
  for (const [key, entry] of pending) {
    if (entry.agentId === agentId && (targetAgent == null || entry.agent === targetAgent)) settle(key, fail(503, 'Agent disconnected'));
  }
  const waiters = legacySlotWaiters.get(agentId);
  if (waiters) {
    legacySlotWaiters.delete(agentId);
    for (const wake of waiters) wake();
  }
}
export function clearAllCosmicWebAiRequests() {
  for (const key of pending.keys()) settle(key, fail(503, 'Cosmic Web is stopping'));
  for (const waiters of legacySlotWaiters.values()) {
    for (const wake of waiters) wake();
  }
  legacySlotWaiters.clear();
  rate.clear();
}
