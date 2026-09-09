import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import {
  sessionDb,
  messageDb,
  userDb,
  yeaftProjectDb,
  yeaftSessionDb,
  sessionUiMetadataDb,
} from '../database.js';
import {
  agents,
  deleteYeaftDebugRequest,
  pendingFiles,
  registerYeaftDebugRequest,
  trackUserTurn,
  webClients,
} from '../context.js';
import {
  sendToWebClient, forwardToAgent,
  broadcastAgentList, broadcastSessionCatalog, buildSessionCatalog, buildHiddenSessionCatalog,
  verifyConversationOwnership, verifyAgentOwnership
} from '../ws-utils.js';
import { routeSessionPin } from './session-pin-router.js';
import { recordPerfTraceEvent } from '../perf-trace.js';
import {
  chatCatalogKey,
  yeaftCatalogKey,
} from '../session-catalog.js';
import {
  agentSupportsYeaftPlugins,
  YEAFT_PLUGINS_UNSUPPORTED_ERROR,
} from '../yeaft-plugin-capability.js';
import {
  agentSupportsYeaftManagedSkills,
  YEAFT_MANAGED_SKILLS_UNSUPPORTED_ERROR,
} from '../yeaft-managed-skill-capability.js';


function isRetiredCollabSessionId(id) {
  return typeof id === 'string' && id.startsWith('cr' + 'ew_');
}

function emptyYeaftToolStats(reason = '') {
  const payload = {
    type: 'yeaft_tool_stats',
    snapshot: {},
    registered: [],
    unused: [],
  };
  if (reason) payload.notice = reason;
  return payload;
}

function emptyYeaftPluginCatalog(error = null) {
  return {
    type: 'yeaft_plugin_catalog_result',
    catalog: { tools: [], skills: [], mcpServers: [] },
    ...(error ? { error } : {}),
  };
}

function emptyYeaftManagedSkillResult(error = null) {
  return {
    type: 'yeaft_managed_skill_result',
    catalog: { tools: [], skills: [], skillSources: [], mcpServers: [] },
    ...(error ? { error } : {}),
  };
}

async function sendVpSnapshotError(client, msg, error) {
  await sendToWebClient(client, {
    type: 'yeaft_output',
    agentId: msg?.agentId || null,
    requestId: msg?.requestId || null,
    event: {
      type: 'vp_snapshot_error',
      error,
    },
  });
}

export async function syncProjectContextsToAgents(userId) {
  try {
    const sessionsByAgent = groupOnlineYeaftSessions(yeaftSessionDb.getByUser(userId));
    await Promise.all(Object.entries(sessionsByAgent).map(async ([agentId, sessions]) => {
      try {
        const contexts = sessions.map(session => ({
          sessionId: session.id,
          projectContext: yeaftProjectDb.contextForSession(userId, agentId, session.id) || {
            projectId: null,
            projectName: null,
            projectInstruction: '',
            sessionIds: [],
          },
        }));
        await forwardToAgent(agentId, {
          type: 'yeaft_project_context_sync',
          contexts,
        });
      } catch (err) {
        console.warn(`[Yeaft] Project context sync failed for Agent ${agentId}:`, err?.message || err);
      }
    }));
  } catch (err) {
    console.warn('[Yeaft] Project context sync failed:', err?.message || err);
  }
}

async function broadcastSessionPin(userId, payload) {
  for (const [, target] of webClients) {
    if (!target?.authenticated) continue;
    if (!CONFIG.skipAuth && target.userId !== userId) continue;
    await sendToWebClient(target, payload);
  }
}

function persistSessionPin(userId, routeRef, pinned) {
  const { runtimeProvider, agentId, sessionId } = routeRef;
  const catalogKey = runtimeProvider === 'yeaft'
    ? yeaftCatalogKey(agentId, sessionId)
    : chatCatalogKey(sessionId);
  const current = sessionUiMetadataDb.get(userId, catalogKey);
  return sessionUiMetadataDb.applyBatch(userId, [{
    catalogKey,
    runtimeProvider,
    agentId,
    sessionId,
    pinned,
    sortRank: current?.sortRank ?? null,
  }]);
}

function catalogMetadataUpdates(rows) {
  const seen = new Set();
  const updates = [];
  for (const row of rows) {
    const routeRef = row?.routeRef;
    if (!row?.catalogKey || seen.has(row.catalogKey)
        || !routeRef?.runtimeProvider || !routeRef?.agentId || !routeRef?.sessionId) return null;
    seen.add(row.catalogKey);
    updates.push({
      catalogKey: row.catalogKey,
      runtimeProvider: routeRef.runtimeProvider,
      agentId: routeRef.agentId,
      sessionId: routeRef.sessionId,
      pinned: row.pinned === true,
      hidden: row.hidden === true,
      sortRank: updates.length,
    });
  }
  return updates;
}

function catalogOrderUpdates(client, items) {
  if (!client?.userId || !Array.isArray(items) || items.length === 0) return null;
  const canonical = buildSessionCatalog(client.userId, client.role);
  const hidden = buildHiddenSessionCatalog(client.userId, client.role);
  if (canonical.length !== items.length) return null;
  const canonicalByKey = new Map(canonical.map(row => [row.catalogKey, row]));
  if (canonicalByKey.size !== canonical.length) return null;

  const seen = new Set();
  const orderedVisible = [];
  for (const item of items) {
    const row = canonicalByKey.get(item?.catalogKey);
    const routeRef = item?.routeRef;
    if (!row || seen.has(item.catalogKey)
        || routeRef?.runtimeProvider !== row.routeRef?.runtimeProvider
        || routeRef?.agentId !== row.routeRef?.agentId
        || routeRef?.sessionId !== row.routeRef?.sessionId) return null;
    seen.add(item.catalogKey);
    orderedVisible.push(row);
  }
  if (seen.size !== canonical.length) return null;

  // Hidden rows are deliberately absent from a drag payload, but their stale
  // ranks must not collide with the newly ordered visible catalog when they
  // are restored. Normalize both sets in the same transaction, preserving the
  // visible order chosen by the client and the current hidden-row order.
  return catalogMetadataUpdates([...orderedVisible, ...hidden]);
}

function catalogVisibilityUpdates(client, row, hidden) {
  if (!client?.userId || !row?.catalogKey || !row?.routeRef) return null;
  const visible = buildSessionCatalog(client.userId, client.role);
  const hiddenRows = buildHiddenSessionCatalog(client.userId, client.role);
  const visibleByKey = new Map(visible.map(item => [item.catalogKey, item]));
  const hiddenByKey = new Map(hiddenRows.map(item => [item.catalogKey, item]));
  if (visibleByKey.size !== visible.length || hiddenByKey.size !== hiddenRows.length) return null;

  if (hidden) {
    const visibleRow = visibleByKey.get(row.catalogKey);
    if (!visibleRow || hiddenByKey.has(row.catalogKey)) return null;
    return catalogMetadataUpdates([
      ...visible.filter(item => item.catalogKey !== row.catalogKey),
      { ...visibleRow, hidden: true },
      ...hiddenRows,
    ]);
  }

  const hiddenRow = hiddenByKey.get(row.catalogKey);
  if (!hiddenRow || visibleByKey.has(row.catalogKey)) return null;

  // The UI adds a restored Session after the visible list. Keep that policy on
  // the server and also normalize any still-hidden rows, so no stale rank can
  // collide with this restored row during a later refresh or restore.
  const restored = { ...hiddenRow, hidden: false };
  const remainingHidden = hiddenRows.filter(item => item.catalogKey !== restored.catalogKey);
  return catalogMetadataUpdates([...visible, restored, ...remainingHidden]);
}

export function groupOnlineYeaftSessions(rows, agentRegistry = agents) {
  const byAgent = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.agentId) continue;
    const agent = agentRegistry.get(row.agentId);
    if (!agent || agent.ws?.readyState !== 1) continue;
    (byAgent[row.agentId] ||= []).push(row);
  }
  return byAgent;
}

/**
 * Review C1 (Fowler): the frontend stamps a `clientMessageId` on
 * every `chat` payload (see web/stores/helpers/conversation.js#
 * makeClientMessageId). The server is REQUIRED to round-trip the
 * id unchanged, but must NOT trust its shape — a hostile client
 * could otherwise stash a 10 MB string on `convInfo`, persist it
 * to the messages.metadata column, broadcast it to every web
 * subscriber, and replay it on every history hydrate.
 *
 * Format constraint matches `crypto.randomUUID()` output prefixed
 * with `cm_`: `cm_<8>-<4>-<4>-<4>-<12>` (36 hex chars + 4 dashes
 * + 3 fixed bytes = 39 chars total inside the prefix → 42 total).
 * Allow a tolerant superset for forward-compat (any id-safe
 * character, capped at 80 chars) so a future format bump doesn't
 * have to ship in lockstep.
 */
function isValidClientMessageId(s) {
  return typeof s === 'string' && /^cm_[a-zA-Z0-9_-]{1,80}$/.test(s);
}

function skippedYeaftDreamResult(msg, reason) {
  const payload = {
    type: 'yeaft_dream_result',
    success: false,
    skipped: true,
    skippedReason: reason,
    trigger: msg?.trigger || 'manual',
    error: null,
  };
  if (msg?.sessionId) payload.sessionId = msg.sessionId;
  if (msg?.vpId) payload.vpId = msg.vpId;
  return payload;
}

/**
 * Handle conversation lifecycle messages from web client.
 * Types: get_agents, select_agent, create_conversation, resume_conversation,
 *        delete_conversation, select_conversation, sync_messages, chat,
 *        get_conversations, list_history_sessions, list_folders,
 *        cancel_execution, refresh_conversation,
 *        update_conversation_settings, ask_user_answer, btw_question
 */
export async function handleClientConversation(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'get_agents':
      // 前端可能附带 conversationIds（server 重启后恢复场景）
      if (msg.conversationIds?.length > 0 && client.userId) {
        for (const convId of msg.conversationIds) {
          if (isRetiredCollabSessionId(convId)) continue;
          const dbSession = sessionDb.get(convId);
          if (!dbSession) continue;
          if (dbSession.user_id && dbSession.user_id !== client.userId && !CONFIG.skipAuth) continue;
          const agent = agents.get(dbSession.agent_id);
          if (!agent) continue;
          if (agent.conversations.has(convId)) continue;
          agent.conversations.set(convId, {
            id: convId,
            workDir: dbSession.work_dir,
            claudeSessionId: dbSession.claude_session_id,
            title: dbSession.title,
            // fix-chat-title-sticky: hydrate sticky bit from DB so the
            // per-message auto-title write at line 351 can't clobber a
            // user-renamed title after a server-restart restore.
            customTitle: !!dbSession.customTitle,
            // fix-copilot-provider-persist: restore the code-agent provider
            // so the UI marker reappears and sends route to the right backend
            // after an agent process restart.
            ...(dbSession.provider ? { provider: dbSession.provider } : {}),
            createdAt: dbSession.created_at,
            userId: dbSession.user_id || client.userId,
            username: client.username,
            fromDb: true
          });
        }
      }
      // Restore all active Chat sessions for this user from DB (cross-client sync).
      if (client.userId) {
        const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - TWO_DAYS_MS;
        const activeSessions = sessionDb.getActiveByUser(client.userId);
        for (const dbSession of activeSessions) {
          if (isRetiredCollabSessionId(dbSession.id)) continue;
          // Pinned sessions never auto-expire
          if (dbSession.is_pinned) {
            // Still need to restore pinned sessions to agent memory
          } else if (dbSession.updated_at < cutoff) {
            // Auto-deactivate stale sessions (not updated in 2 days)
            try { sessionDb.setActive(dbSession.id, false); } catch (e) { /* ignore */ }
            continue;
          }
          const agent = agents.get(dbSession.agent_id);
          if (!agent) continue;
          if (agent.conversations.has(dbSession.id)) continue;
          // For sessions with user_id IS NULL: only restore if agent belongs to this user
          // or skipAuth is enabled (prevents leaking orphan sessions to wrong users)
          if (!dbSession.user_id && !CONFIG.skipAuth && agent.ownerId !== client.userId) continue;
          agent.conversations.set(dbSession.id, {
            id: dbSession.id,
            workDir: dbSession.work_dir,
            claudeSessionId: dbSession.claude_session_id,
            title: dbSession.title,
            // fix-chat-title-sticky: same hydration as the
            // conversationIds branch above.
            customTitle: !!dbSession.customTitle,
            // fix-copilot-provider-persist: same provider restore as above.
            ...(dbSession.provider ? { provider: dbSession.provider } : {}),
            createdAt: dbSession.created_at,
            userId: dbSession.user_id || client.userId,
            username: client.username,
            fromDb: true
          });
        }
      }
      // Yeaft session rows are only actionable while their owning Agent is
      // connected. Keep offline rows in the DB for reconnect recovery, but do
      // not hydrate them into the sidebar where remove/settings cannot work.
      // Send every authoritative slice before a single completion frame; the UI
      // must not promote a partial multi-Agent inventory to its visible state.
      let hydrateError = null;
      try {
        if (!client.userId) throw new Error('session owner unavailable');
        const allRows = yeaftSessionDb.getByUser(client.userId);
        const byAgent = groupOnlineYeaftSessions(allRows);
        for (const [agentId, agent] of agents) {
          const visible = agent?.ws?.readyState === 1 && (
            CONFIG.skipAuth
            || agent.ownerId === client.userId
            || (!agent.ownerId && client.role === 'admin')
          );
          if (visible && !byAgent[agentId]) byAgent[agentId] = [];
        }
        for (const [agentId, sessions] of Object.entries(byAgent)) {
          await sendToWebClient(client, {
            type: 'yeaft_session_hydrate',
            ...(typeof msg.requestId === 'string' && msg.requestId ? { requestId: msg.requestId } : {}),
            agentId,
            sessions,
            fromDb: true,
          });
        }
        if (Object.keys(byAgent).length === 0) {
          await sendToWebClient(client, {
            type: 'yeaft_session_hydrate',
            ...(typeof msg.requestId === 'string' && msg.requestId ? { requestId: msg.requestId } : {}),
            agentId: null,
            sessions: [],
            fromDb: true,
          });
        }
      } catch (e) {
        hydrateError = e?.message || String(e);
        console.warn('[Server] yeaft session hydrate failed:', hydrateError);
      }
      await broadcastAgentList();
      await sendToWebClient(client, {
        type: 'yeaft_session_hydrate_complete',
        ...(typeof msg.requestId === 'string' && msg.requestId ? { requestId: msg.requestId } : {}),
        ok: hydrateError === null,
        ...(hydrateError ? { error: hydrateError } : {}),
      });
      break;

    case 'select_agent': {
      const silentSelection = msg.silent === true;
      const explicitGenerationAtStart = Number(client.agentSelectionGeneration || 0);
      let selectionGeneration;
      if (silentSelection) {
        // Background reconnect/restore is advisory. It cannot supersede a user
        // selection, but concurrent silent restores still obey newest-wins.
        if (client.pendingAgentSelectionGeneration != null) break;
        selectionGeneration = Number(client.silentAgentSelectionGeneration || 0) + 1;
        client.silentAgentSelectionGeneration = selectionGeneration;
      } else {
        selectionGeneration = explicitGenerationAtStart + 1;
        client.agentSelectionGeneration = selectionGeneration;
        client.pendingAgentSelectionGeneration = selectionGeneration;
      }
      const selectionIsCurrent = () => silentSelection
        ? client.pendingAgentSelectionGeneration == null
          && Number(client.agentSelectionGeneration || 0) === explicitGenerationAtStart
          && client.silentAgentSelectionGeneration === selectionGeneration
        : client.agentSelectionGeneration === selectionGeneration
          && client.pendingAgentSelectionGeneration === selectionGeneration;
      try {
        const allowed = await checkAgentAccess(msg.agentId);
        if (!selectionIsCurrent()) break;
        if (!allowed) {
          if (typeof msg.requestId === 'string' && msg.requestId) {
            await sendToWebClient(client, {
              type: 'agent_selected', requestId: msg.requestId, agentId: msg.agentId, ok: false,
            });
          }
          break;
        }
        const agent = agents.get(msg.agentId);
        if (agent && agent.ws.readyState === 1 /* WebSocket.OPEN */) {
          client.currentAgent = msg.agentId;
          if (!silentSelection) {
            client.currentConversation = null;
          }

          if (silentSelection) break;

          const filteredConvs = Array.from(agent.conversations.values()).filter(c =>
            CONFIG.skipAuth || !c.userId || c.userId === client.userId
          ).map(c => {
            // fix-chat-title-sticky: lazy-hydrate the title AND the
            // sticky bit on send. This catches conversations rebuilt
            // before the bit was wired through (older code paths,
            if (!c.title || c.customTitle === undefined) {
              const dbSession = sessionDb.get(c.id);
              if (dbSession?.title && !c.title) c.title = dbSession.title;
              if (c.customTitle === undefined) c.customTitle = !!dbSession?.customTitle;
            }
            return c;
          });
          await sendToWebClient(client, {
            type: 'agent_selected',
            ...(typeof msg.requestId === 'string' && msg.requestId ? { requestId: msg.requestId } : {}),
            agentId: msg.agentId,
            agentName: agent.name,
            workDir: agent.workDir,
            capabilities: agent.capabilities || ['terminal', 'file_editor', 'background_tasks'],
            ...(agent.capabilityMetadataProvided === true ? { capabilityMetadataProvided: true } : {}),
            version: agent.version || null,
            conversations: filteredConvs,
            slashCommands: agent.slashCommands || [],
            slashCommandDescriptions: agent.slashCommandDescriptions || {}
          });

          // If slash commands cache is empty, ask Agent to reload from filesystem
          if (!agent.slashCommands?.length) {
            await forwardToAgent(msg.agentId, { type: 'request_slash_commands' });
          }
        } else {
          await sendToWebClient(client, { type: 'error', message: 'Agent not found or offline' });
          if (typeof msg.requestId === 'string' && msg.requestId) {
            await sendToWebClient(client, {
              type: 'agent_selected', requestId: msg.requestId, agentId: msg.agentId, ok: false,
            });
          }
        }
      } finally {
        if (!silentSelection && client.pendingAgentSelectionGeneration === selectionGeneration) {
          client.pendingAgentSelectionGeneration = null;
        }
      }
      break;
    }

    case 'create_conversation': {
      const createAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(createAgentId)) return;
      const createAgent = agents.get(createAgentId);
      if (!createAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        return;
      }
      if (createAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }
      client.currentAgent = createAgentId;
      await forwardToAgent(createAgentId, {
        type: 'create_conversation',
        conversationId: msg.conversationId || randomUUID(),
        workDir: msg.workDir,
        userId: client.userId,
        username: client.username,
        provider: msg.provider,
        providerOptions: msg.providerOptions,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'resume_conversation': {
      const resumeAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(resumeAgentId)) return;
      const resumeAgent = agents.get(resumeAgentId);
      if (!resumeAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        return;
      }
      if (resumeAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }
      // fix-copilot-provider-persist: the web's auto-restore / recovery
      // resume paths (web/stores/helpers/session.js) send no provider, and
      // the agent's resume handler defaults an absent provider to
      // 'claude-code'. Without the persisted fallback here, resuming a
      // copilot conversation would emit conversation_resumed{provider:
      // 'claude-code'} and the persist path would CLOBBER the stored
      // 'copilot' binding — reintroducing the bug, permanently. Inject the
      // persisted provider so a provider-less resume keeps the real one.
      const persistedResume = msg.conversationId ? sessionDb.get(msg.conversationId) : null;
      const liveResume = resumeAgent.conversations?.get(msg.conversationId);
      const resumeProvider = msg.provider || persistedResume?.provider || liveResume?.provider || 'claude-code';
      // A supplied Web ID may only be reused within its existing identity.
      // Check both persisted and live rows before forwarding any destructive resume.
      const bindings = [];
      if (persistedResume) bindings.push({
        agentId: persistedResume.agent_id,
        userId: persistedResume.user_id || agents.get(persistedResume.agent_id)?.ownerId,
        provider: persistedResume.provider,
      });
      if (msg.conversationId) {
        for (const [agentId, agent] of agents) {
          const conversation = agent.conversations?.get(msg.conversationId);
          if (conversation) bindings.push({
            agentId,
            userId: conversation.userId || agent.ownerId,
            provider: conversation.provider || persistedResume?.provider,
          });
        }
      }
      if (bindings.some(binding => binding.agentId !== resumeAgentId ||
        (binding.provider || 'claude-code') !== resumeProvider ||
        (!CONFIG.skipAuth && binding.userId !== client.userId))) {
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      client.currentAgent = resumeAgentId;
      await forwardToAgent(resumeAgentId, {
        type: 'resume_conversation',
        conversationId: msg.conversationId || randomUUID(),
        claudeSessionId: msg.claudeSessionId,
        workDir: msg.workDir,
        userId: client.userId,
        username: client.username,
        provider: resumeProvider,
        providerOptions: msg.providerOptions,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'delete_conversation': {
      const persisted = sessionDb.get(msg.conversationId);
      const deleteAgentId = msg.agentId || persisted?.agent_id || client.currentAgent;
      if (!deleteAgentId) return;
      if (!CONFIG.skipAuth && (!verifyConversationOwnership(msg.conversationId, client.userId, client.role)
        || (agents.has(deleteAgentId) && !verifyAgentOwnership(deleteAgentId, client.userId, client.role))
        || (persisted?.agent_id && persisted.agent_id !== deleteAgentId))) {
        console.warn(`[Security] User ${client.userId} attempted to delete conversation ${msg.conversationId} on agent ${deleteAgentId}`);
        await sendToWebClient(client, {
          type: 'conversation_delete_result',
          requestId: msg.requestId || null,
          conversationId: msg.conversationId,
          agentId: deleteAgentId,
          ok: false,
          error: 'Permission denied',
        });
        return;
      }

      try {
        sessionDb.setActive(msg.conversationId, false);
        sessionUiMetadataDb.deleteForRoute(client.userId, {
          runtimeProvider: persisted?.provider || 'claude-code',
          agentId: deleteAgentId,
          sessionId: msg.conversationId,
        });
        const deleteAgent = agents.get(deleteAgentId);
        deleteAgent?.conversations.delete(msg.conversationId);
        await broadcastAgentList();
        if (deleteAgent?.ws?.readyState === 1) {
          await forwardToAgent(deleteAgentId, {
            type: 'delete_conversation',
            conversationId: msg.conversationId,
          });
        }
        await sendToWebClient(client, {
          type: 'conversation_delete_result',
          requestId: msg.requestId || null,
          conversationId: msg.conversationId,
          agentId: deleteAgentId,
          ok: true,
        });
      } catch (e) {
        console.error('Failed to deactivate session in database:', e.message);
        await sendToWebClient(client, {
          type: 'conversation_delete_result',
          requestId: msg.requestId || null,
          conversationId: msg.conversationId,
          agentId: deleteAgentId,
          ok: false,
          error: e.message,
        });
      }
      break;
    }

    case 'select_conversation':
      if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId, client.role)) {
        console.warn(`[Security] User ${client.userId} attempted to select conversation ${msg.conversationId} they don't own`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      client.currentConversation = msg.conversationId;
      await sendToWebClient(client, {
        type: 'conversation_selected',
        conversationId: msg.conversationId
      });
      break;

    case 'reorder_yeaft_sessions': {
      const globalSessions = Array.isArray(msg.sessions) ? msg.sessions : null;
      const agentId = typeof msg.agentId === 'string' ? msg.agentId : '';
      if (!globalSessions && (!agentId || !Array.isArray(msg.sessionIds))) break;
      if (globalSessions) {
        const agentIds = new Set(globalSessions.map(item => item?.agentId).filter(id => typeof id === 'string' && id));
        const unauthorizedAgentId = [...agentIds].find(id => !verifyAgentOwnership(id, client.userId, client.role));
        if (unauthorizedAgentId) {
          console.warn(`[Server] Unauthorized yeaft session reorder by ${client.userId} for agent ${unauthorizedAgentId}`);
          break;
        }
      } else if (!verifyAgentOwnership(agentId, client.userId, client.role)) {
        console.warn(`[Server] Unauthorized yeaft session reorder by ${client.userId} for agent ${agentId}`);
        break;
      }
      let ok = false;
      try {
        ok = globalSessions
          ? yeaftSessionDb.setOrderForUser(client.userId, globalSessions)
          : yeaftSessionDb.setOrderForAgent(client.userId, agentId, msg.sessionIds);
      } catch (e) {
        console.warn('[Server] yeaftSessionDb reorder failed:', e?.message || e);
      }
      if (ok) await broadcastSessionCatalog(client.userId);
      await sendToWebClient(client, {
        type: 'session_crud_result',
        op: 'reorder',
        requestId: msg.requestId,
        ...(agentId ? { agentId } : {}),
        ok,
      });
      break;
    }

    case 'reorder_session_catalog': {
      if (!client.userId || !Array.isArray(msg.sessions)) break;
      const updates = catalogOrderUpdates(client, msg.sessions);
      let persisted = false;
      if (updates) {
        try {
          persisted = sessionUiMetadataDb.applyBatch(client.userId, updates);
          if (persisted) await broadcastSessionCatalog(client.userId);
        } catch (e) {
          console.warn('[Server] Session catalog reorder failed:', e?.message || e);
        }
      }
      await sendToWebClient(client, {
        type: 'session_catalog_reorder_result',
        requestId: msg.requestId || null,
        ok: persisted,
        ...(!persisted ? { error: 'Permission denied or stale Session route' } : {}),
      });
      break;
    }

    case 'set_session_ui_metadata': {
      if (!client.userId || !msg.catalogKey || !msg.routeRef?.runtimeProvider) break;
      const { runtimeProvider, agentId, sessionId } = msg.routeRef;
      let expectedCatalogKey = null;
      let sessionRow = null;
      if (runtimeProvider === 'yeaft') {
        sessionRow = agentId && sessionId
          ? yeaftSessionDb.getForAgent(client.userId, agentId, sessionId)
          : null;
        if (sessionRow) expectedCatalogKey = yeaftCatalogKey(agentId, sessionId);
      } else if (runtimeProvider === 'claude-code' || runtimeProvider === 'copilot') {
        sessionRow = sessionId ? sessionDb.get(sessionId) : null;
        if (agentId && sessionId
          && (CONFIG.skipAuth || verifyConversationOwnership(sessionId, client.userId, client.role))
          && sessionRow?.agent_id === agentId
          && (sessionRow.provider || 'claude-code') === runtimeProvider) {
          expectedCatalogKey = chatCatalogKey(sessionId);
        }
      }
      const authorized = expectedCatalogKey === msg.catalogKey;
      let currentMetadata = null;
      if (authorized) {
        try {
          currentMetadata = sessionUiMetadataDb.get(client.userId, expectedCatalogKey);
        } catch (e) {
          console.warn('[Server] Session metadata read failed:', e?.message || e);
        }
      }
      const persistedPinned = runtimeProvider === 'yeaft'
        ? (sessionRow?.pinned === true || sessionRow?.isPinned === true)
        : sessionRow?.is_pinned === 1;
      const nextPinned = typeof msg.pinned === 'boolean'
        ? msg.pinned
        : (currentMetadata?.pinned ?? !!persistedPinned);
      const hasHidden = typeof msg.hidden === 'boolean';
      const nextHidden = hasHidden
        ? msg.hidden
        : currentMetadata?.hidden === true;
      const nextSortRank = Number.isFinite(msg.sortRank)
        ? msg.sortRank
        : (currentMetadata?.sortRank ?? null);
      const hasSortRank = Object.prototype.hasOwnProperty.call(msg, 'sortRank');
      let persisted = false;
      if (authorized) {
        try {
          // Only an explicit hidden mutation changes catalog membership. A
          // pinned-only first update has no metadata row yet, so comparing an
          // implicit undefined state to false would incorrectly treat it as a
          // restore and reject the valid visible route.
          const visibilityChanged = hasHidden && (currentMetadata?.hidden === true) !== nextHidden;
          const updates = visibilityChanged
            ? catalogVisibilityUpdates(client, {
              catalogKey: expectedCatalogKey,
              routeRef: { runtimeProvider, agentId, sessionId },
            }, nextHidden)
            : [{
              catalogKey: expectedCatalogKey,
              runtimeProvider,
              agentId,
              sessionId,
              pinned: nextPinned,
              hidden: nextHidden,
              ...(hasSortRank ? { sortRank: nextSortRank } : {}),
            }];
          persisted = updates ? sessionUiMetadataDb.applyBatch(client.userId, updates) : false;
          if (persisted) await broadcastSessionCatalog(client.userId);
        } catch (e) {
          console.warn('[Server] Session metadata update failed:', e?.message || e);
        }
      }
      await sendToWebClient(client, {
        type: 'session_ui_metadata_updated',
        requestId: msg.requestId || null,
        ok: persisted,
        catalogKey: msg.catalogKey,
        routeRef: msg.routeRef,
        ...(persisted ? {
          pinned: nextPinned,
          hidden: nextHidden,
          sortRank: nextSortRank,
        } : { error: 'Permission denied or stale Session route' }),
      });
      break;
    }

    case 'pin_session':
    case 'unpin_session': {
      // fix-yeaft-session-list-and-menu: yeaft sessions live in a
      // separate `yeaft_sessions` table (with its own user_id column),
      // not in `sessions`. The pure router decides which table owns
      // the id and whether the caller is authorized; this handler is
      // only responsible for executing the chosen DB write + replying.
      // Tests cover the router directly (see session-pin-router.js).
      const explicitYeaftAgentId = msg.sessionKind === 'yeaft' && msg.agentId ? msg.agentId : null;
      if (explicitYeaftAgentId && !msg.conversationId) break;
      if (explicitYeaftAgentId) {
        if (!verifyAgentOwnership(explicitYeaftAgentId, client.userId, client.role)) {
          console.warn(`[Server] Unauthorized yeaft pin ${msg.conversationId} by ${client.userId}`);
          break;
        }
        const isPinned = msg.type === 'pin_session';
        try {
          const row = yeaftSessionDb.getForAgent(client.userId, explicitYeaftAgentId, msg.conversationId);
          if (!row || !persistSessionPin(client.userId, {
            runtimeProvider: 'yeaft',
            agentId: explicitYeaftAgentId,
            sessionId: msg.conversationId,
          }, isPinned)) {
            console.warn(`[Server] Unauthorized yeaft pin ${msg.conversationId} by ${client.userId}`);
            break;
          }
        } catch (e) {
          console.warn(`[Server] Yeaft Session pin failed for ${msg.conversationId}:`, e?.message || e);
          break;
        }
        await broadcastSessionPin(client.userId, {
          type: 'session_pinned',
          conversationId: msg.conversationId,
          agentId: explicitYeaftAgentId,
          sessionKind: 'yeaft',
          pinned: isPinned,
        });
        await broadcastSessionCatalog(client.userId);
        break;
      }

      const route = routeSessionPin(
        {
          getYeaftRows: (id) => yeaftSessionDb.getAllById(id),
          verifyChatOwnership: (id, userId) => verifyConversationOwnership(id, userId, client.role),
          skipAuth: CONFIG.skipAuth,
        },
        client,
        msg,
      );
      if (route.kind === 'noop') break;
      if (route.kind === 'denied') {
        if (route.reason === 'yeaft-foreign') {
          console.warn(`[Security] User ${client.userId} attempted to pin yeaft session ${route.id} they don't own`);
        }
        break;
      }
      if (route.kind === 'yeaft') {
        try {
          persistSessionPin(client.userId, {
            runtimeProvider: 'yeaft',
            agentId: route.agentId,
            sessionId: route.id,
          }, route.isPinned);
        } catch (e) {
          console.warn(`[Server] Yeaft Session pin failed for ${route.id}:`, e?.message || e);
          break;
        }
        await sendToWebClient(client, {
          type: 'session_pinned',
          conversationId: route.id,
          agentId: route.agentId,
          sessionKind: 'yeaft',
          pinned: route.isPinned,
        });
        await broadcastSessionCatalog(client.userId);
        break;
      }
      // route.kind === 'chat'
      try {
        const row = sessionDb.get(route.id);
        persistSessionPin(client.userId, {
          runtimeProvider: row?.provider || 'claude-code',
          agentId: row?.agent_id || null,
          sessionId: route.id,
        }, route.isPinned);
        // If pinning, also ensure session is active (reactivate if it was auto-deactivated)
        if (route.isPinned) sessionDb.setActive(route.id, true);
      } catch (e) { break; }
      await sendToWebClient(client, { type: 'session_pinned', conversationId: route.id, pinned: route.isPinned });
      await broadcastSessionCatalog(client.userId);
      break;
    }

    case 'sync_messages':
      if (msg.conversationId) {
        if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId, client.role)) {
          console.warn(`[Security] User ${client.userId} attempted to sync messages for conversation ${msg.conversationId} they don't own`);
          return;
        }
        try {
          let messages, hasMore;

          if (msg.turns) {
            if (msg.beforeId) {
              const result = messageDb.getTurnsBeforeId(msg.conversationId, msg.beforeId, msg.turns);
              messages = result.messages;
              hasMore = result.hasMore;
            } else {
              const result = messageDb.getRecentTurns(msg.conversationId, msg.turns);
              messages = result.messages;
              hasMore = result.hasMore;
            }
          } else {
            const limit = msg.limit || 100;
            if (msg.beforeId) {
              messages = messageDb.getBeforeId(msg.conversationId, msg.beforeId, limit);
            } else if (msg.afterMessageId !== undefined && msg.afterMessageId !== null) {
              // perf-chat-session-switch-cache: explicit nullish check so a
              // legitimate cursor of 0 (unlikely with AUTOINCREMENT but no
              // reason to encode the assumption here) doesn't fall through
              // to the cold-load branch and re-send the entire window.
              messages = messageDb.getAfterId(msg.conversationId, msg.afterMessageId);
            } else {
              messages = messageDb.getRecent(msg.conversationId, limit);
            }
            const oldestId = messages.length > 0 ? messages[0].id : null;
            hasMore = oldestId ? messageDb.getBeforeId(msg.conversationId, oldestId, 1).length > 0 : false;
          }

          const total = messageDb.getCount(msg.conversationId);
          console.log(`[sync_messages] Found ${messages.length} messages (total=${total}, hasMore=${hasMore})`);
          const mode = msg.afterMessageId !== undefined && msg.afterMessageId !== null
            ? 'delta'
            : (msg.beforeId ? 'older' : 'recent');
          await sendToWebClient(client, {
            type: 'sync_messages_result',
            conversationId: msg.conversationId,
            catalogKey: chatCatalogKey(msg.conversationId),
            requestId: msg.requestId || null,
            mode,
            cursor: msg.beforeId ?? msg.afterMessageId ?? null,
            afterMessageId: msg.afterMessageId ?? null,
            messages,
            hasMore,
            total
          });
        } catch (e) {
          console.error('Failed to sync messages:', e.message);
        }
      }
      break;

    case 'chat': {
      // Support explicit conversationId for multi-column mode
      const convId = msg.conversationId || client.currentConversation;
      if (!convId) {
        await sendToWebClient(client, { type: 'error', message: 'No conversation selected' });
        return;
      }

      // Ownership check when explicit conversationId is provided
      if (msg.conversationId && !CONFIG.skipAuth) {
        if (!verifyConversationOwnership(msg.conversationId, client.userId, client.role)) {
          await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
          return;
        }
      }

      // Find the agent that owns this conversation
      let chatAgentId = client.currentAgent;
      let chatAgent = agents.get(chatAgentId);
      let convInfo = chatAgent?.conversations.get(convId);

      // If conversation not found on current agent, search all agents
      if (!convInfo && msg.conversationId) {
        for (const [agentId, agent] of agents) {
          if (agent.conversations.has(convId)) {
            chatAgentId = agentId;
            chatAgent = agent;
            convInfo = agent.conversations.get(convId);
            break;
          }
        }
      }

      if (!chatAgentId || !chatAgent) {
        await sendToWebClient(client, { type: 'error', message: 'No agent available' });
        return;
      }

      if (!await checkAgentAccess(chatAgentId)) return;

      if (chatAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }

      // fix-copilot-provider-persist: tell the agent which provider this
      // conversation uses. After an agent process restart the agent's
      // in-memory ctx.conversations is empty, so handleUserInput can't know
      // the conv was copilot — without this it falls back to the default
      // (claude-code), skips the ACP self-heal branch, and the send dies.
      // Prefer the live in-memory value; fall back to the persisted column.
      const resolvedProvider = convInfo?.provider || sessionDb.get(convId)?.provider || undefined;

      // 处理附件
      const fileIds = msg.fileIds || [];
      let resolvedFiles = [];
      if (fileIds.length > 0) {
        for (const fileId of fileIds) {
          const file = pendingFiles.get(fileId);
          if (file && (!file.userId || CONFIG.skipAuth || file.userId === client.userId)) {
            resolvedFiles.push({
              name: file.name,
              mimeType: file.mimeType,
              data: file.buffer.toString('base64')
            });
            pendingFiles.delete(fileId);
          } else if (file && file.userId !== client.userId) {
            console.warn(`[Security] User ${client.userId} attempted to use file ${fileId} owned by ${file.userId}`);
          }
        }
      }

      if (convInfo) convInfo.processing = true;
      trackUserTurn(client.userId, Buffer.byteLength(JSON.stringify(msg)));

      // 暂存 expertSelections 供 agent-output 保存 user 消息时使用
      if (msg.expertSelections?.length > 0 && convInfo) {
        convInfo._pendingExperts = msg.expertSelections;
      }

      // fix-usermsg-dup: stash the client-stamped id so agent-output can
      // round-trip it on the `claude_output` user echo (it's persisted in
      // the DB row's metadata too so the post-refresh `sync_messages_result`
      // payload carries the same dedup key). Without this, the echo path
      // falls back to content-equality dedup, which loses races after page
      // refresh (the optimistic add competes with the DB-sourced row, both
      // sharing the same text but neither sharing a stable id).
      //
      // Review C1 (Fowler): validate at the trust boundary. The id is
      // opaque to the server but it lands in the DB, the WS broadcast,
      // and the agent's history rebuild — a hostile client must not be
      // able to inject 10 MB strings or SQL-looking payloads. The
      // dedup gate falls back to content-equality cleanly if we drop
      // an invalid id, so failed validation degrades gracefully.
      if (msg.clientMessageId && convInfo && isValidClientMessageId(msg.clientMessageId)) {
        convInfo._pendingClientMessageId = msg.clientMessageId;
      }

      // 用用户输入的 prompt 更新会话标题（跳过用户自定义标题的会话）
      if (msg.prompt && msg.prompt.trim() && !(convInfo?.customTitle)) {
        const title = msg.prompt.trim().substring(0, 100);
        sessionDb.update(convId, { title });
        if (convInfo) convInfo.title = title;
      }

      if (resolvedFiles.length > 0) {
        await forwardToAgent(chatAgentId, {
          type: 'transfer_files',
          conversationId: convId,
          files: resolvedFiles,
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          claudeSessionId: convInfo?.claudeSessionId,
          ...(resolvedProvider ? { provider: resolvedProvider } : {}),
          targetRole: msg.targetRole || null,
          expertSelections: msg.expertSelections || null,
          expertMessage: msg.expertMessage || null
        });
      } else {
        await forwardToAgent(chatAgentId, {
          type: 'execute',
          conversationId: convId,
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          claudeSessionId: convInfo?.claudeSessionId,
          ...(resolvedProvider ? { provider: resolvedProvider } : {}),
          targetRole: msg.targetRole || null,
          expertSelections: msg.expertSelections || null,
          expertMessage: msg.expertMessage || null
        });
      }
      break;
    }

    case 'get_conversations':
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      await forwardToAgent(client.currentAgent, { type: 'get_conversations' });
      break;

    case 'list_history_sessions': {
      const historyAgentId = msg.agentId || client.currentAgent;
      if (!historyAgentId) return;
      if (!await checkAgentAccess(historyAgentId)) return;
      await forwardToAgent(historyAgentId, {
        type: 'list_history_sessions',
        workDir: msg.workDir,
        provider: msg.provider,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'list_folders': {
      const foldersAgentId = msg.agentId || client.currentAgent;
      if (!foldersAgentId) return;
      if (!await checkAgentAccess(foldersAgentId)) return;
      await forwardToAgent(foldersAgentId, {
        type: 'list_folders',
        provider: msg.provider,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'list_models': {
      const modelsAgentId = msg.agentId || client.currentAgent;
      if (!modelsAgentId) return;
      if (!await checkAgentAccess(modelsAgentId)) return;
      await forwardToAgent(modelsAgentId, {
        type: 'list_models',
        provider: msg.provider,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }


    case 'cancel_execution': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const cancelConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(cancelConvId, client.userId, client.role)) {
        console.warn(`[Security] User ${client.userId} cancel denied for ${cancelConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'cancel_execution',
        conversationId: cancelConvId
      });
      break;
    }

    case 'refresh_conversation': {
      const refreshAgent = msg.agentId || client.currentAgent;
      if (!refreshAgent) return;
      if (!await checkAgentAccess(refreshAgent)) return;
      const refreshConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(refreshConvId, client.userId, client.role)) {
        console.warn(`[Security] User ${client.userId} refresh denied for ${refreshConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(refreshAgent, {
        type: 'refresh_conversation',
        conversationId: refreshConvId,
        clientId
      });
      break;
    }

    case 'ping_session': {
      const pingAgent = msg.agentId || client.currentAgent;
      const pingConvId = msg.conversationId;
      if (!pingAgent || !pingConvId) return;
      // Check agent is online first — if not, reply directly
      const pingAgentObj = agents.get(pingAgent);
      if (!pingAgentObj || !pingAgentObj.ws || pingAgentObj.ws.readyState !== 1) {
        await sendToWebClient(client, {
          type: 'pong_session',
          conversationId: pingConvId,
          status: 'agent-offline'
        });
        return;
      }
      // Old agent doesn't support ping_session — reply unsupported
      if (!pingAgentObj.capabilities?.includes('ping_session')) {
        await sendToWebClient(client, {
          type: 'pong_session',
          conversationId: pingConvId,
          status: 'unsupported'
        });
        return;
      }
      await forwardToAgent(pingAgent, {
        type: 'ping_session',
        conversationId: pingConvId,
        clientId
      });
      break;
    }

    case 'update_conversation_settings': {
      const settingsConvId = msg.conversationId || client.currentConversation;
      const settingsRow = settingsConvId ? sessionDb.get(settingsConvId) : null;
      const settingsAgentId = msg.agentId || settingsRow?.agent_id || client.currentAgent;
      if (!settingsConvId || !settingsAgentId) return;
      if (msg.disallowedTools !== undefined && !await checkAgentAccess(settingsAgentId)) return;
      if (!CONFIG.skipAuth && (!verifyConversationOwnership(settingsConvId, client.userId, client.role)
        || (agents.has(settingsAgentId) && !verifyAgentOwnership(settingsAgentId, client.userId, client.role))
        || (settingsRow?.agent_id && settingsRow.agent_id !== settingsAgentId))) {
        console.warn(`[Security] User ${client.userId} settings update denied for ${settingsConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      // Handle custom title (server-local, no agent forwarding needed).
      // fix-chat-title-sticky: persist `is_custom_title` to the DB so the
      // sticky bit survives agent reconnect / server restart / convInfo
      // rebuild. Without this, the per-message auto-title write at
      // line 351 silently clobbers the user's renamed title the next
      // time `convInfo.customTitle` is reset to undefined.
      if (msg.title !== undefined) {
        const titleAgent = agents.get(settingsAgentId);
        const titleConvInfo = titleAgent?.conversations.get(settingsConvId);
        if (msg.title) {
          sessionDb.update(settingsConvId, { title: msg.title, isCustomTitle: 1, metadataChanged: true });
          if (titleConvInfo) { titleConvInfo.title = msg.title; titleConvInfo.customTitle = true; }
        } else {
          // Clearing the custom title returns the session to auto-naming
          // mode — the next user prompt repopulates the title.
          sessionDb.update(settingsConvId, { isCustomTitle: 0, metadataChanged: true });
          if (titleConvInfo) { titleConvInfo.customTitle = false; }
        }
      }
      // Only forward to agent if disallowedTools present
      if (msg.disallowedTools) {
        await forwardToAgent(settingsAgentId, {
          type: 'update_conversation_settings',
          conversationId: settingsConvId,
          disallowedTools: msg.disallowedTools
        });
      }
      if (msg.title !== undefined) await broadcastSessionCatalog(client.userId);
      break;
    }

    case 'ask_user_answer': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const answerConvId = msg.conversationId || client.currentConversation;
      if (!answerConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(answerConvId, client.userId, client.role)) {
        console.warn(`[Security] User ${client.userId} ask_user_answer denied for ${answerConvId}`);
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'ask_user_answer',
        conversationId: answerConvId,
        requestId: msg.requestId,
        answers: msg.answers
      });
      // Persist answered state into the AskUserQuestion tool_use DB record
      try {
        if (answerConvId && msg.requestId) {
          const recent = messageDb.getRecent(answerConvId, 100);
          // Search from newest to oldest for the matching requestId
          let askMsg = null;
          for (let i = recent.length - 1; i >= 0; i--) {
            const m = recent[i];
            if (m.message_type !== 'tool_use' || m.tool_name !== 'AskUserQuestion') continue;
            if (!m.metadata) continue;
            try {
              const meta = JSON.parse(m.metadata);
              if (meta.askRequestId === msg.requestId) { askMsg = m; break; }
            } catch { /* skip */ }
          }
          if (askMsg) {
            const meta = JSON.parse(askMsg.metadata);
            messageDb.updateMetadata(askMsg.id, JSON.stringify({
              ...meta,
              askAnswered: true,
              selectedAnswers: msg.answers
            }));
          }
        }
      } catch (e) {
        // Silent — don't block the main flow
      }
      break;
    }

    case 'btw_question': {
      if (!client.currentAgent) {
        await sendToWebClient(client, { type: 'btw_error', error: 'No agent selected' });
        return;
      }
      if (!await checkAgentAccess(client.currentAgent)) return;
      const btwConvId = msg.conversationId || client.currentConversation;
      if (!btwConvId) {
        await sendToWebClient(client, { type: 'btw_error', error: 'No conversation selected' });
        return;
      }
      if (!CONFIG.skipAuth && !verifyConversationOwnership(btwConvId, client.userId, client.role)) {
        console.warn(`[Security] User ${client.userId} btw_question denied for ${btwConvId}`);
        await sendToWebClient(client, { type: 'btw_error', conversationId: btwConvId, error: 'Permission denied' });
        return;
      }
      trackUserTurn(client.userId, Buffer.byteLength(JSON.stringify(msg)));
      await forwardToAgent(client.currentAgent, {
        type: 'btw_question',
        conversationId: btwConvId,
        question: msg.question,
        btwSessionId: msg.btwSessionId || null
      });
      break;
    }

    case 'perf_trace_events': {
      if (Array.isArray(msg.events)) {
        for (const event of msg.events.slice(0, 100)) {
          recordPerfTraceEvent({
            ...event,
            source: 'web',
            userId: client.userId || null,
          });
        }
      }
      break;
    }

    case 'yeaft_load_history':
    case 'unify_load_history': {
      const histAgentId = msg.agentId || client.currentAgent;
      if (msg.perfTraceId) {
        recordPerfTraceEvent({
          traceId: msg.perfTraceId,
          source: 'server',
          phase: 'relay.resolve_agent',
          at: Date.now(),
          userId: client.userId || null,
          agentId: histAgentId || null,
          sessionId: msg.sessionId || null,
          messageType: 'yeaft_load_history',
        });
      }
      if (!histAgentId) return;
      if (!await checkAgentAccess(histAgentId)) return;
      // Forward the catch-up cursor (afterSeq / afterMessageId) verbatim when
      // present. Without it the agent never takes the cheap delta path and
      // falls back to a full recent-history replay on every reconnect
      // catch-up — re-sending the whole pane instead of an empty delta.
      const forwarded = {
        type: 'yeaft_load_history',
        limit: msg.limit,
        sessionId: msg.sessionId || null,
        ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
        ...(typeof msg.perfTraceId === 'string' ? { perfTraceId: msg.perfTraceId } : {}),
        ...(Number.isFinite(msg.afterSeq) ? { afterSeq: msg.afterSeq } : {}),
        ...(typeof msg.afterMessageId === 'string' ? { afterMessageId: msg.afterMessageId } : {}),
        ...(Number.isFinite(msg.maxRows) ? { maxRows: msg.maxRows } : {}),
        ...(Number.isFinite(msg.maxBytes) ? { maxBytes: msg.maxBytes } : {}),
        ...(typeof msg.streamId === 'string' ? { streamId: msg.streamId } : {}),
        ...(Number.isFinite(msg.revision) ? { revision: msg.revision } : {}),
        _requestClientId: clientId,
      };
      if (forwarded.perfTraceId) {
        recordPerfTraceEvent({
          traceId: forwarded.perfTraceId,
          source: 'server',
          phase: 'relay.forward_to_agent',
          at: Date.now(),
          userId: client.userId || null,
          agentId: histAgentId,
          sessionId: forwarded.sessionId,
          messageType: forwarded.type,
          bytes: Buffer.byteLength(JSON.stringify(forwarded)),
        });
      }
      await forwardToAgent(histAgentId, forwarded);
      break;
    }

    case 'yeaft_fetch_debug_history': {
      // Debug traces can contain raw prompts, provider payloads, and tool
      // output. Treat this as a precise Session-owned request instead of the
      // generic Yeaft relay: require the compound Agent + Session identity and
      // correlate the response back to the requesting browser tab.
      const debugAgentId = msg.agentId;
      const debugSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
      const debugRequestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      if (!debugAgentId || !debugSessionId || !debugRequestId) return;
      if (!await checkAgentAccess(debugAgentId)) return;
      if (!CONFIG.skipAuth && !yeaftSessionDb.getForAgent(client.userId, debugAgentId, debugSessionId)) return;
      const registered = registerYeaftDebugRequest({
        agentId: debugAgentId,
        requestId: debugRequestId,
        sessionId: debugSessionId,
        clientId,
        userId: client.userId,
      });
      if (!registered) {
        await sendToWebClient(client, { type: 'yeaft_debug_history', agentId: debugAgentId, sessionId: debugSessionId, requestId: debugRequestId, error: 'Request rejected: too many pending requests or duplicate requestId.' });
        return;
      }
      try {
        const dispatched = await forwardToAgent(debugAgentId, {
          type: 'yeaft_fetch_debug_history',
          sessionId: debugSessionId,
          requestId: debugRequestId,
          requestKind: msg.requestKind === 'detail' ? 'detail' : 'list',
          limit: typeof msg.limit === 'number' ? msg.limit : 10,
          dreamLimit: typeof msg.dreamLimit === 'number' ? msg.dreamLimit : 5,
          indexOnly: msg.indexOnly === true,
          detailTurnId: typeof msg.detailTurnId === 'string' ? msg.detailTurnId : null,
          search: typeof msg.search === 'string' ? msg.search.slice(0, 500) : '',
          _requestClientId: clientId,
        });
        if (!dispatched) {
          deleteYeaftDebugRequest({ agentId: debugAgentId, requestId: debugRequestId, clientId });
          await sendToWebClient(client, { type: 'yeaft_debug_history', agentId: debugAgentId, sessionId: debugSessionId, requestId: debugRequestId, error: 'Agent is unavailable.' });
        }
      } catch (err) {
        deleteYeaftDebugRequest({ agentId: debugAgentId, requestId: debugRequestId, clientId });
        await sendToWebClient(client, { type: 'yeaft_debug_history', agentId: debugAgentId, sessionId: debugSessionId, requestId: debugRequestId, error: `Failed to send request to Agent: ${err.message}` });
      }
      break;
    }

    case 'yeaft_load_history_outline': {
      const outlineAgentId = msg.agentId;
      const outlineSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
      if (!outlineAgentId || !outlineSessionId) return;
      if (!await checkAgentAccess(outlineAgentId)) return;
      if (!CONFIG.skipAuth && !yeaftSessionDb.getForAgent(client.userId, outlineAgentId, outlineSessionId)) return;
      await forwardToAgent(outlineAgentId, {
        type: 'yeaft_load_history_outline',
        sessionId: outlineSessionId,
        requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
        limit: typeof msg.limit === 'number' ? msg.limit : 50,
        beforeSeq: typeof msg.beforeSeq === 'number' ? msg.beforeSeq : null,
        ...(msg.cursor && typeof msg.cursor === 'object' ? { cursor: msg.cursor } : {}),
        includeTotal: msg.includeTotal === true,
        ...(typeof msg.perfTraceId === 'string' ? { perfTraceId: msg.perfTraceId } : {}),
        _requestClientId: clientId,
      });
      break;
    }

    case 'yeaft_search_history': {
      const searchAgentId = msg.agentId;
      const searchSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
      if (!searchAgentId || !searchSessionId) return;
      if (!await checkAgentAccess(searchAgentId)) return;
      if (!CONFIG.skipAuth && !yeaftSessionDb.getForAgent(client.userId, searchAgentId, searchSessionId)) return;
      await forwardToAgent(searchAgentId, {
        type: 'yeaft_search_history',
        sessionId: searchSessionId,
        requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
        query: typeof msg.query === 'string' ? msg.query.slice(0, 500) : '',
        senderKey: typeof msg.senderKey === 'string' ? msg.senderKey.slice(0, 103) : '',
        limit: typeof msg.limit === 'number' ? msg.limit : 20,
        beforeSeq: typeof msg.beforeSeq === 'number' ? msg.beforeSeq : null,
        ...(msg.cursor && typeof msg.cursor === 'object' ? { cursor: msg.cursor } : {}),
        ...(typeof msg.perfTraceId === 'string' ? { perfTraceId: msg.perfTraceId } : {}),
        _requestClientId: clientId,
      });
      break;
    }

    case 'yeaft_load_history_window': {
      const windowAgentId = msg.agentId;
      const windowSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
      if (!windowAgentId || !windowSessionId) return;
      if (!await checkAgentAccess(windowAgentId)) return;
      if (!CONFIG.skipAuth && !yeaftSessionDb.getForAgent(client.userId, windowAgentId, windowSessionId)) return;
      await forwardToAgent(windowAgentId, {
        type: 'yeaft_load_history_window',
        sessionId: windowSessionId,
        requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
        entryId: typeof msg.entryId === 'string' ? msg.entryId : null,
        indexGeneration: typeof msg.indexGeneration === 'number' ? msg.indexGeneration : null,
        entryStartSeq: typeof msg.entryStartSeq === 'number' ? msg.entryStartSeq : null,
        anchorMessageId: typeof msg.anchorMessageId === 'string' ? msg.anchorMessageId : null,
        anchorSeq: typeof msg.anchorSeq === 'number' ? msg.anchorSeq : null,
        beforeTurns: typeof msg.beforeTurns === 'number' ? msg.beforeTurns : 3,
        afterTurns: typeof msg.afterTurns === 'number' ? msg.afterTurns : 3,
        maxRows: typeof msg.maxRows === 'number' ? msg.maxRows : 200,
        maxBytes: typeof msg.maxBytes === 'number' ? msg.maxBytes : 512 * 1024,
        _requestClientId: clientId,
      });
      break;
    }

    case 'yeaft_load_more_history':
    case 'unify_load_more_history': {
      const moreAgentId = msg.agentId || client.currentAgent;
      if (!moreAgentId) return;
      if (!await checkAgentAccess(moreAgentId)) return;
      await forwardToAgent(moreAgentId, {
        type: 'yeaft_load_more_history',
        sessionId: msg.sessionId || null,
        requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
        beforeSeq: typeof msg.beforeSeq === 'number' ? msg.beforeSeq : null,
        pageKind: msg.pageKind === 'gap' ? 'gap' : 'server',
        gapStopAtSeq: typeof msg.gapStopAtSeq === 'number' ? msg.gapStopAtSeq : null,
        cacheEpoch: typeof msg.cacheEpoch === 'number' ? msg.cacheEpoch : 0,
        turns: typeof msg.turns === 'number' ? msg.turns : 20,
        ...(typeof msg.perfTraceId === 'string' ? { perfTraceId: msg.perfTraceId } : {}),
        _requestClientId: clientId,
      });
      break;
    }

    case 'yeaft_mode_switch':
    case 'unify_mode_switch': {
      const modeAgentId = msg.agentId || client.currentAgent;
      if (!modeAgentId) return;
      if (!await checkAgentAccess(modeAgentId)) return;
      await forwardToAgent(modeAgentId, {
        type: 'yeaft_mode_switch',
        mode: msg.mode,
      });
      break;
    }

    case 'yeaft_model_switch':
    case 'unify_model_switch': {
      const modelAgentId = msg.agentId || client.currentAgent;
      if (!modelAgentId) return;
      if (!await checkAgentAccess(modelAgentId)) return;
      await forwardToAgent(modelAgentId, {
        type: 'yeaft_model_switch',
        model: msg.model,
      });
      break;
    }

    case 'yeaft_reset':
    case 'unify_reset': {
      const resetAgentId = msg.agentId || client.currentAgent;
      if (!resetAgentId) return;
      if (!await checkAgentAccess(resetAgentId)) return;
      await forwardToAgent(resetAgentId, {
        type: 'yeaft_reset',
      });
      break;
    }

    case 'yeaft_project_mutation': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const op = msg.op;
      const respond = async (payload) => {
        await sendToWebClient(client, {
          type: 'yeaft_output',
          agentId: msg.targetAgentId || msg.agentId || client.currentAgent || null,
          event: {
            type: 'project_mutation_result',
            requestId,
            op,
            projectsAuthoritative: true,
            ...payload,
          },
        });
      };
      try {
        if (!client.userId) throw new Error('User identity is required');
        let result = null;
        if (op === 'create') result = yeaftProjectDb.create(client.userId, msg.name);
        else if (op === 'rename') result = yeaftProjectDb.rename(client.userId, msg.projectId, msg.name);
        else if (op === 'update_instruction') {
          result = yeaftProjectDb.updateInstruction(client.userId, msg.projectId, msg.instruction);
        } else if (op === 'delete') result = yeaftProjectDb.delete(client.userId, msg.projectId);
        else if (op === 'reorder') result = yeaftProjectDb.reorder(client.userId, msg.projectIds);
        else if (op === 'move_session') {
          const agentId = msg.targetAgentId || msg.agentId;
          const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
          if (!agentId || !sessionId) throw new Error('Agent and Session identities are required');
          const targetSession = yeaftSessionDb.getForAgent(client.userId, agentId, sessionId);
          if (!targetSession) throw new Error('Session not found');
          if (targetSession.isArchived) {
            const error = new Error('Archived Sessions cannot be moved to Projects');
            error.code = 'session_archived';
            throw error;
          }
          const catalogUpdates = msg.catalogOrder === undefined
            ? null
            : catalogOrderUpdates(client, msg.catalogOrder);
          if (msg.catalogOrder !== undefined && !catalogUpdates) {
            const error = new Error('Complete canonical catalog order is required');
            error.code = 'invalid_catalog_order';
            throw error;
          }
          result = yeaftProjectDb.moveSession(client.userId, {
            agentId,
            sessionId,
            projectId: msg.projectId || null,
            catalogUpdates,
          });
        } else {
          throw new Error('Unknown Project operation');
        }
        const responseAgentId = msg.targetAgentId || msg.agentId || client.currentAgent || null;
        const projects = responseAgentId
          ? yeaftProjectDb.listForAgent(client.userId, responseAgentId)
          : yeaftProjectDb.list(client.userId);
        await respond({ ok: true, result, projects });
        await syncProjectContextsToAgents(client.userId);
        await broadcastSessionCatalog(client.userId);
      } catch (err) {
        await respond({
          ok: false,
          error: {
            code: err?.code || 'project_mutation_failed',
            message: err?.message || String(err),
          },
        });
      }
      break;
    }

    case 'yeaft_merge_thread':
    case 'unify_merge_thread': {
      const mergeAgentId = msg.agentId || client.currentAgent;
      if (!mergeAgentId) return;
      if (!await checkAgentAccess(mergeAgentId)) return;
      await forwardToAgent(mergeAgentId, {
        type: 'yeaft_merge_thread',
        sourceId: msg.sourceId,
        targetId: msg.targetId,
      });
      break;
    }

    case 'yeaft_fork_thread':
    case 'unify_fork_thread': {
      const forkAgentId = msg.agentId || client.currentAgent;
      if (!forkAgentId) return;
      if (!await checkAgentAccess(forkAgentId)) return;
      await forwardToAgent(forkAgentId, {
        type: 'yeaft_fork_thread',
        sourceThreadId: msg.sourceThreadId,
        atMessageId: msg.atMessageId,
        name: msg.name,
      });
      break;
    }

    case 'yeaft_abort_thread':
    case 'unify_abort_thread': {
      // task-325c: relay targeted abort command to the agent. Payload
      // carries `threadId` only — no extra fields. Unknown thread is a
      // silent no-op on the agent side, so we forward unconditionally.
      const abortAgentId = msg.agentId || client.currentAgent;
      if (!abortAgentId) return;
      if (!await checkAgentAccess(abortAgentId)) return;
      await forwardToAgent(abortAgentId, {
        type: 'yeaft_abort_thread',
        threadId: msg.threadId,
      });
      break;
    }

    case 'yeaft_abort_all':
    case 'unify_abort_all': {
      // task-325c: relay abort command. With sessionId present this is scoped
      // to that Yeaft Session; without it, older clients keep the legacy
      // "abort everything" behavior.
      const abortAllAgentId = msg.agentId || client.currentAgent;
      if (!abortAllAgentId) return;
      if (!await checkAgentAccess(abortAllAgentId)) return;
      await forwardToAgent(abortAllAgentId, { type: 'yeaft_abort_all', sessionId: msg.sessionId || null });
      break;
    }

    default: {
      // task-fix: generic relay for all `yeaft_*` messages so any new
      // agent-router case (yeaft_vp_*, yeaft_user_memory_*, yeaft_*_group,
      // yeaft_dream_*, etc.) works without a dedicated server case.
      // Without this, messages like `yeaft_vp_subscribe` arrive at the
      // server, fall through to default, return false, and are silently
      // dropped — which is why the GroupCreateWizard's "VP 加载中..."
      // hung forever.
      if (typeof msg.type === 'string' && (msg.type.startsWith('yeaft_') || msg.type.startsWith('unify_'))) {
        const relayType = msg.type.startsWith('unify_') ? `yeaft_${msg.type.slice('unify_'.length)}` : msg.type;
        const relayAgentId = msg.agentId || client.currentAgent;
        if (msg.perfTraceId) {
          recordPerfTraceEvent({
            traceId: msg.perfTraceId,
            source: 'server',
            phase: 'relay.resolve_agent',
            at: Date.now(),
            userId: client.userId || null,
            agentId: relayAgentId || null,
            sessionId: msg.sessionId || null,
            messageType: relayType,
          });
        }
        if (!relayAgentId) {
          if (relayType === 'yeaft_fetch_tool_stats') {
            await sendToWebClient(client, emptyYeaftToolStats('No agent selected.'));
          } else if (relayType === 'yeaft_dream_trigger') {
            await sendToWebClient(client, skippedYeaftDreamResult(msg, 'no-agent-selected'));
          } else if (relayType === 'yeaft_vp_subscribe') {
            await sendVpSnapshotError(client, msg, 'No Agent is available for the VP library.');
          } else {
            console.warn(
              `[Server] swallowed yeaft message ${relayType} (no agent resolved)`
              + ` userId=${client.userId || '?'}`
            );
          }
          return true; // swallow silently for legacy fire-and-forget messages
        }
        if (!await checkAgentAccess(relayAgentId)) {
          if (relayType === 'yeaft_fetch_tool_stats') {
            await sendToWebClient(client, emptyYeaftToolStats('Agent is not available.'));
          } else if (relayType === 'yeaft_dream_trigger') {
            await sendToWebClient(client, skippedYeaftDreamResult(msg, 'agent-not-available'));
          } else if (relayType === 'yeaft_vp_subscribe') {
            await sendVpSnapshotError(client, msg, 'The selected Agent is not available.');
          }
          return true;
        }
        if (relayType === 'yeaft_plugin_catalog'
            && !agentSupportsYeaftPlugins(agents.get(relayAgentId))) {
          await sendToWebClient(client, {
            ...emptyYeaftPluginCatalog(YEAFT_PLUGINS_UNSUPPORTED_ERROR),
            agentId: relayAgentId,
            requestId: msg.requestId || null,
          });
          return true;
        }
        if (relayType === 'yeaft_managed_skill'
            && !agentSupportsYeaftManagedSkills(agents.get(relayAgentId))) {
          await sendToWebClient(client, {
            ...emptyYeaftManagedSkillResult(YEAFT_MANAGED_SKILLS_UNSUPPORTED_ERROR),
            agentId: relayAgentId,
            requestId: msg.requestId || null,
          });
          return true;
        }
        const relayAgent = agents.get(relayAgentId);
        if (!relayAgent || relayAgent.ws?.readyState !== 1) {
          if (relayType === 'yeaft_fetch_tool_stats') {
            await sendToWebClient(client, emptyYeaftToolStats('Agent is offline.'));
            return true;
          }
          if (relayType === 'yeaft_dream_trigger') {
            await sendToWebClient(client, skippedYeaftDreamResult(msg, 'agent-offline'));
            return true;
          }
          if (relayType === 'yeaft_vp_subscribe') {
            await sendVpSnapshotError(client, msg, 'The selected Agent is offline.');
            return true;
          }
        }
        if (relayType === 'yeaft_fetch_agent_metrics') {
          await forwardToAgent(relayAgentId, { type: 'get_agent_metrics' });
          return true;
        }
        // Forward the entire message minus the agentId field; the agent
        // router is the authoritative consumer of the payload shape.
        const { agentId: _discard, ...rest } = msg;
        rest.type = relayType;
        // Direct catalog replies are request-scoped. Carry the browser client
        // identity through the Agent so another owner tab cannot accidentally
        // consume a response for this picker request.
        if (relayType === 'yeaft_plugin_catalog' || relayType === 'yeaft_managed_skill') {
          rest._requestClientId = clientId;
        }
        if (rest.type === 'yeaft_session_send' || rest.type === 'yeaft_session_chat') {
          trackUserTurn(client.userId, Buffer.byteLength(JSON.stringify(msg)));
          const sessionId = typeof rest.sessionId === 'string' ? rest.sessionId.trim() : '';
          if (sessionId && client.userId) {
            const projectContext = yeaftProjectDb.contextForSession(
              client.userId,
              relayAgentId,
              sessionId,
            );
            rest.projectContext = projectContext || {
              projectId: null,
              projectName: null,
              projectInstruction: '',
              sessionIds: [],
            };
          }
        }

        if (rest.type === 'yeaft_session_chat' && !rest.id) {
          rest.id = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        }

        // Resolve attachment fileIds → base64 BEFORE forwarding, mirroring
        // The agent never sees fileIds — it
        // only handles `files: [{ name, mimeType, data, isImage }]`.
        if (Array.isArray(rest.attachments) && rest.attachments.length > 0) {
          const resolvedFiles = [];
          for (const att of rest.attachments) {
            if (!att || !att.fileId) continue;
            const file = pendingFiles.get(att.fileId);
            if (file && (!file.userId || CONFIG.skipAuth || file.userId === client.userId)) {
              resolvedFiles.push({
                name: file.name,
                mimeType: file.mimeType,
                data: file.buffer.toString('base64'),
                isImage: !!att.isImage || (file.mimeType || '').startsWith('image/'),
              });
              pendingFiles.delete(att.fileId);
            } else if (file && file.userId !== client.userId) {
              console.warn(`[Security] User ${client.userId} attempted to use yeaft file ${att.fileId} owned by ${file.userId}`);
            }
          }
          if (resolvedFiles.length > 0) {
            rest.files = resolvedFiles;
          }
          // Drop the fileId-bearing array so the agent only sees the
          // resolved form on `files`.
          delete rest.attachments;
        }

        if (rest.perfTraceId) {
          recordPerfTraceEvent({
            traceId: rest.perfTraceId,
            source: 'server',
            phase: 'relay.forward_to_agent',
            at: Date.now(),
            userId: client.userId || null,
            agentId: relayAgentId,
            sessionId: rest.sessionId || null,
            messageType: rest.type,
            bytes: Buffer.byteLength(JSON.stringify(rest)),
          });
        }
        await forwardToAgent(relayAgentId, rest);
        return true;
      }
      return false; // Not handled
    }
  }
  return true; // Handled
}
