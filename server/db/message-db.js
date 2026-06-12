import db from './connection.js';
import { stmts, transaction } from './connection.js';

export const messageDb = {
  add(sessionId, role, content, messageType = null, toolName = null, toolInput = null, metadata = null) {
    const now = Date.now();
    const result = stmts.insertMessage.run(sessionId, role, content, messageType, toolName, toolInput, now, metadata);
    // 更新会话的 updated_at
    // fix-chat-title-sticky: updateSession statement gained a fifth
    // placeholder for `is_custom_title` — pass null so COALESCE keeps
    // the existing value. Forgetting this arg is a RangeError on every
    // message insert.
    stmts.updateSession.run(null, null, null, now, sessionId);
    return result.lastInsertRowid;
  },

  getBySession(sessionId) {
    return stmts.getMessagesBySession.all(sessionId);
  },

  getRecent(sessionId, limit = 50) {
    return stmts.getRecentMessages.all(sessionId, limit).reverse();
  },

  getAfterId(sessionId, afterId) {
    return stmts.getMessagesAfterId.all(sessionId, afterId || 0);
  },

  getBeforeId(sessionId, beforeId, limit = 50) {
    return stmts.getMessagesBeforeId.all(sessionId, beforeId, limit).reverse();
  },

  getRecentTurns(sessionId, turnCount = 5) {
    const userIds = stmts.getRecentUserMessageIds.all(sessionId, turnCount);
    if (userIds.length === 0) return { messages: [], hasMore: false };
    const oldestUserId = userIds[userIds.length - 1].id;
    const messages = stmts.getMessagesFromId.all(sessionId, oldestUserId);
    const hasMore = stmts.getMessagesBeforeId.all(sessionId, oldestUserId, 1).length > 0;
    return { messages, hasMore };
  },

  getTurnsBeforeId(sessionId, beforeId, turnCount = 5) {
    const userIds = stmts.getUserMessageIdsBeforeId.all(sessionId, beforeId, turnCount);
    if (userIds.length === 0) return { messages: [], hasMore: false };
    const oldestUserId = userIds[userIds.length - 1].id;
    const messages = stmts.getMessagesBetweenIds.all(sessionId, oldestUserId, beforeId);
    const hasMore = stmts.getMessagesBeforeId.all(sessionId, oldestUserId, 1).length > 0;
    return { messages, hasMore };
  },

  getLastUserMessage(sessionId) {
    return stmts.getLastUserMessage.get(sessionId) || null;
  },

  bulkAddHistory(sessionId, historyMessages) {
    function extractUserText(msg) {
      const content = msg.message?.content;
      if (!content) return '';
      return typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.map(b => b.text || '').join('') : JSON.stringify(content));
    }

    // Detect compact summary messages injected by Claude CLI after context compaction.
    // These arrive as type:'user' but contain AI-generated context summaries, not real user input.
    function isCompactSummary(text) {
      if (!text) return false;
      return (text.includes('<context>') && text.includes('</context>'))
        || text.startsWith('Here is a summary of the conversation')
        || text.includes('<compact-summary>')
        || text.includes('This session is being continued from a previous conversation');
    }

    let msgsToInsert = historyMessages;
    const lastUserMsg = this.getLastUserMessage(sessionId);
    let needsRebuild = false;

    if (lastUserMsg) {
      const tsRange = stmts.getTimestampRange.get(sessionId);
      // feat-chat-load-perf: the timestamp-range heuristic is a one-shot repair,
      // not a per-resume hot path. The repair itself produces densely packed
      // `ts = lastTs + 1` rows, which re-pass the (< 1000ms) test on every
      // future resume — so without a sentinel the user pays a full DELETE +
      // re-INSERT of the entire session on EVERY chat open. The sentinel
      // `sessions.ts_rebuilt_at` is set to Date.now() the first (and only)
      // time the repair fires; subsequent resumes see non-zero and skip it,
      // falling through to the cheap anchor-based delta append below.
      if (tsRange && tsRange.count > 5 && (tsRange.max_ts - tsRange.min_ts) < 1000) {
        const sentinelRow = stmts.getSessionTsRebuiltAt.get(sessionId);
        const alreadyRebuilt = sentinelRow && sentinelRow.ts_rebuilt_at > 0;
        if (alreadyRebuilt) {
          // Quiet by default — every once-repaired session would otherwise log
          // this line on every future chat-resume forever, exactly inverting
          // the perf goal. Flip DEBUG_BULK_HISTORY to see it.
          if (process.env.DEBUG_BULK_HISTORY) {
            console.log(`[bulkAddHistory] Skipping rebuild for ${sessionId} (one-shot guard, ts_rebuilt_at=${sentinelRow.ts_rebuilt_at})`);
          }
        } else {
          console.log(`[bulkAddHistory] Detected bad timestamps (range: ${tsRange.max_ts - tsRange.min_ts}ms for ${tsRange.count} msgs), rebuilding for ${sessionId} (will delete ${tsRange.count} rows)`);
          needsRebuild = true;
        }
      }
      if (!needsRebuild) {
        const anchor = lastUserMsg.content;
        let anchorIndex = -1;

        for (let i = historyMessages.length - 1; i >= 0; i--) {
          const msg = historyMessages[i];
          if (msg.type === 'user') {
            const text = extractUserText(msg);
            if (text === anchor) {
              anchorIndex = i;
              break;
            }
          }
        }

        if (anchorIndex === -1) {
          console.log(`[bulkAddHistory] Anchor not found in history, appending all ${historyMessages.length} messages for ${sessionId}`);
        } else {
          let nextTurnStart = -1;
          for (let i = anchorIndex + 1; i < historyMessages.length; i++) {
            if (historyMessages[i].type === 'user') {
              nextTurnStart = i;
              break;
            }
          }

          if (nextTurnStart === -1) {
            return 0;
          }

          msgsToInsert = historyMessages.slice(nextTurnStart);
        }
      }
    }

    const insertMany = transaction((msgs) => {
      if (needsRebuild) {
        stmts.deleteMessagesBySession.run(sessionId);
        // Stamp the sentinel inside the same transaction as DELETE + re-INSERT.
        // SQLite is atomic, so either everything (rows + stamp) lands or
        // nothing does — preventing the "rows rebuilt but stamp lost ⇒
        // rebuild loops forever on every future resume" failure mode that
        // motivated this entire change.
        stmts.markSessionTsRebuilt.run(Date.now(), sessionId);
      }

      let count = 0;
      let lastTs = 0;
      for (const msg of msgs) {
        const rawTs = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
        const ts = rawTs > lastTs ? rawTs : lastTs + 1;
        lastTs = ts;

        if (msg.type === 'user') {
          const text = extractUserText(msg);
          if (text) {
            if (isCompactSummary(text)) {
              console.log(`[bulkAddHistory] Skipping compact summary message (${text.length} chars) for ${sessionId}`);
              continue;
            }
            stmts.insertMessage.run(sessionId, 'user', text, 'user', null, null, ts, null);
            count++;
          }
        } else if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (!content || !Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              stmts.insertMessage.run(sessionId, 'assistant', block.text, 'assistant', null, null, ts, null);
              count++;
            } else if (block.type === 'tool_use') {
              stmts.insertMessage.run(
                sessionId, 'assistant', JSON.stringify(block.input || {}),
                'tool_use', block.name, JSON.stringify(block.input || {}), ts, null
              );
              count++;
            }
          }
        }
      }
      return count;
    });
    return insertMany(msgsToInsert);
  },

  getCount(sessionId) {
    return stmts.getMessageCount.get(sessionId)?.count || 0;
  },

  updateMetadata(messageId, metadata) {
    stmts.updateMessageMetadata.run(metadata, messageId);
  },

  deleteBySession(sessionId) {
    stmts.deleteMessagesBySession.run(sessionId);
  }
};
