const DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS = 180000;
const DEFAULT_AGENT_HEARTBEAT_STALL_GRACE_MS = 5000;

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const AGENT_HEARTBEAT_TIMEOUT_MS = parsePositiveInt(
  process.env.YEAFT_AGENT_HEARTBEAT_TIMEOUT_MS || process.env.AGENT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS,
);

export const AGENT_HEARTBEAT_STALL_GRACE_MS = parsePositiveInt(
  process.env.YEAFT_AGENT_HEARTBEAT_STALL_GRACE_MS || process.env.AGENT_HEARTBEAT_STALL_GRACE_MS,
  DEFAULT_AGENT_HEARTBEAT_STALL_GRACE_MS,
);

export function shouldReconnectForHeartbeat(
  lastPongAt,
  now = Date.now(),
  timeoutMs = AGENT_HEARTBEAT_TIMEOUT_MS,
  { timerDriftMs = 0, stallGraceMs = AGENT_HEARTBEAT_STALL_GRACE_MS } = {},
) {
  if (Number.isFinite(timerDriftMs) && timerDriftMs > stallGraceMs) return false;
  return Number.isFinite(lastPongAt) && lastPongAt > 0 && (now - lastPongAt) > timeoutMs;
}
