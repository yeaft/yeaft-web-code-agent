import { randomUUID } from 'node:crypto';
import { agents } from '../context.js';
import { CONFIG } from '../config.js';
import { sendToAgent } from '../ws-utils.js';

const pending = new Map();
const rate = new Map();
const rateWindow = 600_000;
const keyFor = (agentId, requestId) => JSON.stringify([agentId, requestId]);
const fail = (status, message) => Object.assign(new Error(message), { status });
const hasCapability = agent => Array.isArray(agent?.capabilities) && agent.capabilities.includes('cosmic_web_briefing');
const owns = (agent, userId, userRole) => CONFIG.skipAuth || (agent.ownerId ? agent.ownerId === userId : userRole === 'admin');

export function listCapableAgentsForUser(userId, userRole) {
  return [...agents].filter(([, agent]) => agent.ws?.readyState === 1 && hasCapability(agent) && owns(agent, userId, userRole))
    .map(([id, agent]) => ({ id, agentId: id, name: agent.name ?? id }));
}

function settle(key, error, value) {
  const entry = pending.get(key);
  if (!entry) return false;
  pending.delete(key);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener('abort', entry.onAbort);
  if (error) entry.reject(error); else entry.resolve(value);
  return true;
}

export async function requestCosmicWebAi({ userId, userRole, agentId, mode, perspective, language, payload, signal }) {
  if (signal?.aborted) throw fail(503, 'Cosmic Web is stopping');
  const agent = agents.get(agentId);
  if (!userId || !agent || !owns(agent, userId, userRole)) throw fail(403, 'Agent is not available to this user');
  if (!hasCapability(agent)) throw fail(409, 'Agent does not support Cosmic Web briefing');
  if (agent.ws?.readyState !== 1) throw fail(503, 'Agent is offline');
  if ([...pending.values()].filter(entry => entry.userId === userId).length >= 2) throw fail(429, 'Too many active briefing requests');
  const now = Date.now();
  for (const [id, times] of rate) if (times.at(-1) <= now - rateWindow) rate.delete(id);
  const times = (rate.get(userId) ?? []).filter(t => t > now - rateWindow);
  if (times.length >= 20) throw fail(429, 'Briefing rate limit reached');
  rate.set(userId, [...times, now]);
  const requestId = randomUUID();
  const key = keyFor(agentId, requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(key, fail(504, 'Agent briefing timed out')), 45_000);
    timer.unref();
    const onAbort = () => settle(key, fail(503, 'Cosmic Web is stopping'));
    const entry = { userId, userRole, agentId, agent, mode, resolve, reject, timer, signal, onAbort };
    pending.set(key, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    sendToAgent(agent, { type: 'cosmic_web_ai_request', requestId, mode, perspective, language, payload }, {
      shouldSend: () => pending.get(key) === entry && agents.get(agentId) === agent && !signal?.aborted,
    })
      .then(sent => { if (!sent) settle(key, fail(503, 'Agent disconnected')); }, () => settle(key, fail(503, 'Agent send failed')));
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
function validResult(result, mode) {
  if (!object(result) || !text(result.fullMarkdown, 12_000) || hasUnsafeMarkdown(result.fullMarkdown)) return false;
  if (mode === 'daily_briefing') {
    return only(result, ['headline', 'overview', 'sections', 'signalsToWatch', 'followUps', 'fullMarkdown']) &&
      text(result.headline, 250) && text(result.overview, 1500) &&
      list(result.sections, 0, 8, s => only(s, ['domain', 'bullets']) && text(s.domain, 150) && list(s.bullets, 1, 5, bullet)) &&
      list(result.signalsToWatch, 0, 8, bullet) && list(result.followUps, 0, 5, question);
  }
  return only(result, ['tldr', 'bullets', 'impact', 'followUps', 'fullMarkdown']) &&
    text(result.tldr, 500) && text(result.impact, 1000) && list(result.bullets, 3, 5, bullet) && list(result.followUps, 2, 3, question);
}

export function handleCosmicWebAiResponse(agentId, msg) {
  if (!object(msg) || (msg.type != null && msg.type !== 'cosmic_web_ai_response') || !text(msg.requestId, 64)) return false;
  const key = keyFor(agentId, msg.requestId);
  const entry = pending.get(key);
  if (!entry || agents.get(agentId) !== entry.agent || !owns(entry.agent, entry.userId, entry.userRole) || !hasCapability(entry.agent)) return false;
  if (msg.ok === false || msg.error != null) return settle(key, fail(502, 'Agent could not generate a briefing'));
  const result = msg.result ?? msg.response;
  if (msg.ok !== true || !validResult(result, entry.mode)) {
    return settle(key, fail(502, 'Agent returned an invalid briefing'));
  }
  return settle(key, null, result);
}

export function clearCosmicWebAiRequestsForAgent(agentId, targetAgent = null) {
  for (const [key, entry] of pending) {
    if (entry.agentId === agentId && (targetAgent == null || entry.agent === targetAgent)) settle(key, fail(503, 'Agent disconnected'));
  }
}
export function clearAllCosmicWebAiRequests() {
  for (const key of pending.keys()) settle(key, fail(503, 'Cosmic Web is stopping'));
  rate.clear();
}
