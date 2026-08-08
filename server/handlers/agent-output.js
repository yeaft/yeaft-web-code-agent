import { randomUUID } from 'crypto';
import { messageDb, sessionUiMetadataDb, yeaftProjectDb, yeaftSessionDb } from '../database.js';
import { transaction } from '../db/connection.js';
import { broadcastAgentList, broadcastSessionCatalog, forwardToClients, sendToAgent, sendToWebClient } from '../ws-utils.js';
import { consumeYeaftDebugRequest, webClients, previewFiles } from '../context.js';
import { CONFIG } from '../config.js';
import { yeaftAssetStore } from '../yeaft-asset-store.js';
import { recordPerfTraceEvent } from '../perf-trace.js';


export function decorateYeaftSessionsWithPinned(agentId, sessions) {
  const rawRows = Array.isArray(sessions) ? sessions : [];
  const rowsById = new Map();
  let authoritative = true;
  try {
    for (const row of yeaftSessionDb.getByAgent(agentId)) {
      if (row && row.id) rowsById.set(row.id, row);
    }
  } catch (e) {
    authoritative = false;
    console.warn(`[Server] yeaft session metadata decorate read failed for agent ${agentId}:`, e?.message || e);
  }
  if (!authoritative) return rawRows;
  return rawRows.map(s => {
    if (!s || !s.id) return s;
    const row = rowsById.get(s.id);
    const pinned = !!row?.isPinned;
    return {
      ...s,
      pinned,
      isPinned: pinned,
      ...(Number.isFinite(row?.sortOrder) ? { sortOrder: row.sortOrder } : {}),
    };
  });
}

function reconcileAuthoritativeSessionSnapshot(ownerId, agentId, sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  transaction(() => {
    yeaftSessionDb.reconcileFromSnapshot(ownerId, agentId, rows);
    yeaftProjectDb.reconcileAgentSessions(
      ownerId,
      agentId,
      rows.map(row => row?.id).filter(Boolean),
    );
  })();
  return rows;
}

function syncYeaftSessionMetadata(agentId, agent, event) {
  if (!event || typeof event !== 'object') return event;
  const ownerId = agent?.ownerId || null;

  if (event.type === 'session_list_updated') {
    const rows = Array.isArray(event.sessions) ? event.sessions : [];
    agent.yeaftSessions = new Map(rows
      .filter(session => session?.id)
      .map(session => [session.id, { ...session }]));
    try {
      if (ownerId) {
        reconcileAuthoritativeSessionSnapshot(ownerId, agentId, rows);
        yeaftProjectDb.importLegacyProjects(
          ownerId,
          agentId,
          event.projects,
          sessionId => rows.some(row => row?.id === sessionId),
        );
      }
    } catch (e) {
      console.warn(`[Server] yeaft session persist failed for agent ${agentId}:`, e?.message || e);
    }
    return { ...event, sessions: decorateYeaftSessionsWithPinned(agentId, rows) };
  }

  if (event.type !== 'session_crud_result') return event;
  const op = event.op;
  const sessionId = event.sessionId;
  if (event.ok && op === 'list' && Array.isArray(event.sessions)) {
    try {
      if (ownerId) reconcileAuthoritativeSessionSnapshot(ownerId, agentId, event.sessions);
    } catch (e) {
      console.warn(`[Server] yeaft session list persist failed for agent ${agentId}:`, e?.message || e);
    }
    return { ...event, sessions: decorateYeaftSessionsWithPinned(agentId, event.sessions) };
  }
  if (!event.ok || !ownerId || !sessionId || (op !== 'archive' && op !== 'delete')) return event;

  if (op === 'archive') {
    try {
      yeaftSessionDb.setArchivedForAgent(ownerId, agentId, sessionId, true);
      yeaftProjectDb.removeSession(ownerId, agentId, sessionId);
    } catch (e) {
      console.warn('[Server] Yeaft Session metadata archive failed:', e?.message || e);
    }
    return event;
  }

  try {
    yeaftSessionDb.deleteForAgent(ownerId, agentId, sessionId);
    yeaftProjectDb.removeSession(ownerId, agentId, sessionId);
    sessionUiMetadataDb.deleteForRoute(ownerId, {
      runtimeProvider: 'yeaft',
      agentId,
      sessionId,
    });
  } catch (e) {
    console.warn('[Server] Yeaft Session metadata cleanup failed:', e?.message || e);
  }
  try {
    yeaftAssetStore.deleteScope({ ownerId, agentId, sessionId });
  } catch (e) {
    console.warn('[Server] Yeaft asset cleanup failed:', e?.message || e);
  }
  return event;
}

function hydrateMessagePreviewData(message) {
  const attachments = message?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return message;
  let changed = false;
  const hydrated = attachments.map((att) => {
    const previewData = att?.previewData;
    if (!previewData?.data || att.preview) return att;
    const fileId = randomUUID();
    const token = randomUUID();
    previewFiles.set(fileId, {
      buffer: Buffer.from(previewData.data, 'base64'),
      mimeType: previewData.mimeType || att.mimeType || 'application/octet-stream',
      filename: previewData.filename || att.name || `attachment-${Date.now()}`,
      createdAt: Date.now(),
      token,
    });
    changed = true;
    const { previewData: _previewData, ...rest } = att;
    return {
      ...rest,
      preview: `/api/preview/${fileId}?token=${encodeURIComponent(token)}`,
    };
  });
  return changed ? { ...message, attachments: hydrated } : message;
}

function hydrateInlinePreviewData(data) {
  if (!data?.message) return data;
  const message = hydrateMessagePreviewData(data.message);
  return message === data.message ? data : { ...data, message };
}

function projectConfirmedAssetImages(messages, { ownerId, agentId, sessionId }) {
  const turnIds = messages
    .filter(message => message?.role === 'assistant' && message.imageAssetAnchor === true)
    .map(message => message.turnId || message.threadId || null)
    .filter(Boolean);
  const imagesByTurn = yeaftAssetStore.describeTurns({ ownerId, agentId, sessionId, turnIds });
  return messages.map((message) => {
    if (!message || message.role !== 'assistant') return message;
    const { images: _pendingImages, ...rest } = message;
    if (message.imageAssetAnchor !== true) return rest;
    const turnId = message.turnId || message.threadId || null;
    const images = turnId ? imagesByTurn.get(turnId) || [] : [];
    return images.length > 0 ? { ...rest, images } : rest;
  });
}

/**
 * Handle CLI/Yeaft output and interaction messages from agent.
 * Types: claude_output (legacy Claude/Copilot CLI output frame),
 *        yeaft_output / yeaft_session_output / session_output,
 *        chat_image, context_usage, execution_cancelled,
 *        background_task_started, background_task_output,
 *        slash_commands_update, compact_status, ask_user_question,
 *        conversation_mcp_update, error,
 *        btw_stream, btw_done, btw_error
 */
export async function handleAgentOutput(agentId, agent, msg) {
  switch (msg.type) {
    case 'claude_output':
      // 保存消息到数据库
      try {
        const data = msg.data;
        if (data && msg.conversationId) {
          if (data.type === 'user' && data.message?.content) {
            const rawContent = data.message.content;
            const content = typeof rawContent === 'string'
              ? rawContent
              : (Array.isArray(rawContent) ? rawContent.map(b => b.text || '').join('') : JSON.stringify(rawContent));
            // Skip empty content — tool_result arrays produce '' which shouldn't be stored as user messages
            if (content) {
              // 检查 convInfo 上暂存的 expertSelections，保存为 metadata
              const conv = agent.conversations.get(msg.conversationId);
              // fix-usermsg-dup: pull the client-stamped id stashed by the
              // `chat` handler so the echo carries it back to the web for
              // optimistic-dedup, AND so the DB row preserves it for
              // post-refresh `sync_messages_result` replay. Without the DB
              // half, refresh → resend would lose the dedup key and fall
              // back to the unreliable content-equality path.
              const clientMessageId = conv?._pendingClientMessageId || null;
              // Review M2 (Torvalds): build the payload first, then
              // clear the stash. Mixing mutation with build made the
              // delete look conditional on the JSON construction.
              const metaParts = {};
              if (conv?._pendingExperts) metaParts.experts = conv._pendingExperts;
              if (clientMessageId) metaParts.clientMessageId = clientMessageId;
              if (conv) {
                delete conv._pendingExperts;
                delete conv._pendingClientMessageId;
              }
              const metadata = Object.keys(metaParts).length > 0 ? JSON.stringify(metaParts) : null;
              const dbId = messageDb.add(msg.conversationId, 'user', content, 'user', null, null, metadata);
              msg.data.dbMessageId = dbId;
              if (clientMessageId) {
                msg.data.clientMessageId = clientMessageId;
              }
              // User-turn stats are recorded at the web send boundary so
              // inbound payload bytes are counted exactly once.
            }
          }
          if (data.type === 'assistant' && data.message?.content) {
            let content;
            if (typeof data.message.content === 'string') {
              content = data.message.content;
            } else if (Array.isArray(data.message.content)) {
              content = data.message.content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join('');
            } else {
              content = JSON.stringify(data.message.content);
            }
            if (content) {
              const dbId = messageDb.add(msg.conversationId, 'assistant', content, 'assistant');
              msg.data.dbMessageId = dbId;
            }
          }
          if (data.type === 'assistant' && data.message?.content) {
            const contents = Array.isArray(data.message.content)
              ? data.message.content
              : [data.message.content];
            for (const item of contents) {
              if (item.type === 'tool_use') {
                messageDb.add(
                  msg.conversationId,
                  'assistant',
                  JSON.stringify(item.input || {}),
                  'tool_use',
                  item.name,
                  JSON.stringify(item.input || {})
                );
              }
            }
          }
          if (data.type === 'result') {
            const resultContent = typeof data.result === 'string'
              ? data.result
              : JSON.stringify(data.result);
            const truncated = resultContent.length > 10000
              ? resultContent.slice(0, 10000) + '...[truncated]'
              : resultContent;
            messageDb.add(msg.conversationId, 'tool', truncated, 'tool_result');
          }
        }
      } catch (e) {
        // 静默处理保存错误，不影响正常流程
      }
      await forwardToClients(agentId, msg.conversationId, {
        type: 'claude_output',
        conversationId: msg.conversationId,
        data: msg.data
      });
      break;

    case 'context_usage':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'context_usage',
        conversationId: msg.conversationId,
        inputTokens: msg.inputTokens,
        maxTokens: msg.maxTokens,
        percentage: msg.percentage
      });
      break;

    case 'execution_cancelled': {
      const cancelledConv = agent.conversations.get(msg.conversationId);
      if (cancelledConv) {
        cancelledConv.processing = false;
      }
      await forwardToClients(agentId, msg.conversationId, {
        type: 'execution_cancelled',
        conversationId: msg.conversationId
      });
      await broadcastAgentList();
      break;
    }

    case 'background_task_started':
      console.log(`[Background] Task started: ${msg.task?.id} in conversation ${msg.conversationId}`);
      await forwardToClients(agentId, msg.conversationId, {
        type: 'background_task_started',
        conversationId: msg.conversationId,
        task: msg.task
      });
      break;

    case 'background_task_output':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'background_task_output',
        conversationId: msg.conversationId,
        taskId: msg.taskId,
        task: msg.task,
        newOutput: msg.newOutput
      });
      break;

    case 'subagent_started':
    case 'subagent_message':
    case 'subagent_completed':
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

    case 'slash_commands_update': {
      const isYeaftCommandSet = msg.commandSet === 'yeaft';
      let slashCommandDescriptions;
      if (isYeaftCommandSet) {
        // Yeaft publishes an authoritative hot-reload snapshot. Keep it out of
        // the Claude cache used by agent_selected and clear removed descriptions.
        agent.yeaftSlashCommands = msg.slashCommands || [];
        if (msg.slashCommandDescriptions) {
          agent.yeaftSlashCommandDescriptions = { ...msg.slashCommandDescriptions };
        }
        slashCommandDescriptions = agent.yeaftSlashCommandDescriptions || {};
      } else {
        // Claude Chat remains the legacy/default command set selected clients receive.
        agent.slashCommands = msg.slashCommands || [];
        if (msg.slashCommandDescriptions) {
          agent.slashCommandDescriptions = { ...agent.slashCommandDescriptions, ...msg.slashCommandDescriptions };
        }
        slashCommandDescriptions = agent.slashCommandDescriptions || {};
      }
      const commandSet = msg.commandSet ? { commandSet: msg.commandSet } : {};
      if (msg.conversationId === '__preload__') {
        // Agent-level preload: broadcast to all owner clients with agentId.
        for (const [, client] of webClients) {
          if (client.authenticated && (CONFIG.skipAuth || agent.ownerId === client.userId)) {
            await sendToWebClient(client, {
              type: 'slash_commands_update',
              agentId,
              ...commandSet,
              slashCommands: msg.slashCommands,
              slashCommandDescriptions,
            });
          }
        }
      } else {
        // Per-conversation update. Preserve commandSet so the web store can
        // isolate Yeaft snapshots from the Claude agent-level fallback.
        await forwardToClients(agentId, msg.conversationId, {
          type: 'slash_commands_update',
          agentId,
          conversationId: msg.conversationId,
          ...commandSet,
          slashCommands: msg.slashCommands,
          slashCommandDescriptions,
        });
      }
      break;
    }

    case 'compact_status':
      console.log(`[Compact] Status: ${msg.status} for conversation ${msg.conversationId}`);
      await forwardToClients(agentId, msg.conversationId, {
        type: 'compact_status',
        conversationId: msg.conversationId,
        status: msg.status,
        message: msg.message
      });
      break;

    case 'ask_user_question':
      console.log(`[AskUser] Question for conversation ${msg.conversationId}, requestId: ${msg.requestId}`);
      // Persist requestId + questions into the AskUserQuestion tool_use DB record
      try {
        if (msg.conversationId && msg.requestId) {
          // Search enough messages to find the tool_use record (may be far from latest
          // if there was a lot of streaming output between tool_use and ask_user_question)
          const recent = messageDb.getRecent(msg.conversationId, 100);
          // Find the LATEST unlinked AskUserQuestion (search from newest to oldest)
          let askMsg = null;
          for (let i = recent.length - 1; i >= 0; i--) {
            const m = recent[i];
            if (m.message_type === 'tool_use' && m.tool_name === 'AskUserQuestion') {
              // Check if already linked to a different requestId
              if (m.metadata) {
                try {
                  const existing = JSON.parse(m.metadata);
                  if (existing.askRequestId && existing.askRequestId !== msg.requestId) continue;
                } catch { /* proceed */ }
              }
              askMsg = m;
              break;
            }
          }
          if (askMsg) {
            messageDb.updateMetadata(askMsg.id, JSON.stringify({
              askRequestId: msg.requestId,
              askQuestions: msg.questions
            }));
          }
        }
      } catch (e) {
        // Silent — don't block the main flow
      }
      await forwardToClients(agentId, msg.conversationId, {
        type: 'ask_user_question',
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        questions: msg.questions
      });
      break;

    case 'conversation_mcp_update':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'conversation_mcp_update',
        conversationId: msg.conversationId,
        servers: msg.servers,
        serverTools: msg.serverTools
      });
      break;

    case 'error':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'error',
        conversationId: msg.conversationId,
        message: msg.message
      });
      break;

    case 'btw_stream':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'btw_stream',
        conversationId: msg.conversationId,
        delta: msg.delta
      });
      break;

    case 'btw_done':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'btw_done',
        conversationId: msg.conversationId
      });
      break;

    case 'btw_error':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'btw_error',
        conversationId: msg.conversationId,
        error: msg.error
      });
      break;

    case 'pong_session': {
      // Forward pong to specific client (if clientId provided) or broadcast
      if (msg.clientId) {
        const targetClient = webClients.get(msg.clientId);
        if (targetClient) {
          await sendToWebClient(targetClient, {
            type: 'pong_session',
            conversationId: msg.conversationId,
            status: msg.status,
            isProcessing: msg.isProcessing,
            currentTool: msg.currentTool
          });
        }
      } else {
        await forwardToClients(agentId, msg.conversationId, {
          type: 'pong_session',
          conversationId: msg.conversationId,
          status: msg.status,
          isProcessing: msg.isProcessing,
          currentTool: msg.currentTool
        });
      }
      break;
    }

    case 'chat_image': {
      // Image from Claude response (tool screenshots, etc.) — persisted on agent side,
      // cached on server in previewFiles for web client serving via /api/preview/:fileId
      const dataSize = msg.data ? Buffer.byteLength(msg.data, 'base64') : 0;
      if (dataSize > 10 * 1024 * 1024) {
        console.warn(`[Server] Chat image too large: ${dataSize} bytes, skipping`);
        break;
      }
      const fileId = randomUUID();
      const token = randomUUID();
      previewFiles.set(fileId, {
        buffer: Buffer.from(msg.data, 'base64'),
        mimeType: msg.mimeType,
        filename: msg.filename || `chat-${Date.now()}.png`,
        createdAt: Date.now(),
        token
      });
      await forwardToClients(agentId, msg.conversationId, {
        type: 'chat_image',
        conversationId: msg.conversationId,
        fileId,
        previewToken: token,
        mimeType: msg.mimeType
      });
      console.log(`[Server] Cached chat image: fileId=${fileId}, conv=${msg.conversationId}, mime=${msg.mimeType}`);
      break;
    }

    case 'yeaft_asset_put': {
      let ok = false;
      let stored = false;
      let error = null;
      try {
        if (!agent.ownerId || !msg.sessionId || !msg.image?.previewData?.data) {
          throw new Error('Incomplete Yeaft asset payload');
        }
        const image = yeaftAssetStore.put({
          ownerId: agent.ownerId, agentId, sessionId: msg.sessionId,
          assetId: msg.metadata?.assetId || msg.image.assetId, data: msg.image.previewData.data,
          mimeType: msg.metadata?.mimeType || msg.image.mimeType || msg.image.previewData.mimeType,
          filename: msg.metadata?.filename || msg.image.filename || msg.image.previewData.filename,
          width: msg.metadata?.width ?? msg.image.width,
          height: msg.metadata?.height ?? msg.image.height,
          turnId: msg.turnId || null,
          vpId: msg.vpId || null,
          threadId: msg.threadId || null,
        });
        stored = true;
        await forwardToClients(agentId, msg.conversationId, {
          type: 'yeaft_asset_ready', conversationId: msg.conversationId,
          agentId, sessionId: msg.sessionId,
          ...(msg.vpId ? { vpId: msg.vpId } : {}),
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
          image, _requestUserId: agent.ownerId,
        });
        ok = true;
      } catch (err) {
        error = err?.message || String(err);
        console.warn(`[Server] Failed to store Yeaft asset: ${error}`);
      }
      if (msg.deliveryId) {
        await sendToAgent(agent, {
          type: 'yeaft_asset_ack',
          deliveryId: msg.deliveryId,
          ok: ok || stored,
          ...(!stored && /quota exceeded|invalid|unsupported|MIME|must be between|does not match|incomplete/i.test(error || '') ? { permanent: true } : {}),
          ...(error ? { error } : {}),
        });
      }
      break;
    }

    case 'yeaft_output':
    case 'yeaft_session_output':
    case 'session_output': {
      const data = hydrateInlinePreviewData(msg.data);
      let event = syncYeaftSessionMetadata(agentId, agent, msg.event);
      if ((event?.type === 'session_list_updated' || event?.type === 'session_crud_result') && agent.ownerId) {
        event = {
          ...event,
          projects: yeaftProjectDb.listForAgent(agent.ownerId, agentId),
          projectsAuthoritative: true,
        };
      }
      let catalogChanged = false;
      if (event?.type === 'yeaft_status') {
        agent.yeaftStatus = event;
        await broadcastAgentList();
      }
      if (event?.type === 'session_roster_changed' && agent.ownerId && event.sessionId) {
        try {
          const existing = yeaftSessionDb.getForAgent(agent.ownerId, agentId, event.sessionId);
          if (existing) {
            yeaftSessionDb.upsertFromSnapshot(agent.ownerId, agentId, {
              id: event.sessionId,
              name: event.name != null ? event.name : (existing.name || event.sessionId),
              roster: Array.isArray(event.roster) ? event.roster : (existing.roster || []),
              defaultVpId: event.defaultVpId != null ? event.defaultVpId : (existing.defaultVpId || null),
              workDir: existing.workDir || '',
              config: existing.config || {},
              announcement: typeof event.announcement === 'string'
                ? event.announcement
                : (existing.announcement || ''),
              createdAt: existing.createdAt || Date.now(),
              metadataUpdatedAt: event.metadataUpdatedAt || existing.metadataUpdatedAt || existing.createdAt || null,
            });
            catalogChanged = true;
          }
        } catch (e) {
          console.warn(`[Server] yeaft roster persist failed for agent ${agentId}:`, e?.message || e);
        }
      }
      if (msg.perfTraceId) {
        recordPerfTraceEvent({
          traceId: msg.perfTraceId,
          source: 'server',
          phase: 'relay.agent_output_received',
          at: Date.now(),
          userId: agent.ownerId || null,
          agentId,
          sessionId: msg.sessionId || null,
          vpId: msg.vpId || null,
          turnId: msg.turnId || null,
          threadId: msg.threadId || null,
          messageType: data?.type || msg.event?.type || msg.type,
          bytes: Buffer.byteLength(JSON.stringify(msg)),
        });
      }
      // History request completions are client-scoped; live Session output stays
      // broadcast to every authenticated tab owned by this user.
      const hasRequestedClient = typeof msg._requestClientId === 'string' && !!msg._requestClientId;
      const requestedClient = hasRequestedClient ? webClients.get(msg._requestClientId) : null;
      const outputClients = hasRequestedClient
        ? (requestedClient ? [[msg._requestClientId, requestedClient]] : [])
        : webClients;
      // Forward Yeaft Session output to all authenticated clients of this agent's owner.
      // Payload carries { conversationId, data } (assistant output frame) or { event } (metadata).
      //
      // Compatibility: accept neutral aliases from newer agents, but always
      // relay the legacy `yeaft_output` envelope so older web bundles continue
      // to render during rolling upgrades.
      //
      // Envelope passthrough — every field the agent stamped on the envelope
      // (groupId, vpId, turnId) MUST be forwarded verbatim. The
      // frontend uses vpId + turnId in `handleYeaftOutput` to set
      // `_currentYeaftVpId` / `_currentYeaftTurnId`, which in turn drive
      // `stampSpeakerOnVpMessage` so streaming assistant deltas get a
      // `speakerVpId`. Without that, MessageList falls through from
      // VpTurnBlock (with avatar) to a plain AssistantTurn (no avatar) —
      // the bug v0.1.756 fixed. Keep this spread in sync with the agent
      // side `sendSessionOutputFrame` / `sendSessionEvent` in agent/yeaft/web-bridge.js.
      //
      // (2026-05-13: `featureId` field dropped from the envelope along
      // with the rest of the Feature system.)
      //
      // Forward semantics: `!= null` (not truthy) — a relay should
      // pass through whatever was stamped, including empty strings. IDs
      // are non-empty in practice, but we don't want the relay silently
      // eating a legitimate "" or 0 if one ever shows up.
      for (const [cId, c] of outputClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, {
            type: 'yeaft_output',
            conversationId: msg.conversationId,
            ...(msg.perfTraceId != null ? { perfTraceId: msg.perfTraceId } : {}),
            ...(msg.requestId != null ? { requestId: msg.requestId } : {}),
            // Stamp the source agent so the web sessions store can keep
            // per-agent rosters (cross-agent listing in the unified
            // sidebar). Older web bundles ignore the extra field.
            agentId: agentId,
            ...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
            ...(msg.vpId != null ? { vpId: msg.vpId } : {}),
            ...(msg.turnId != null ? { turnId: msg.turnId } : {}),
            ...(msg.threadId != null ? { threadId: msg.threadId } : {}),
            data,
            event,
          });
          if (msg.perfTraceId) {
            recordPerfTraceEvent({
              traceId: msg.perfTraceId,
              source: 'server',
              phase: 'relay.forward_to_web',
              at: Date.now(),
              userId: c.userId || null,
              agentId,
              sessionId: msg.sessionId || null,
              vpId: msg.vpId || null,
              turnId: msg.turnId || null,
              threadId: msg.threadId || null,
              messageType: data?.type || msg.event?.type || msg.type,
            });
          }
        }
      }
      // Nested `session_list_updated` events carry the same authoritative
      // snapshot as the top-level alias below. Re-project the server-owned
      // catalog after reconciliation so the unified sidebar updates in both
      // local no-auth and deployed runtimes. Roster changes are handled by
      // their own metadata branch above.
      if ((event?.type === 'session_list_updated' || catalogChanged) && agent.ownerId) {
        await broadcastSessionCatalog(agent.ownerId);
      }
      break;
    }

    case 'yeaft_history_outline': {
      const targetClient = msg._requestClientId ? webClients.get(msg._requestClientId) : null;
      if (targetClient?.authenticated && (CONFIG.skipAuth || targetClient.userId === agent.ownerId)) {
        await sendToWebClient(targetClient, {
          type: 'yeaft_history_outline',
          agentId,
          requestId: msg.requestId ?? null,
          sessionId: msg.sessionId ?? null,
          results: Array.isArray(msg.results) ? msg.results : [],
          hasMore: !!msg.hasMore,
          nextBeforeSeq: msg.nextBeforeSeq ?? null,
          nextCursor: msg.nextCursor && typeof msg.nextCursor === 'object' ? msg.nextCursor : null,
          totalCount: Number.isFinite(msg.totalCount) ? msg.totalCount : null,
          ...(typeof msg.perfTraceId === 'string' ? { perfTraceId: msg.perfTraceId } : {}),
          ...(msg.error ? { error: msg.error } : {}),
        });
      }
      break;
    }

    case 'yeaft_history_search_result': {
      const targetClient = msg._requestClientId ? webClients.get(msg._requestClientId) : null;
      if (targetClient?.authenticated && (CONFIG.skipAuth || targetClient.userId === agent.ownerId)) {
        await sendToWebClient(targetClient, {
          type: 'yeaft_history_search_result',
          agentId,
          requestId: msg.requestId ?? null,
          sessionId: msg.sessionId ?? null,
          query: msg.query || '',
          senderKey: msg.senderKey || '',
          results: Array.isArray(msg.results) ? msg.results : [],
          hasMore: !!msg.hasMore,
          nextBeforeSeq: msg.nextBeforeSeq ?? null,
          nextCursor: msg.nextCursor && typeof msg.nextCursor === 'object' ? msg.nextCursor : null,
          ...(typeof msg.perfTraceId === 'string' ? { perfTraceId: msg.perfTraceId } : {}),
          ...(msg.error ? { error: msg.error } : {}),
        });
      }
      break;
    }

    case 'yeaft_history_window': {
      const targetClient = msg._requestClientId ? webClients.get(msg._requestClientId) : null;
      if (targetClient?.authenticated && (CONFIG.skipAuth || targetClient.userId === agent.ownerId)) {
        const messages = Array.isArray(msg.messages) ? projectConfirmedAssetImages(
          msg.messages.map(hydrateMessagePreviewData),
          { ownerId: agent.ownerId, agentId, sessionId: msg.sessionId },
        ) : [];
        await sendToWebClient(targetClient, {
          type: 'yeaft_history_window',
          agentId,
          requestId: msg.requestId ?? null,
          conversationId: msg.conversationId ?? null,
          sessionId: msg.sessionId ?? null,
          entryId: msg.entryId ?? null,
          indexGeneration: msg.indexGeneration ?? null,
          entryStartSeq: msg.entryStartSeq ?? null,
          entryEndSeq: msg.entryEndSeq ?? null,
          sourceMessageIds: Array.isArray(msg.sourceMessageIds) ? msg.sourceMessageIds : [],
          anchorMessageId: msg.anchorMessageId ?? null,
          anchorSeq: msg.anchorSeq ?? null,
          messages,
          oldestSeq: msg.oldestSeq ?? null,
          hasMoreBefore: !!msg.hasMoreBefore,
          rowCount: Number.isFinite(msg.rowCount) ? msg.rowCount : messages.length,
          byteCount: Number.isFinite(msg.byteCount) ? msg.byteCount : null,
          ...(msg.error ? { error: msg.error } : {}),
        });
      }
      break;
    }

    case 'yeaft_history_chunk': {
      const messages = Array.isArray(msg.messages)
        ? projectConfirmedAssetImages(
          msg.messages.map(hydrateMessagePreviewData),
          { ownerId: agent.ownerId, agentId, sessionId: msg.sessionId },
        )
        : [];
      // Forward a "load older messages" pagination chunk to the same
      // authenticated clients. Distinct from `yeaft_output` because the
      // frontend needs to PREPEND these older messages above the current
      // history (whereas yeaft_output flows through an append pipeline).
      if (msg.perfTraceId) {
        recordPerfTraceEvent({
          traceId: msg.perfTraceId,
          source: 'server',
          phase: 'relay.agent_output_received',
          at: Date.now(),
          userId: agent.ownerId || null,
          agentId,
          sessionId: msg.sessionId || null,
          messageType: msg.type,
          bytes: Buffer.byteLength(JSON.stringify(msg)),
          detail: { mode: msg.mode || 'older', count: messages.length },
        });
      }
      const hasRequestedClient = typeof msg._requestClientId === 'string' && !!msg._requestClientId;
      const requestedClient = hasRequestedClient ? webClients.get(msg._requestClientId) : null;
      const historyClients = hasRequestedClient
        ? (requestedClient ? [[msg._requestClientId, requestedClient]] : [])
        : webClients;
      for (const [cId, c] of historyClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, {
            type: 'yeaft_history_chunk',
            agentId,
            conversationId: msg.conversationId,
            ...(msg.perfTraceId != null ? { perfTraceId: msg.perfTraceId } : {}),
            ...(msg.requestId != null ? { requestId: msg.requestId } : {}),
            ...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
            messages,
            mode: msg.mode || 'older',
            oldestSeq: msg.oldestSeq ?? null,
            nextBeforeSeq: msg.nextBeforeSeq ?? msg.oldestSeq ?? null,
            hasMore: !!msg.hasMore,
            latestSeq: msg.latestSeq ?? null,
            afterSeq: msg.afterSeq ?? null,
            hasMoreAfter: !!msg.hasMoreAfter,
            streamId: msg.streamId ?? null,
            revision: msg.revision ?? null,
            turns: msg.turns ?? null,
            pageKind: msg.pageKind === 'gap' ? 'gap' : (msg.pageKind || null),
            gapStopAtSeq: msg.gapStopAtSeq ?? null,
            cacheEpoch: msg.cacheEpoch ?? null,
          });
          if (msg.perfTraceId) {
            recordPerfTraceEvent({
              traceId: msg.perfTraceId,
              source: 'server',
              phase: 'relay.forward_to_web',
              at: Date.now(),
              userId: c.userId || null,
              agentId,
              sessionId: msg.sessionId || null,
              messageType: msg.type,
            });
          }
        }
      }
      break;
    }

    case 'yeaft_dream_status':
    case 'yeaft_dream_result':
      // Forward Dream lifecycle envelopes to the web client.
      //
      // The bug this fixes: `handleYeaftDreamTrigger` in
      // `agent/yeaft/web-bridge.js` emits these as BARE top-level
      // messages when the user clicks "Run dream now" (in the topbar or
      // group settings). Without a case here, the switch hit
      // `default: return false` and silently dropped the message,
      // leaving the UI stuck on "Running…" even after the dream pass
      // completed.
      //
      // Whitelist spread matches the pattern used by sibling cases
      // (`yeaft_output`, `yeaft_history_chunk`) so a future agent-side
      // bug that tags an internal field onto a dream envelope can't
      // leak it to the web client. Keep in sync with the agent emit at
      // `handleYeaftDreamTrigger`.
      for (const [, c] of webClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, {
            type: msg.type,
            ...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
            ...(msg.vpId != null ? { vpId: msg.vpId } : {}),
            ...(msg.status != null ? { status: msg.status } : {}),
            ...(typeof msg.success === 'boolean' ? { success: msg.success } : {}),
            ...(typeof msg.entriesCreated === 'number' ? { entriesCreated: msg.entriesCreated } : {}),
            ...(msg.lastDreamAt != null ? { lastDreamAt: msg.lastDreamAt } : {}),
            ...(msg.skipped ? { skipped: true } : {}),
            ...(msg.error != null ? { error: msg.error } : {}),
            ...(Array.isArray(msg.groups) ? { groups: msg.groups } : {}),
            ...(Array.isArray(msg.targets) ? { targets: msg.targets } : {}),
            ...(msg.startedAt != null ? { startedAt: msg.startedAt } : {}),
          });
        }
      }
      break;

    case 'yeaft_plugin_catalog_result': {
      const targetClient = msg._requestClientId ? webClients.get(msg._requestClientId) : null;
      if (targetClient?.authenticated && (CONFIG.skipAuth || targetClient.userId === agent.ownerId)) {
        await sendToWebClient(targetClient, {
          type: 'yeaft_plugin_catalog_result',
          agentId,
          requestId: msg.requestId || null,
          catalog: msg.catalog || { tools: [], skills: [], mcpServers: [] },
          error: msg.error || null,
        });
      }
      break;
    }

    case 'yeaft_tool_stats':
      // 2026-05-13: relay tool-call counters from the agent to the web
      // client that requested them. Whitelist `snapshot`/`registered`/
      // `unused` so a future schema bump can't leak unrelated fields,
      // and tolerate a `error` field for graceful failure replies.
      for (const [, c] of webClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, {
            type: 'yeaft_tool_stats',
            ...(msg.snapshot && typeof msg.snapshot === 'object' ? { snapshot: msg.snapshot } : { snapshot: {} }),
            ...(Array.isArray(msg.registered) ? { registered: msg.registered } : { registered: [] }),
            ...(Array.isArray(msg.unused) ? { unused: msg.unused } : { unused: [] }),
            ...(msg.error != null ? { error: msg.error } : {}),
          });
        }
      }
      break;

    case 'session_list_updated': {
      // Server-side persistence for yeaft sessions. Mirror the agent's
      // authoritative snapshot into the `yeaft_sessions` table so the
      // unified sidebar can show this user's yeaft sessions across all
      // their agents (online or not) and survive reload. Pure shadow
      // store — agent's on-disk `~/.yeaft/sessions/` remains canonical.
      // Forwarding to the web continues unchanged below.
      // fix-yeaft-session-list-and-menu: decorate the outgoing snapshot
      // with the server-side pin state. The agent has no notion of
      // pinning (pin is UI metadata that lives in the `yeaft_sessions`
      // table); the web sessions store reads `pinned: true` off each
      // row in applySnapshot and mirrors it into chatStore.pinnedSessions
      // so chat + yeaft share a single pin registry for sort logic.
      //
      // Use one batch read (`getByAgent`) and a Set lookup instead of an
      // N+1 `get(id)` per row — relays this size hot path on every
      // snapshot per connected client.
      const syncedEvent = syncYeaftSessionMetadata(agentId, agent, msg);
      const decoratedSessions = syncedEvent.sessions;
      await broadcastSessionCatalog(agent.ownerId);
      // Relay verbatim to web (agentId stamped so the web sessions store
      // can merge per-agent rosters).
      for (const [, c] of webClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, {
            type: msg.type,
            agentId: agentId,
            sessions: decoratedSessions,
            projects: agent.ownerId ? yeaftProjectDb.listForAgent(agent.ownerId, agentId) : [],
            projectsAuthoritative: true,
          });
        }
      }
      break;
    }

    case 'session_roster_changed': {
      // Delta event — update only the affected session row. Same as
      // above: keep the DB shadow + forward to web.
      try {
        if (agent.ownerId && msg) {
          const sessionId = msg.sessionId;
          if (sessionId) {
            const existing = yeaftSessionDb.getForAgent(agent.ownerId, agentId, sessionId);
            // Roster-delta path is a cache update, not authoritative
            // creation. If we've never seen this row before, skip and
            // wait for the next full snapshot (which carries truthful
            // createdAt / workDir / config).
            if (!existing) break;
            const merged = {
              id: sessionId,
              name: msg.name != null ? msg.name : (existing?.name || sessionId),
              roster: Array.isArray(msg.roster)
                ? msg.roster
                : (existing?.roster || []),
              defaultVpId: msg.defaultVpId != null
                ? msg.defaultVpId
                : (existing?.defaultVpId || null),
              workDir: existing?.workDir || '',
              config: existing?.config || {},
              announcement: typeof msg.announcement === 'string'
                ? msg.announcement
                : (existing?.announcement || ''),
              createdAt: existing?.createdAt || Date.now(),
              metadataUpdatedAt: msg.metadataUpdatedAt || existing?.metadataUpdatedAt || existing?.createdAt || null,
            };
            yeaftSessionDb.upsertFromSnapshot(agent.ownerId, agentId, merged);
            await broadcastSessionCatalog(agent.ownerId);
          }
        }
      } catch (e) {
        console.warn(`[Server] yeaft roster persist failed for agent ${agentId}:`, e?.message || e);
      }
      for (const [, c] of webClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, { ...msg, agentId: agentId });
        }
      }
      break;
    }

    case 'session_crud_result': {
      // Surface op result to the web (the only client that cares about
      // requestId routing). Keep the server shadow table in sync for list
      // probes too: entering Yeaft asks each connected agent for its opened
      // sessions, and that response must carry persisted server-side pin
      // state before it hits the web store.
      const syncedMsg = syncYeaftSessionMetadata(agentId, agent, msg);
      const outboundMsg = agent.ownerId
        ? { ...syncedMsg, projects: yeaftProjectDb.listForAgent(agent.ownerId, agentId), projectsAuthoritative: true }
        : { ...syncedMsg, projects: [], projectsAuthoritative: true };
      // CRUD acknowledgements are not authoritative catalog snapshots. The
      // agent emits session_list_updated after mutations; broadcast only after
      // that reconciliation so create/rename cannot briefly project stale data.
      const catalogChanged = outboundMsg?.op === 'list';
      if (catalogChanged) await broadcastSessionCatalog(agent.ownerId);
      for (const [, c] of webClients) {
        if (c.authenticated && (CONFIG.skipAuth || c.userId === agent.ownerId)) {
          await sendToWebClient(c, { ...outboundMsg, agentId: agentId });
        }
      }
      break;
    }

    case 'yeaft_debug_history': {
      // Debug history is request/Turn scoped and may contain raw provider or
      // tool payloads. The Server registered this Agent + requestId after the
      // compound Session ownership check, so rolling upgrades remain safe even
      // when an older Agent does not echo the private browser client id.
      const pending = consumeYeaftDebugRequest({
        agentId,
        requestId: msg.requestId,
        sessionId: msg.sessionId,
      });
      const targetClient = pending ? webClients.get(pending.clientId) : null;
      const ownerMatches = CONFIG.skipAuth || (
        pending?.userId === agent.ownerId
        && targetClient?.userId === pending.userId
      );
      if (targetClient?.authenticated && ownerMatches) {
        await sendToWebClient(targetClient, {
          type: 'yeaft_debug_history',
          agentId,
          loops: Array.isArray(msg.loops) ? msg.loops : [],
          turns: Array.isArray(msg.turns) ? msg.turns : [],
          dreamEvents: Array.isArray(msg.dreamEvents) ? msg.dreamEvents : [],
          ...(msg.projection && typeof msg.projection === 'object' ? { projection: msg.projection } : {}),
          ...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
          ...(msg.threadId != null ? { threadId: msg.threadId } : {}),
          ...(msg.requestId != null ? { requestId: msg.requestId } : {}),
          ...(msg.requestKind != null ? { requestKind: msg.requestKind } : {}),
          ...(msg.search != null ? { search: msg.search } : {}),
          ...(msg.hasMore != null ? { hasMore: !!msg.hasMore } : {}),
          ...(msg.limit != null ? { limit: msg.limit } : {}),
          ...(msg.indexOnly != null ? { indexOnly: !!msg.indexOnly } : {}),
          ...(msg.detailTurnId != null ? { detailTurnId: msg.detailTurnId } : {}),
          ...(msg.error != null ? { error: msg.error } : {}),
        });
      }
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
