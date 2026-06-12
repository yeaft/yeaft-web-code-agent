const DEFAULT_VISIBLE_TURNS = 5;
const LOAD_STEP_TURNS = 5;

function isNonEmptyUserMessage(msg) {
  return msg?.type === 'user' && typeof msg.content === 'string' && msg.content.trim();
}

function isAssistantMessage(msg) {
  return msg?.type === 'assistant' || msg?.type === 'thinking' || msg?.type === 'tool_use' || msg?.type === 'tool_result';
}

function shouldSplitAssistantTurn(current, msg) {
  if (!current || current.kind !== 'assistant') return true;
  const currentTurnId = current.turnId || current.lastTurnId || '';
  const nextTurnId = msg?.turnId || '';
  if (currentTurnId && nextTurnId && currentTurnId !== nextTurnId) return true;

  const currentSpeaker = current.speakerVpId || '';
  const nextSpeaker = msg?.speakerVpId || msg?.vpId || '';
  if (currentSpeaker && nextSpeaker && currentSpeaker !== nextSpeaker) return true;

  return false;
}

export function buildYeaftMessageTurnSpans(messages = []) {
  const spans = [];
  let current = null;

  const finish = (end) => {
    if (!current) return;
    spans.push({ start: current.start, end, kind: current.kind });
    current = null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (isNonEmptyUserMessage(msg) || msg.type === 'system' || msg.type === 'error') {
      finish(i);
      current = { start: i, kind: msg.type };
      continue;
    }

    if (!isAssistantMessage(msg)) {
      if (!current) current = { start: i, kind: 'other' };
      continue;
    }

    if (!current || (current.kind === 'assistant' && shouldSplitAssistantTurn(current, msg))) {
      finish(i);
      current = {
        start: i,
        kind: 'assistant',
        turnId: msg.turnId || '',
        speakerVpId: msg.speakerVpId || msg.vpId || '',
      };
    }
    current.lastTurnId = msg.turnId || current.lastTurnId || '';
    current.speakerVpId = current.speakerVpId || msg.speakerVpId || msg.vpId || '';
  }

  finish(messages.length);
  return spans;
}

export function sliceYeaftMessagesByRecentTurns(messages = [], visibleTurns = DEFAULT_VISIBLE_TURNS) {
  const safeTurns = Math.max(1, Number.isFinite(visibleTurns) ? Math.floor(visibleTurns) : DEFAULT_VISIBLE_TURNS);
  const spans = buildYeaftMessageTurnSpans(messages);
  if (spans.length <= safeTurns) return messages;
  const firstVisible = spans[spans.length - safeTurns];
  return messages.slice(firstVisible.start);
}

export function countYeaftMessageTurns(messages = []) {
  return buildYeaftMessageTurnSpans(messages).length;
}

export function hasHiddenYeaftMessageTurns(messages = [], visibleTurns = DEFAULT_VISIBLE_TURNS) {
  return countYeaftMessageTurns(messages) > Math.max(1, visibleTurns || DEFAULT_VISIBLE_TURNS);
}

export function getDefaultYeaftVisibleTurns() {
  return DEFAULT_VISIBLE_TURNS;
}

export function getYeaftWindowLoadStepTurns() {
  return LOAD_STEP_TURNS;
}
