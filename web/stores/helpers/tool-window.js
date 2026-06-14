const DEFAULT_LIVE_TOOL_WINDOW = 100;

const SPECIAL_TOOL_NAMES = new Set(['TodoWrite', 'AskUserQuestion']);

export function isToolUseMessage(msg) {
  return msg?.type === 'tool-use';
}

export function isToolSummaryMessage(msg) {
  return msg?.type === 'tool-summary';
}

export function isSummarizableToolMessage(msg) {
  return isToolUseMessage(msg) && !SPECIAL_TOOL_NAMES.has(msg.toolName);
}

function summaryMessage(count, source, sample, cursorSample = sample) {
  const cursorId = source === 'history' ? (cursorSample?.dbMessageId || cursorSample?.id || null) : null;
  return {
    ...(cursorId ? { id: `tool_summary_${source}_${cursorId}`, dbMessageId: cursorSample?.dbMessageId || null } : {}),
    type: 'tool-summary',
    count,
    omittedCount: count,
    source,
    isHistory: source !== 'live',
    timestamp: sample?.timestamp || sample?.startTime || cursorSample?.timestamp || cursorSample?.startTime || null,
    sessionId: sample?.sessionId ?? sample?.groupId ?? null,
    turnId: sample?.turnId || null,
    vpId: sample?.vpId || null,
    speakerVpId: sample?.speakerVpId || null,
  };
}

function canMergeSummary(prev, next) {
  if (!isToolSummaryMessage(prev) || !isToolSummaryMessage(next)) return false;
  return (prev.turnId || null) === (next.turnId || null)
    && (prev.sessionId || null) === (next.sessionId || null)
    && (prev.speakerVpId || prev.vpId || null) === (next.speakerVpId || next.vpId || null)
    && (prev.source || null) === (next.source || null);
}

function mergeSummary(target, next) {
  const count = (Number(target.count) || 0) + (Number(next.count) || 0);
  target.count = count;
  target.omittedCount = count;
  if (!target.timestamp && next.timestamp) target.timestamp = next.timestamp;
  if (Number(next.dbMessageId || 0) > Number(target.dbMessageId || 0)) {
    target.dbMessageId = next.dbMessageId;
    if (next.id) target.id = next.id;
  }
  return target;
}

function turnKey(msg) {
  return [
    msg?.sessionId || '',
    msg?.turnId || '',
    msg?.speakerVpId || msg?.vpId || '',
  ].join('\u001f');
}

function sameTurn(a, b) {
  return turnKey(a) === turnKey(b);
}

function flushSummary(out, count, source, sample, cursorSample = sample) {
  if (!count) return;
  const next = summaryMessage(count, source, sample, cursorSample);
  const prev = out[out.length - 1];
  if (canMergeSummary(prev, next)) mergeSummary(prev, next);
  else out.push(next);
}

export function summarizeHistoricalToolMessages(messages = []) {
  const out = [];
  let count = 0;
  let sample = null;
  let cursorSample = null;

  for (const msg of messages) {
    if (isSummarizableToolMessage(msg) && msg.isHistory) {
      count += 1;
      if (!sample) sample = msg;
      cursorSample = msg;
      continue;
    }
    flushSummary(out, count, 'history', sample, cursorSample);
    count = 0;
    sample = null;
    cursorSample = null;
    out.push(msg);
  }
  flushSummary(out, count, 'history', sample, cursorSample);
  return out;
}

export function applyLiveToolWindow(messages = [], opts = {}) {
  const maxDetailed = Number.isFinite(opts.maxDetailed) ? Math.max(1, opts.maxDetailed) : DEFAULT_LIVE_TOOL_WINDOW;
  if (!Array.isArray(messages) || messages.length <= maxDetailed) return messages;

  let segmentStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.type === 'user' || msg?.type === 'system' || msg?.type === 'error') break;
    segmentStart = i;
  }

  const segment = messages.slice(segmentStart);
  const detailedCounts = new Map();
  for (const msg of segment) {
    if (!isSummarizableToolMessage(msg) || msg.isHistory) continue;
    const key = turnKey(msg);
    detailedCounts.set(key, (detailedCounts.get(key) || 0) + 1);
  }

  const removeLeft = new Map();
  for (const [key, count] of detailedCounts) {
    if (count > maxDetailed) removeLeft.set(key, count - maxDetailed);
  }
  if (removeLeft.size === 0) return messages;

  const summaryCounts = new Map();
  const samples = new Map();
  const inserted = new Set();
  const nextSegment = [];

  const addOmitted = (key, count, sample) => {
    summaryCounts.set(key, (summaryCounts.get(key) || 0) + count);
    if (!samples.has(key) && sample) samples.set(key, sample);
  };

  const maybeInsertSummary = (key, beforeMsg) => {
    if (inserted.has(key)) return;
    const omitted = summaryCounts.get(key) || 0;
    if (omitted <= 0) return;
    nextSegment.push(summaryMessage(omitted, 'live', samples.get(key) || beforeMsg));
    inserted.add(key);
  };

  for (const msg of segment) {
    const key = turnKey(msg);
    if (isToolSummaryMessage(msg) && msg.source === 'live' && removeLeft.has(key)) {
      addOmitted(key, Number(msg.count) || 0, msg);
      continue;
    }
    if (isSummarizableToolMessage(msg) && !msg.isHistory && removeLeft.has(key)) {
      const remaining = removeLeft.get(key) || 0;
      if (remaining > 0) {
        removeLeft.set(key, remaining - 1);
        addOmitted(key, 1, msg);
        continue;
      }
    }
    maybeInsertSummary(key, msg);
    nextSegment.push(msg);
  }

  for (const key of summaryCounts.keys()) {
    maybeInsertSummary(key, samples.get(key));
  }

  messages.splice(segmentStart, messages.length - segmentStart, ...nextSegment);
  return messages;
}

export { DEFAULT_LIVE_TOOL_WINDOW };
