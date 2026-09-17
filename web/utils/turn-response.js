function responseText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

const FAILED_RESPONSE_REASONS = new Set(['aborted', 'errored', 'error', 'cancelled', 'canceled']);

function matchesTurn(row, event) {
  if (!row || row.type !== 'assistant') return false;
  const rowSessionId = row.sessionId ?? row.groupId ?? null;
  const rowVpId = row.speakerVpId || row.vpId || null;
  if (event.sessionId && rowSessionId !== event.sessionId) return false;
  if (event.vpId && rowVpId !== event.vpId) return false;
  if (event.turnId && row.turnId !== event.turnId) return false;
  return true;
}

/**
 * Stamp the semantic text boundary when a VP turn terminates. The last
 * non-empty assistant row of a normal end_turn is the result; earlier rows
 * are progress emitted around tool calls. Other terminal reasons have no
 * successful result block.
 */
export function markTurnResponseKinds(rows, event = {}) {
  if (!Array.isArray(rows) || !event.turnId) return false;
  const ownedRows = rows.filter(row => matchesTurn(row, event));
  if (ownedRows.length === 0) return false;

  for (const row of ownedRows) row.responseKind = 'progress';
  if (event.reason === 'end_turn') {
    for (let index = ownedRows.length - 1; index >= 0; index -= 1) {
      if (responseText(ownedRows[index].content).trim()) {
        ownedRows[index].responseKind = 'result';
        break;
      }
    }
  }
  return true;
}

/** Preserve assistant message boundaries instead of concatenating Markdown. */
export function appendTurnResponseSegment(turn, message) {
  if (!turn || !message) return;
  const content = responseText(message.content);
  if (!content) return;
  if (!Array.isArray(turn.textSegments)) turn.textSegments = [];
  turn.textSegments.push({
    key: message.messageId || message.id || `response-${turn.textSegments.length}`,
    content,
    kind: message.responseKind === 'result' ? 'result' : 'progress',
    explicitKind: message.responseKind === 'progress' || message.responseKind === 'result',
    isStreaming: message.isStreaming === true,
  });
  turn.textContent = turn.textSegments.map(segment => segment.content).join('\n\n');
}

/**
 * Asset uploads can finish after later text, or even after another user turn.
 * Project anchored images immediately after their source tool before grouping
 * turns. Never mutate stored rows; legacy/unavailable anchors keep arrival order.
 */
export function orderResponseImageMessages(messages = []) {
  const anchorKey = (message, toolId) => JSON.stringify([
    message.sessionId || message.groupId || '',
    message.speakerVpId || message.vpId || '',
    message.turnId || '',
    toolId,
  ]);
  const tools = new Map();
  for (const message of messages) {
    if (message.type === 'tool-use' && message.toolId) tools.set(anchorKey(message, message.toolId), message);
  }
  const anchored = new Map();
  const relocated = new Set();
  for (const message of messages) {
    if (message.type !== 'chat-image' || !message.sourceToolCallId) continue;
    const tool = tools.get(anchorKey(message, message.sourceToolCallId));
    if (!tool) continue;
    if (!anchored.has(tool)) anchored.set(tool, []);
    anchored.get(tool).push(message);
    relocated.add(message);
  }
  if (relocated.size === 0) return messages;
  const ordered = [];
  for (const message of messages) {
    if (relocated.has(message)) continue;
    ordered.push(message);
    if (anchored.has(message)) ordered.push(...anchored.get(message));
  }
  return ordered;
}

export function responseImageKey(image) {
  return JSON.stringify([image.assetId || image.id, image.sourceToolCallId || '', image.turnId || '']);
}

/** Interleave compact image groups with the surrounding response text. */
export function buildTurnResponseBlocks(turn, textSegments = []) {
  const images = Array.isArray(turn?.imageMsgs) ? turn.imageMsgs : [];
  const segmentsByKey = new Map(textSegments.map(segment => [segment.key, segment]));
  const imagesByKey = new Map(images.map(image => [responseImageKey(image), image]));
  const seen = new Set();
  const blocks = [];
  const append = (kind, item) => {
    if (!item || seen.has(item)) return;
    seen.add(item);
    const previous = blocks[blocks.length - 1];
    if (kind !== 'result' && previous?.kind === kind) previous.items.push(item);
    else blocks.push({ kind, key: `${kind}:${kind === 'images' ? responseImageKey(item) : item.key || blocks.length}`, items: [item] });
  };
  let textIndex = 0;
  for (const message of orderResponseImageMessages(Array.isArray(turn?.messages) ? turn.messages : [])) {
    if (message.type === 'assistant' && responseText(message.content)) {
      const key = message.messageId || message.id || `response-${textIndex}`;
      const segment = segmentsByKey.get(key);
      if (segment) append(segment.kind === 'result' ? 'result' : 'progress', segment);
      textIndex += 1;
    } else if (message.type === 'chat-image') {
      append('images', imagesByKey.get(responseImageKey(message)));
    }
  }
  // Legacy consumers may supply only textContent/textSegments and imageMsgs.
  for (const segment of textSegments) append(segment.kind === 'result' ? 'result' : 'progress', segment);
  for (const image of images) append('images', image);
  return blocks;
}

/**
 * Old persisted rows have no responseKind. Treat their last text row as the
 * result only after history replay or an explicit end_turn lifecycle stamp.
 */
export function finalizeTurnResponseSegments(turn) {
  const segments = Array.isArray(turn?.textSegments) ? turn.textSegments : [];
  if (segments.length === 0) return;

  const messages = Array.isArray(turn?.messages) ? turn.messages : [];
  const stillRunning = turn?.isActive === true
    || turn?.isStreaming === true
    || segments.some(segment => segment.isStreaming === true)
    || messages.some(message => message?.isStreaming === true || message?.status === 'pending');
  const endedUnsuccessfully = messages.some(message => (
    message?.incomplete === true
    || FAILED_RESPONSE_REASONS.has(message?.status)
    || FAILED_RESPONSE_REASONS.has(message?.turnEndReason)
    || FAILED_RESPONSE_REASONS.has(message?.stopReason)
  ));

  // A persisted responseKind cannot make an in-flight or failed turn successful.
  // Live text chunks stop streaming before tool execution, while the VP turn
  // remains pending. Keep every visible row as progress until a real terminal
  // lifecycle event arrives.
  if (stillRunning || endedUnsuccessfully) {
    for (const segment of segments) segment.kind = 'progress';
    return;
  }

  if (segments.some(segment => segment.kind === 'result')) return;
  const endedNormally = messages.some(message => message?.turnEndReason === 'end_turn');
  const hasExplicitKinds = segments.some(segment => segment.explicitKind);
  const legacySingleSegment = segments.length === 1 && !hasExplicitKinds;
  if (endedNormally || legacySingleSegment || (turn.isHistory && !hasExplicitKinds)) {
    segments[segments.length - 1].kind = 'result';
  }
}
