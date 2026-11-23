const DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS = 180000;
const DEFAULT_AGENT_HEARTBEAT_STALL_GRACE_MS = 5000;

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const AGENT_HEARTBEAT_TIMEOUT_MS = parsePositiveInt(
  process.env.AGENT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS,
);

export const AGENT_HEARTBEAT_STALL_GRACE_MS = parsePositiveInt(
  process.env.AGENT_HEARTBEAT_STALL_GRACE_MS,
  DEFAULT_AGENT_HEARTBEAT_STALL_GRACE_MS,
);

export function markAgentHeartbeatSeen(agent, now = Date.now()) {
  if (!agent) return;
  agent.isAlive = true;
  agent.lastSeenAt = now;
}

export function markAgentHeartbeatPing(agent, now = Date.now()) {
  if (!agent) return;
  agent.pingSentAt = now;
}

export function markAgentHeartbeatStall(agent, driftMs, now = Date.now()) {
  if (!agent) return;
  agent.lastHeartbeatStallAt = now;
  agent.lastHeartbeatStallMs = driftMs;
}

export function shouldTerminateAgentHeartbeat(
  agent,
  now = Date.now(),
  timeoutMs = AGENT_HEARTBEAT_TIMEOUT_MS,
  { timerDriftMs = 0, stallGraceMs = AGENT_HEARTBEAT_STALL_GRACE_MS } = {},
) {
  if (!agent) return false;
  if (Number.isFinite(timerDriftMs) && timerDriftMs > stallGraceMs) return false;
  const lastSeenAt = Number.isFinite(agent.lastSeenAt) ? agent.lastSeenAt : 0;
  return lastSeenAt > 0 && (now - lastSeenAt) > timeoutMs;
}

// Native ping/pong is independent of page JavaScript. Keep the control frame
// interval below common 60s idle limits, and tolerate more than one missed
// reply without keeping dead background sockets forever.
export const WEB_HEARTBEAT_INTERVAL_MS = 30_000;
export const WEB_HEARTBEAT_TIMEOUT_MS = 90_000;
const WEB_HEARTBEAT_STALL_GRACE_MS = 5_000;

export function markWebHeartbeatPong(client) {
  client.webHeartbeatPendingSince = null;
}

export function shouldPingWebClient(client, now, timerDriftMs) {
  if (client.webHeartbeatPendingSince == null || timerDriftMs > WEB_HEARTBEAT_STALL_GRACE_MS) {
    // Pong callbacks may not have had a chance to run after an event-loop stall.
    client.webHeartbeatPendingSince = now;
  }
  return now - client.webHeartbeatPendingSince < WEB_HEARTBEAT_TIMEOUT_MS;
}
