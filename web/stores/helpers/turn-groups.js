/**
 * turn-groups.js — message-stream → turn-group aggregator
 *
 * Pure function lifted out of MessageList.js so the turn-boundary rules
 * can be unit-tested without Vue. The component is the only caller; the
 * SplitPane copy is a simpler 1:1-chat variant that doesn't deal with
 * VP speaker attribution and is intentionally not consolidated here.
 *
 * task-334-ui-b moment-1: turn boundaries split on
 *   1. user / system / error / feature-message rows (always flush)
 *   2. unknown-type rows (always flush)
 *   3. an assistant message whose `turnId` differs from the open turn's
 *      latched turnId (NEW — was missing, caused two VPs replying
 *      back-to-back to collapse under the first speaker's avatar)
 *
 * Same VP, same turnId → keep merging (chunked stream of one reply).
 * Same VP, different turnId → split into two cards (it spoke twice).
 * Different VP, different turnId → split, attribution stays honest.
 *
 * The decision is intentionally turnId-driven (not speakerVpId): a
 * single VP that emits two distinct turns deserves two cards, even
 * though its avatar is the same.
 */

/**
 * Should we flush the open turn before appending this assistant message?
 * Exported so the rule has a name and a single home.
 *
 * @param {object|null} currentTurn - in-flight turn, or null
 * @param {object} msg - the incoming assistant message
 * @returns {boolean} - true ⇒ caller should call finishTurn() first
 */
export function shouldFlushBeforeAssistant(currentTurn, msg) {
  if (!currentTurn) return false;
  if (!currentTurn.turnId) return false;
  if (!msg || !msg.turnId) return false;
  return msg.turnId !== currentTurn.turnId;
}

/**
 * Build the turn-group list from a flat message array.
 *
 * @param {Array} messages - the conversation's flat message stream
 * @returns {Array} - turn groups + interleaved user/system/error/feature rows
 */
export function buildTurnGroups(messages) {
  const result = [];
  let currentTurn = null;
  let turnCounter = 0;

  const finishTurn = () => {
    if (!currentTurn) return;
    const hasContent =
      currentTurn.textContent ||
      currentTurn.toolMsgs.length > 0 ||
      currentTurn.todoMsg ||
      currentTurn.askMsg ||
      currentTurn.imageMsgs.length > 0;
    if (hasContent) {
      // WeChat-style attribution: every VP-attributed turn renders its
      // own header. Legacy 1:1 turns (no speakerVpId) stay headerless.
      currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId;
      result.push(currentTurn);
    }
    currentTurn = null;
  };

  const startTurn = () => {
    turnCounter++;
    currentTurn = {
      type: 'assistant-turn',
      id: 'turn_' + turnCounter,
      textContent: '',
      isStreaming: false,
      todoMsg: null,
      toolMsgs: [],
      imageMsgs: [],
      askMsg: null,
      messages: [],
      atMessageId: null,
      speakerVpId: null,
      speakerTimestamp: 0,
      speakerStateCause: '',
      showSpeakerHeader: false,
      turnId: null,
    };
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.type === 'user') {
      if (!msg.content || !msg.content.trim()) continue;
      finishTurn();
      result.push({ type: 'user', id: msg.id || 'u_' + i, message: msg });
      continue;
    }

    if (msg.type === 'system' || msg.type === 'error') {
      finishTurn();
      result.push({ type: msg.type, id: msg.id || 's_' + i, message: msg });
      continue;
    }

    if (msg.type === 'feature-message') {
      finishTurn();
      result.push({ type: 'feature-message', id: msg.id || 'tm_' + i, message: msg });
      continue;
    }

    if (msg.type === 'tool-result' || msg.type === 'tool_result') continue;

    if (msg.type === 'assistant') {
      if (shouldFlushBeforeAssistant(currentTurn, msg)) {
        finishTurn();
      }
      if (!currentTurn) startTurn();
      if (msg.content) currentTurn.textContent += msg.content;
      if (msg.isStreaming) currentTurn.isStreaming = true;
      if (msg.id && /^m\d+$/.test(msg.id)) {
        currentTurn.atMessageId = msg.id;
      }
      if (!currentTurn.speakerVpId && msg.speakerVpId) {
        currentTurn.speakerVpId = msg.speakerVpId;
        currentTurn.speakerTimestamp =
          (typeof msg.timestamp === 'number' && msg.timestamp > 0)
            ? msg.timestamp
            : (typeof msg.createdAt === 'number' ? msg.createdAt : 0);
        if (typeof msg.lastStateChangeCause === 'string') {
          currentTurn.speakerStateCause = msg.lastStateChangeCause;
        }
      }
      if (!currentTurn.turnId && msg.turnId) {
        currentTurn.turnId = msg.turnId;
      }
      currentTurn.messages.push(msg);
      continue;
    }

    if (msg.type === 'tool-use') {
      if (!currentTurn) startTurn();
      const nextMsg = messages[i + 1];
      const hasResult = nextMsg && (nextMsg.type === 'tool-result' || nextMsg.type === 'tool_result');
      const toolEntry = {
        ...msg,
        hasResult: hasResult || msg.hasResult || false,
        toolResult: msg.toolResult || null,
      };
      if (msg.toolName === 'TodoWrite') {
        currentTurn.todoMsg = toolEntry;
      } else if (msg.toolName === 'AskUserQuestion') {
        currentTurn.askMsg = toolEntry;
      } else {
        currentTurn.toolMsgs.push(toolEntry);
      }
      currentTurn.messages.push(msg);
      continue;
    }

    if (msg.type === 'chat-image') {
      if (!currentTurn) startTurn();
      currentTurn.imageMsgs.push(msg);
      currentTurn.messages.push(msg);
      continue;
    }

    finishTurn();
    result.push({ type: msg.type || 'unknown', id: msg.id || 'x_' + i, message: msg });
  }

  finishTurn();
  return result;
}
