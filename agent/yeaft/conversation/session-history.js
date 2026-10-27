/**
 * Session 历史复制/合并的纯变换。持久 ID 只在所属 stream 内有意义；
 * origin 跨 fork/merge 保留，绝不把相同提问文本当作共同历史。
 */
import { isVisibleConversationRow } from './internal-control.js';

/** Create a history-boundary error with a stable machine-readable code. */
export function historyError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Whether a durable row is a human request rather than protocol/control input. */
export function isHumanRequest(row) {
  return row?.role === 'user' && isVisibleConversationRow(row);
}

/** Preserve fork lineage, or establish an origin in the source stream's lifetime. */
export function messageOrigin(row, sessionId, streamId) {
  const origin = row?.origin;
  if (origin && typeof origin.streamId === 'string' && origin.streamId
      && typeof origin.messageId === 'string' && origin.messageId) return { ...origin };
  return { sessionId, streamId, messageId: row.id, ...(row.turnId ? { turnId: row.turnId } : {}) };
}

function originKey(origin) {
  return JSON.stringify([origin.streamId, origin.messageId]);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sentAt(row) {
  return row.time ?? row.timestamp ?? row.ts ?? '';
}

function toolScope(row, callId) {
  return JSON.stringify([row.turnId || '', row.speakerVpId || row.vpId || '', row.threadId || 'main', callId]);
}

function ambiguous(message) {
  throw historyError('ambiguous_merge_history', message);
}

// 原始 transcript 不被 sanitize（sanitize 会丢数据）。返回每个结果对应的
// assistant 调用位置，允许不同 VP/turn 重用同一个 provider tool-call ID。
function toolLinks(rows) {
  const calls = new Map();
  const results = new Map();
  const paired = new Set();
  for (const [index, row] of rows.entries()) {
    for (const [callIndex, call] of (row.toolCalls || []).entries()) {
      const key = toolScope(row, call.id);
      if (!call.id || calls.has(key)) ambiguous('Duplicate tool call identity within a request');
      calls.set(key, { index, callIndex });
    }
    if (row.role !== 'tool') continue;
    const key = toolScope(row, row.toolCallId);
    let call = calls.get(key);
    // Some legacy tool rows lack speaker/turn metadata. Only accept an
    // unambiguous preceding call, never a globally colliding bare tool id.
    if (!call) {
      const candidates = [...calls.values()].filter(candidate => {
        const owner = rows[candidate.index];
        return owner.toolCalls[candidate.callIndex].id === row.toolCallId
          && (!row.turnId || owner.turnId === row.turnId)
          && (!(row.speakerVpId || row.vpId) || (owner.speakerVpId || owner.vpId) === (row.speakerVpId || row.vpId))
          && (!row.threadId || (owner.threadId || 'main') === row.threadId);
      });
      if (candidates.length === 1) [call] = candidates;
    }
    if (!call || paired.has(call)) ambiguous('Unpaired or ambiguous tool result within a request');
    results.set(index, call);
    paired.add(call);
  }
  if ([...calls.values()].some(call => !paired.has(call))) ambiguous('Incomplete tool history within a request');
  return { calls, results };
}

function requestTurns(input) {
  const { rows, sessionId, streamId } = input;
  if (new Set(rows.map(row => row.id)).size !== rows.length) ambiguous('Duplicate persisted identity within one Session');
  const turns = [];
  const byRow = new Map();
  const byClient = new Map();
  for (const [index, row] of rows.entries()) {
    if (!isHumanRequest(row)) continue;
    const candidates = row.clientMessageId ? (byClient.get(row.clientMessageId) || []) : [];
    // Historical multi-VP prompt variants share a client identity and source
    // stream. Distinct origins in a merged Session must remain distinct even
    // if two clients happened to reuse the same clientMessageId.
    const sameStream = candidate => !candidate.user.origin || !row.origin
      || candidate.user.origin.streamId === row.origin.streamId;
    if (candidates.some(candidate => sameStream(candidate) && sentAt(candidate.user) !== sentAt(row))) {
      ambiguous('Reused clientMessageId within one Session');
    }
    let turn = candidates.find(candidate => sameStream(candidate) && sentAt(candidate.user) === sentAt(row));
    if (!turn) {
      turn = { user: row, rows: [], origins: new Set(), explicitOrigins: false, index, input };
      turns.push(turn);
      if (row.clientMessageId) byClient.set(row.clientMessageId, [...candidates, turn]);
    }
    byRow.set(row.id, turn);
    turn.origins.add(originKey(messageOrigin(row, sessionId, streamId)));
    turn.explicitOrigins ||= !!row.origin;
  }
  if (!turns.length) {
    if (rows.length) ambiguous('History without a durable human request cannot be merged');
    return [];
  }
  const records = new Map(rows.map(row => [row.id, row]));
  function causalTurn(row, seen = new Set()) {
    if (!row?.causalRootId || seen.has(row.id)) return null;
    seen.add(row.id);
    const direct = byRow.get(row.causalRootId);
    if (direct) return direct;
    const candidates = byClient.get(row.causalRootId) || [];
    if (candidates.length > 1) ambiguous('Ambiguous client causal reference');
    return candidates[0] || causalTurn(records.get(row.causalRootId), seen);
  }
  const byVpTurn = new Map();
  const vpTurnKey = row => row.turnId ? JSON.stringify([row.speakerVpId || row.vpId || '', row.turnId]) : null;
  // Learn explicit causal ownership before assigning interleaved legacy tails.
  for (const row of rows) {
    const turn = causalTurn(row);
    const key = vpTurnKey(row);
    if (!turn || !key) continue;
    if (byVpTurn.has(key) && byVpTurn.get(key) !== turn) ambiguous('A VP turn belongs to multiple human requests');
    byVpTurn.set(key, turn);
  }
  let current = null;
  for (const row of rows) {
    if (isHumanRequest(row)) current = byRow.get(row.id);
    const key = vpTurnKey(row);
    const turn = byRow.get(row.id) || causalTurn(row) || byVpTurn.get(key) || current;
    if (!turn) {
      if (isVisibleConversationRow(row) && row.role !== 'system') ambiguous('History begins inside a human request');
      turns[0].rows.push(row);
      byRow.set(row.id, turns[0]);
      continue;
    }
    if (key) {
      if (byVpTurn.has(key) && byVpTurn.get(key) !== turn) ambiguous('Ambiguous interleaved VP history');
      byVpTurn.set(key, turn);
    }
    turn.rows.push(row);
    byRow.set(row.id, turn);
  }
  for (const turn of turns) {
    turn.links = toolLinks(turn.rows);
    turn.vpTurns = new Set(turn.rows.filter(row => row.role === 'assistant' && row.turnId)
      .map(row => JSON.stringify([row.speakerVpId || row.vpId || '', row.origin?.turnId || row.turnId])));
    // Legacy forks preserved these identities, even though persisted row IDs
    // were remapped. Require sent-time evidence too; no text-only matching.
    turn.legacyKey = turn.user.clientMessageId && sentAt(turn.user)
      ? stableJson(['client', turn.user.clientMessageId, sentAt(turn.user)])
      : (turn.vpTurns.size && sentAt(turn.user)
        ? stableJson(['turns', [...turn.vpTurns].sort(), sentAt(turn.user)]) : null);
  }
  return turns;
}

function commonRequest(left, right) {
  if ([...left.origins].some(key => right.origins.has(key))) return true;
  if (left.user.clientMessageId && right.user.clientMessageId
      && left.user.clientMessageId !== right.user.clientMessageId) return false;
  // Explicit, different origins prove these are distinct user requests.
  if (left.explicitOrigins && right.explicitOrigins) return false;
  if (left.legacyKey && left.legacyKey === right.legacyKey) return true;
  // A fork made at an assistant boundary may contain only one VP's answer.
  // Recognize overlap, then reject unequal request bodies below instead of
  // treating that partial shared request as two independent user requests.
  return !!sentAt(left.user) && sentAt(left.user) === sentAt(right.user)
    && [...left.vpTurns].some(key => right.vpTurns.has(key));
}

function equivalentRows(left, right, aliases) {
  if (left.rows.length !== right.rows.length) return false;
  function normalized(turn) {
    const rowRefs = new Map();
    for (const candidate of turn.input.turns) {
      const canonical = aliases.get(candidate) || candidate;
      const requestKey = originKey(messageOrigin(canonical.user, canonical.input.sessionId, canonical.input.streamId));
      candidate.rows.forEach((row, index) => rowRefs.set(row.id, `${requestKey}:${index}`));
    }
    const clientRefs = new Map();
    for (const candidate of turn.input.turns) {
      if (!candidate.user.clientMessageId) continue;
      const clientId = candidate.user.clientMessageId;
      const canonical = rowRefs.get(candidate.user.id);
      clientRefs.set(clientId, clientRefs.has(clientId) && clientRefs.get(clientId) !== canonical ? null : canonical);
    }
    const remap = value => rowRefs.get(value) || value;
    const callRefs = new Map([...turn.links.calls].map(([key, call]) => [key, `call:${call.index}:${call.callIndex}`]));
    return turn.rows.map((row, index) => {
      const copy = { ...row };
      for (const key of ['id', 'seq', 'sessionId', 'origin', 'cold']) delete copy[key];
      if (row.turnId) copy.turnId = row.origin?.turnId || row.turnId;
      if (row.causalRootId) copy.causalRootId = rowRefs.get(row.causalRootId) || clientRefs.get(row.causalRootId) || row.causalRootId;
      for (const key of ['foldedMessageIds', 'sourceMessageIds']) {
        if (Array.isArray(row[key])) copy[key] = row[key].map(remap);
      }
      if (row.quote?.messageId) copy.quote = { ...row.quote, messageId: remap(row.quote.messageId) };
      if (Array.isArray(row.attachments)) copy.attachments = row.attachments.map(att => {
        const { path, ...metadata } = att;
        return metadata;
      });
      if (row.toolCalls) copy.toolCalls = row.toolCalls.map(call => ({ ...call, id: callRefs.get(toolScope(row, call.id)) }));
      const call = turn.links.results.get(index);
      if (call) copy.toolCallId = `call:${call.index}:${call.callIndex}`;
      if (copy.presentationCallId && callRefs.has(toolScope(row, copy.presentationCallId))) {
        copy.presentationCallId = callRefs.get(toolScope(row, copy.presentationCallId));
      }
      return copy;
    });
  }
  return stableJson(normalized(left)) === stableJson(normalized(right));
}

/**
 * 规划两份 idle Session transcript 的完整请求合并；不写磁盘。
 * @param {Array<{sessionId:string, streamId:string, rows:object[]}>} inputs
 * @returns {{turns:object[], aliases:Map<object,object>, sharedTurnCount:number}}
 */
export function planSessionMerge(inputs) {
  for (const input of inputs) input.turns = requestTurns(input);
  const [left, right] = inputs.map(input => input.turns);
  const aliases = new Map();
  for (const other of right) {
    const matches = left.filter(turn => commonRequest(turn, other));
    if (matches.length > 1) ambiguous('Shared request identity is not unique');
    if (matches.length) {
      if ([...aliases.values()].includes(matches[0])) ambiguous('Shared request occurs more than once');
      aliases.set(other, matches[0]);
    }
  }
  for (const [other, source] of aliases) {
    if (!equivalentRows(source, other, aliases)) ambiguous('Shared human request has divergent or partial branch history');
  }
  const common = left.filter(turn => [...aliases.values()].includes(turn));
  const tails = [...left.filter(turn => !common.includes(turn)), ...right.filter(turn => !aliases.has(turn))];
  const timestamp = turn => {
    const value = sentAt(turn.user);
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  // Stable tie break: source argument order, then original request order.
  tails.sort((a, b) => timestamp(a) - timestamp(b)
    || inputs.indexOf(a.input) - inputs.indexOf(b.input) || a.index - b.index);
  return { turns: [...common, ...tails], aliases, sharedTurnCount: aliases.size };
}

/**
 * 为计划分配新 persisted IDs 并重写内部引用；每个源有独立命名空间。
 * 附件由调用者按实际源所有权复制；provider opaque state 不被解释。
 * @param {object} plan planSessionMerge 的返回值
 * @param {string} targetSessionId 新 Session
 * @param {number} firstSeq 已保留的起始序号
 * @returns {{rows:object[], idMaps:Map<string,Map<string,string>>}}
 */
export function materializeSessionMerge(plan, targetSessionId, firstSeq) {
  const idMaps = new Map();
  const mapping = input => {
    if (!idMaps.has(input.sessionId)) idMaps.set(input.sessionId, new Map());
    return idMaps.get(input.sessionId);
  };
  let seq = firstSeq;
  for (const turn of plan.turns) {
    for (const row of turn.rows) mapping(turn.input).set(row.id, `m${String(seq++).padStart(4, '0')}`);
  }
  for (const [other, source] of plan.aliases) {
    other.rows.forEach((row, index) => mapping(other.input).set(row.id, mapping(source.input).get(source.rows[index].id)));
  }
  const clientMaps = new Map();
  for (const input of new Set([...plan.turns, ...plan.aliases.keys()].map(turn => turn.input))) {
    const clients = new Map();
    for (const turn of input.turns) {
      if (!turn.user.clientMessageId) continue;
      const clientId = turn.user.clientMessageId;
      const targetId = mapping(input).get(turn.user.id);
      clients.set(clientId, clients.has(clientId) && clients.get(clientId) !== targetId ? null : targetId);
    }
    clientMaps.set(input, clients);
  }
  const rows = [];
  for (const turn of plan.turns) {
    const ids = mapping(turn.input);
    const vpTurns = new Map();
    const remap = id => ids.get(id) || id;
    const callId = call => `merge_${ids.get(turn.rows[call.index].id)}_${call.callIndex}`;
    const calls = new Map([...turn.links.calls].map(([key, call]) => [key, callId(call)]));
    for (const [index, row] of turn.rows.entries()) {
      const copy = { ...row, id: ids.get(row.id), sessionId: targetSessionId,
        origin: messageOrigin(row, turn.input.sessionId, turn.input.streamId) };
      delete copy.seq;
      if (row.turnId) {
        const key = JSON.stringify([row.speakerVpId || row.vpId || '', row.turnId]);
        if (!vpTurns.has(key)) vpTurns.set(key, `merge_${copy.id}_turn`);
        copy.turnId = vpTurns.get(key);
      }
      if (row.causalRootId) copy.causalRootId = ids.get(row.causalRootId)
        || clientMaps.get(turn.input)?.get(row.causalRootId) || row.causalRootId;
      for (const key of ['foldedMessageIds', 'sourceMessageIds']) {
        if (Array.isArray(row[key])) copy[key] = row[key].map(remap);
      }
      if (row.quote?.messageId) copy.quote = { ...row.quote, messageId: remap(row.quote.messageId) };
      if (row.toolCalls) copy.toolCalls = row.toolCalls.map(call => ({ ...call, id: calls.get(toolScope(row, call.id)) }));
      if (turn.links.results.has(index)) copy.toolCallId = callId(turn.links.results.get(index));
      if (calls.has(toolScope(row, row.presentationCallId))) copy.presentationCallId = calls.get(toolScope(row, row.presentationCallId));
      rows.push(copy);
    }
  }
  return { rows, idMaps };
}
