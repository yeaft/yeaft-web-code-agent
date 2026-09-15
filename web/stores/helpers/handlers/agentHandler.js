/**
 * Agent-related message handlers: agent_list, agent_selected.
 * The most complex handler — includes auto-restore and reconnection logic.
 */

import { isRecentlyClosed, stopProcessingWatchdog } from '../watchdog.js';
import { clearSessionLoading, restorePanels } from '../session.js';
import { maxDbMessageId } from '../messages.js';

/**
 * Decide whether the current Yeaft agent just RESTARTED (a fresh process),
 * given a persisted last-known snapshot and the incoming agent_list.
 *
 * The server DELETES an agent from its map on disconnect
 * (server/ws-agent.js handleAgentDisconnect → agents.delete), so a process
 * restart broadcasts as present(v1) → ABSENT → present(v2): the agent is
 * never reported present-but-`online:false`. We therefore compare against a
 * `seen` snapshot that survives the absent frame, NOT the one-frame-old
 * agent list.
 *
 * Returns true on a restart edge:
 *   - cameBackOnline: we previously saw this agent online, then it went
 *     offline/absent, and now it is online again (covers a plain restart
 *     even with no version change — crash, PM2 bounce, identical redeploy).
 *   - versionChanged: it is online now, was online when last seen, and the
 *     reported version differs (covers a deploy where the absent frame was
 *     coalesced away so we never observed the gap).
 *
 * `seen` is null on cold start (page just loaded / agent never seen) → no
 * edge, since enterYeaft already bootstraps that case.
 *
 * @param {{id:string,online:boolean,version:(string|null)}|null} seen
 * @param {{id:string,online?:boolean,version?:(string|null)}|undefined} next  current agent record (undefined = absent from this frame)
 * @returns {boolean}
 */
export function detectYeaftAgentRestart(seen, next) {
  if (!seen) return false;
  const nextOnline = !!next?.online;
  if (!nextOnline) return false; // absent or offline now → wait for it to come back
  const cameBackOnline = !seen.online;
  const versionChanged = seen.online
    && seen.version != null && next.version != null
    && seen.version !== next.version;
  return cameBackOnline || versionChanged;
}

/**
 * 恢复上次查看的 conversation（公共逻辑）。
 */
export function restoreLastViewedConversation(store, agentSetup) {
  const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
  if (!lastViewed) return false;

  const conv = store.conversations.find(c => c.id === lastViewed);
  if (!conv) return false;

  const agentId = agentSetup?.agentId || store.currentAgent;

  // 设置 agent（AutoRestore 路径需要）
  if (agentSetup) {
    store.currentAgent = agentSetup.agentId;
    store.currentAgentInfo = agentSetup.agentInfo;
    store.sendWsMessage({ type: 'select_agent', agentId: agentSetup.agentId, silent: true });
  }

  // 设置 conversation 状态
  store.activeConversations = [lastViewed];
  store.currentWorkDir = conv.workDir;
  store.messagesMap[lastViewed] = [];
  store.sendWsMessage({ type: 'select_conversation', conversationId: lastViewed });


  store.requestChatHistory?.(lastViewed, { mode: 'recent', turns: 5 });
  store.sendWsMessage({ type: 'refresh_conversation', conversationId: lastViewed });

  return true;
}

/**
 * Handle agent_list message: sync conversations, proxy ports, reconnection.
 */
export function handleAgentList(store, msg) {
  const previousAgents = Array.isArray(store.agents) ? store.agents : [];
  const nextAgents = Array.isArray(msg.agents) ? msg.agents : [];
  const previouslyOnlineAgentIds = new Set(
    previousAgents.filter(agent => agent?.id && agent.online).map(agent => agent.id),
  );
  const nextOnlineAgentIds = new Set(
    nextAgents.filter(agent => agent?.id && agent.online).map(agent => agent.id),
  );
  // The browser↔Server socket remains connected when an Agent process alone
  // drops. Settle requests owned by that Agent on the online→offline edge so a
  // durable copy cannot leave its source Composer locked forever. Cold-start
  // absences and requests for other online Agents are intentionally untouched.
  for (const [requestId, pending] of store._sessionCrudPending?.entries?.() || []) {
    if (!pending?.agentId
        || !previouslyOnlineAgentIds.has(pending.agentId)
        || nextOnlineAgentIds.has(pending.agentId)) continue;
    pending.resolve?.({
      ok: false,
      requestId,
      error: { code: 'agent_offline', message: 'Agent disconnected' },
    });
    store._sessionCrudPending.delete(requestId);
  }
  const hadAgentList = store._hasHandledAgentList === true;
  const previousCurrentAgentId = store.currentAgent || null;
  const previousCurrentAgentOnline = !!(previousCurrentAgentId
    && previousAgents.some(a => a && a.id === previousCurrentAgentId && a.online));
  store.agents = nextAgents;
  store._hasHandledAgentList = true;
  for (const [agentId, operations] of Object.entries(store.agentOperations || {})) {
    const current = nextAgents.find(agent => agent.id === agentId);
    for (const operation of ['restart', 'upgrade']) {
      const state = operations?.[operation];
      if (!state?.pending || !state.acknowledged) continue;
      if (!current?.online) {
        if (!state.sawOffline) {
          store.agentOperations = {
            ...store.agentOperations,
            [agentId]: {
              ...(store.agentOperations[agentId] || {}),
              [operation]: { ...state, sawOffline: true },
            },
          };
        }
        continue;
      }
      const versionChanged = operation === 'upgrade' && state.oldVersion && current.version !== state.oldVersion;
      if (!state.sawOffline && !versionChanged) continue;
      store.finishAgentOperation?.(agentId, operation);
    }
  }

  // Agent-restart detection. When the agent PROCESS restarts (deploy/update
  // or crash), the web↔server websocket never drops, so the onclose-based
  // _yeaftReconnectCatchUpPending latch never fires and visible Yeaft/Work
  // Center state is left stale. Detect the restart edge here and arm the SAME
  // one-shot latch the reconnect-restore branch below already consumes.
  //
  // We diff against a PERSISTED snapshot (`_yeaftAgentSeen`), not the
  // one-frame-old store.agents, because the server deletes an agent on
  // disconnect: a restart is present(v1) → ABSENT → present(v2), and the
  // absent frame would otherwise erase our only prior record. See
  // detectYeaftAgentRestart() for the exact edge semantics.
  //
  // Edge-triggered on purpose (NOT every agent_list): the v0.1.954 loop came
  // from firing the catch-up on every routine broadcast. Steady state (same
  // agent, online, same version, repeated frames) arms nothing.
  const trackedAgentId = store.currentAgent || null;
  if (trackedAgentId) {
    const seen = (store._yeaftAgentSeen && store._yeaftAgentSeen.id === trackedAgentId)
      ? store._yeaftAgentSeen
      : null;
    const nextRec = nextAgents.find(a => a.id === trackedAgentId) || null;
    const needsReconnectCatchUp = store.currentView === 'yeaft'
      || (store.workCenterOpen && store.workCenterAgentId === trackedAgentId);
    if (needsReconnectCatchUp && detectYeaftAgentRestart(seen, nextRec)) {
      store._yeaftReconnectCatchUpPending = true;
    }
    // Update the snapshot every frame so the absent→present gap is bridged.
    // While absent (nextRec null) KEEP the last-known online/version so the
    // reappear frame can still see "was online before". Only overwrite when
    // the agent is present in this frame.
    if (nextRec) {
      store._yeaftAgentSeen = {
        id: trackedAgentId,
        online: !!nextRec.online,
        version: nextRec.version != null ? nextRec.version : null,
      };
    } else if (!seen) {
      // First time we're tracking this agent and it's absent — record the
      // id so a later reappear is recognized as a restart, not a cold start.
      store._yeaftAgentSeen = { id: trackedAgentId, online: false, version: null };
    } else if (seen.online) {
      // Agent dropped out of the list → mark offline but retain the version
      // so a same-version restart is still a cameBackOnline edge next frame.
      store._yeaftAgentSeen = { id: trackedAgentId, online: false, version: seen.version };
    }
  }
  {
    const agentIds = new Set(nextAgents.map(a => a.id));
    for (const agent of nextAgents) {
      store.proxyPorts[agent.id] = agent.proxyPorts || [];
      if (agent.yeaftStatus && typeof store.cacheYeaftAgentStatus === 'function') {
        store.cacheYeaftAgentStatus(agent.id, agent.yeaftStatus);
      }
    }
    for (const id of Object.keys(store.proxyPorts)) {
      if (!agentIds.has(id)) {
        delete store.proxyPorts[id];
      }
    }
  }
  if (store.currentAgent) {
    const agent = nextAgents.find(a => a.id === store.currentAgent);
    if (agent) {
      store.currentAgentInfo = agent;
    }
  }
  // Yeaft can be entered before the first agent_list arrives during page
  // restore. In that case enterYeaft() could not choose an agent and did not
  // send the yeaft_load_history bootstrap, so session_ready/model/history
  // stayed empty until the user clicked another session. When an online agent
  // appears while the Yeaft page is active, pick it here; the existing
  // reconnect branch below sends select_agent and runs the bootstrap in order.
  if (store.currentView === 'yeaft' && !store.currentAgent) {
    const online = nextAgents.find(a => a.online);
    if (online) {
      store.currentAgent = online.id;
      store.currentAgentInfo = online;
    }
  }
  if (store.currentView === 'yeaft' && typeof store.loadOpenedYeaftSessionsForConnectedAgents === 'function') {
    const onlineIds = nextAgents.filter(a => a && a.online && a.id).map(a => a.id);
    store.loadOpenedYeaftSessionsForConnectedAgents(onlineIds);
  }
  // ★ 同步所有 agent 的 conversations 到 store.conversations
  {
    const allServerConvs = [];
    const allServerConvIds = new Set();
    for (const agent of nextAgents) {
      for (const serverConv of (agent.conversations || [])) {
        if (allServerConvIds.has(serverConv.id)) continue;
        allServerConvIds.add(serverConv.id);
        allServerConvs.push({
          ...serverConv,
          type: serverConv.type,
          agentId: agent.id,
          agentName: agent.name
        });
        if (serverConv.title) {
          if (serverConv.customTitle) {
            store.customConversationTitles[serverConv.id] = serverConv.title;
          }
          if (!store.conversationTitles[serverConv.id]) {
            store.conversationTitles[serverConv.id] = serverConv.title;
          }
        }
      }
    }

    for (const serverConv of allServerConvs) {
      serverConv.agentOnline = true;
      const existing = store.conversations.find(c => c.id === serverConv.id);
      if (existing) {
        existing.claudeSessionId = serverConv.claudeSessionId || existing.claudeSessionId;
        existing.processing = serverConv.processing;
        existing.userId = serverConv.userId;
        existing.username = serverConv.username;
        existing.agentId = serverConv.agentId;
        existing.agentName = serverConv.agentName;
        existing.agentOnline = true;
        if (serverConv.type) existing.type = serverConv.type;
        if (serverConv.name !== undefined) existing.name = serverConv.name;
      } else {
        // Skip sessions recently deleted by the user (race condition guard)
        const deletedAt = store._recentlyDeletedSessions?.[serverConv.id];
        if (deletedAt && (Date.now() - deletedAt) < 15000) continue;
        store.conversations.push(serverConv);
      }
      // Sync pin state from server (server is source of truth)
      if (serverConv.pinned && !store.pinnedSessions.includes(serverConv.id)) {
        store.pinnedSessions.push(serverConv.id);
      }
    }
    // ★ Remove stale conversations no longer reported by the server.
    // If a session's agent is in the agent_list but the session is NOT,
    // the server has actively removed it (is_active=0 in DB or agent cleaned up).
    // Previously this just set agentOnline=true which kept dead sessions visible forever.
    const listedAgentIds = new Set(nextAgents.map(a => a.id));
    store.conversations = store.conversations.filter(conv => {
      if (allServerConvIds.has(conv.id)) return true; // still in server list
      // Don't remove conversations the user is currently viewing
      if (store.activeConversations.includes(conv.id)) return true;
      // Session's agent is in the agent_list but session is not → stale, remove
      if (conv.agentId && listedAgentIds.has(conv.agentId)) {
        // Respect recently-deleted guard (prevent flicker on close → agent_list race)
        const deletedAt = store._recentlyDeletedSessions?.[conv.id];
        if (deletedAt && (Date.now() - deletedAt) < 15000) return false; // already being deleted
        console.log(`[agent_list] Removing stale session ${conv.id} (not in server list, agent ${conv.agentId} online)`);
        // Clean up associated state
        delete store.messagesMap[conv.id];
        delete store.processingConversations[conv.id];
        stopProcessingWatchdog(store, conv.id);
        delete store.executionStatusMap[conv.id];
        return false;
      }
      // Agent not in list at all (different agent, offline) → keep but mark offline
      if (conv.agentId && !listedAgentIds.has(conv.agentId)) {
        conv.agentOnline = false;
      }
      return true;
    });

    for (const serverConv of allServerConvs) {
      if (serverConv.processing && !isRecentlyClosed(store, serverConv.id)
          && !store._turnCompletedConvs?.has(serverConv.id)) {
        store.processingConversations[serverConv.id] = true;
      } else if (store.processingConversations[serverConv.id]) {
        delete store.processingConversations[serverConv.id];
        stopProcessingWatchdog(store, serverConv.id);
        const status = store.executionStatusMap[serverConv.id];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(serverConv.id);
      }
    }
    for (const convId of Object.keys(store.processingConversations)) {
      if (!allServerConvIds.has(convId)) {
        // Skip Yeaft virtual conversations — they're not tracked by the server's agent conversation list
        if (convId.startsWith('yeaft-')) continue;
        console.log(`[agent_list] Clearing stale processing state for ${convId}`);
        delete store.processingConversations[convId];
        stopProcessingWatchdog(store, convId);
        const status = store.executionStatusMap[convId];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(convId);
      }
    }
  }
  // Sync pinned sessions to localStorage (server is source of truth)
  localStorage.setItem('pinned-sessions', JSON.stringify(store.pinnedSessions));
  // ★ Prune stale guards — only clear entries older than 30s to prevent
  // agent_list from re-setting processing on recently-completed conversations.
  // Old code cleared ALL guards on every agent_list, which destroyed the
  // protection window and caused typing indicator to get stuck.
  if (store._closedAt) {
    const now = Date.now();
    for (const convId of Object.keys(store._closedAt)) {
      if (now - store._closedAt[convId] > 30000) {
        delete store._closedAt[convId];
        store._turnCompletedConvs?.delete(convId);
      }
    }
  }
  // ★ Reconnect 恢复
  if (store.currentAgent) {
    const agent = nextAgents.find(a => a.id === store.currentAgent && a.online);
    if (agent) {
      const reconnectEdge = !!store._yeaftReconnectCatchUpPending;
      const agentCameOnline = hadAgentList && !previousCurrentAgentOnline;
      const shouldRestoreAgent = reconnectEdge || agentCameOnline;
      store.currentAgentInfo = agent;

      if (shouldRestoreAgent) {
        store._offlineConversationRestoreKey = null;
        console.log('[Reconnect] Agent online, restoring selection:', store.currentAgent);
        store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
      }

      // Work Center events are intentionally bounded while the browser is
      // offline, so the first inventory frame after a genuine reconnect or
      // Agent restart must reconcile the currently visible board from its
      // durable list. Keep this on the same online-restore edge as selection:
      // routine latency/status agent_list broadcasts must not reload the board.
      if (shouldRestoreAgent && store.workCenterOpen
          && store.workCenterAgentId === store.currentAgent
          && typeof store.listWorkItems === 'function') {
        const filters = store._workCenterListFiltersByAgent?.[store.workCenterAgentId] || {};
        store.listWorkItems(store.workCenterAgentId, filters).catch(() => {});
      }

      // Consume the browser-reconnect latch at the shared online boundary even
      // when Work Center is covering Chat. Yeaft below uses the captured edge;
      // a later explicit Yeaft entry runs its own forced bootstrap.
      store._yeaftReconnectCatchUpPending = false;

      if (store.currentView === 'yeaft' && typeof store.requestYeaftSessionBootstrap === 'function') {
        // Only catch up history on a GENUINE reconnect/restart. agent_list
        // arrives frequently (status flips, turn_completed, latency pings);
        // running the afterSeq catch-up on each one re-fires
        // yeaft_load_history + yeaft_vp_subscribe in an unbounded loop,
        // because history_loaded resets the session's `loading` flag and
        // re-arms shouldCatchUpLoadedYeaftSession. The one-shot
        // _yeaftReconnectCatchUpPending latch is armed only on a real edge:
        // the websocket onclose handler (server/network drop) OR the
        // agent-restart detection at the top of this function (agent process
        // updated/restarted — the socket stays up, so onclose never fires).
        // A real reconnect/restart edge needs a fresh session_ready too: the
        // restarted agent has a new engine + conversationId, so the cached
        // yeaftSessionReady/model/status are stale even though they're still
        // truthy. Force the replay on the edge (in addition to the usual
        // "state missing" trigger) so the conversationId re-migrates and VP
        // subscription re-primes — not just the history delta.
        const needsYeaftSessionReady = reconnectEdge
          || !store.yeaftSessionReady || !store.yeaftModel || !store.yeaftStatus;
        if (needsYeaftSessionReady || reconnectEdge) {
          store.requestYeaftSessionBootstrap({ forceSessionReady: needsYeaftSessionReady, catchUpHistory: reconnectEdge });
        }
      }

      if (!shouldRestoreAgent) return;

      if (store.currentConversation) {
        const conv = store.conversations.find(c => c.id === store.currentConversation);
        store.sendWsMessage({ type: 'select_conversation', conversationId: store.currentConversation });

        // Chat-mode missed-message sync is useful after a real reconnect, but
        // doing it on every routine agent_list creates a request loop:
        // broadcastAgentList -> select/sync/refresh -> agent status update ->
        // broadcastAgentList. Keep it edge-triggered like Yeaft catch-up.
        const currentMsgs = store.messagesMap[store.currentConversation] || [];
        const lastMessageId = maxDbMessageId(currentMsgs);
        if (lastMessageId != null) {
          console.log('[Reconnect] Requesting missed messages after:', lastMessageId);
          store.requestChatHistory?.(store.currentConversation, {
            mode: 'delta',
            afterMessageId: lastMessageId,
          });
        } else {
          store.requestChatHistory?.(store.currentConversation, { mode: 'recent', turns: 5 });
        }
        store.sendWsMessage({
          type: 'refresh_conversation',
          conversationId: store.currentConversation
        });

      } else if (!store.recoveryDismissed) {
        console.log('[Reconnect] currentConversation null, attempting restore');
        restoreLastViewedConversation(store);
      }
      return;
    } else {
      // fix-chat-reconnect-race — even when the agent hasn't reconnected
      // yet (agent is an independent process; on a server restart the web
      // WS comes back in ~1s but the agent typically needs a few more
      // seconds), we still need to restore `client.currentConversation`
      // on the server. The server's `select_conversation` handler only
      // does an ownership check + writes that field — it does NOT touch
      // any agent. But do this only once per offline edge; routine absent
      // agent_list frames must not keep sending websocket requests.
      const offlineRestoreKey = `${store.currentAgent || ''}:${store.currentConversation || ''}`;
      const shouldRestoreOfflineContext = !!store.currentConversation
        && (!hadAgentList || previousCurrentAgentOnline || store._offlineConversationRestoreKey !== offlineRestoreKey);
      if (shouldRestoreOfflineContext) {
        console.log('[Reconnect] Agent not online yet, restoring conversation context only:', store.currentAgent);
        store._offlineConversationRestoreKey = offlineRestoreKey;
        store.sendWsMessage({ type: 'select_conversation', conversationId: store.currentConversation });
      }
      return;
    }
  }
  // ★ 自动恢复上次查看的 conversation（UI 刷新后）
  if (!store.currentConversation && !store.currentAgent && !store.recoveryDismissed) {
    const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
    const lastAgent = store.lastUsedAgent;

    if (lastViewed) {
      const conv = store.conversations.find(c => c.id === lastViewed);
      if (conv) {
        const agent = nextAgents.find(a => a.id === conv.agentId && a.online);
        if (agent) {
          console.log('[AutoRestore] Restoring last viewed conversation:', lastViewed, 'on agent:', conv.agentId);
          restoreLastViewedConversation(store, { agentId: conv.agentId, agentInfo: agent });
          return;
        }
      }
    }

    if (lastAgent) {
      const agent = store.agents.find(a => a.id === lastAgent && a.online);
      if (agent) {
        console.log('[AutoRestore] Auto-selecting last used agent:', lastAgent);
        store.selectAgent(lastAgent);
      } else {
        store.checkPendingRecovery();
      }
    }
  }
}

/**
 * Handle agent_selected message.
 */
export function handleAgentSelected(store, msg) {
  console.log('[agent_selected] Switching to agent:', msg.agentId);
  const pending = store.pendingAgentSelection || null;
  if (pending) {
    const matchesRequest = typeof msg.requestId === 'string' && msg.requestId
      ? msg.requestId === pending.requestId
      : msg.agentId === pending.agentId;
    if (!matchesRequest) return false;
    store.pendingAgentSelection = null;
    if (msg.ok === false) {
      store.agentSwitching = false;
      return false;
    }
  } else if (msg.requestId) {
    return false;
  } else if (store.currentAgent && msg.agentId !== store.currentAgent) {
    // A delayed response from a legacy Server has no request identity. With no
    // pending target, only the already-active Agent is safe to re-affirm.
    return false;
  }
  store.agentSwitching = false;
  const isSameAgent = store.currentAgent === msg.agentId;
  const agentInfo = {
    id: msg.agentId,
    name: msg.agentName,
    workDir: msg.workDir,
    capabilities: msg.capabilities || ['terminal', 'file_editor', 'background_tasks'],
    ...(msg.capabilityMetadataProvided === true ? { capabilityMetadataProvided: true } : {}),
    version: msg.version || null,
  };
  if (typeof store.activateYeaftAgent === 'function') {
    store.activateYeaftAgent(msg.agentId, agentInfo);
  } else {
    store.currentAgent = msg.agentId;
    store.currentAgentInfo = agentInfo;
  }

  if (Array.isArray(msg.slashCommands)) {
    // Store as the Claude Chat agent-level fallback. Yeaft command snapshots
    // are delivered separately and must not be overwritten during selection.
    const slashCommands = [...new Set(msg.slashCommands)];
    store.slashCommandsMap[`agent:${msg.agentId}`] = slashCommands;
  }
  // Merge command descriptions
  if (msg.slashCommandDescriptions) {
    store.slashCommandDescriptions = { ...store.slashCommandDescriptions, ...msg.slashCommandDescriptions };
  }

  const serverConvs = msg.conversations || [];
  const seenIds = new Set();
  let activeConvs = serverConvs.filter(c => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  }).map(c => ({
    ...c,
    agentId: msg.agentId,
    agentName: msg.agentName
  }));

  if (isSameAgent && store.currentConversation) {
    const currentConvInServer = serverConvs.find(c => c.id === store.currentConversation);
    if (currentConvInServer && !activeConvs.find(c => c.id === currentConvInServer.id)) {
      activeConvs.push({
        ...currentConvInServer,
        agentId: msg.agentId,
        agentName: msg.agentName
      });
    }
  }

  // fix-session-dup: dedupe by `id`, not by `agentId`. Previously this
  // partitioned `store.conversations` on `c.agentId !== msg.agentId` and
  // spread the new agent's list on top — so a conv that was already in the
  // store under a different agentId (because the server has it in two
  // agents' in-memory Maps; see server/handlers/agent-conversation.js's
  // resume path which doesn't transfer agent ownership) survived the
  // filter AND got a second copy from `activeConvs`. Net effect: the same
  // conversationId rendered twice in the sidebar with two different
  // agent badges.
  //
  // Now: anything in `activeConvs` wins outright (it carries the freshest
  // agentId/agentName for the selected agent); anything else in the store
  // is preserved only if its id is NOT in the incoming set. `otherAgentConvs`
  // is rebuilt below from this same filter so the stale-processing sweep
  // (line ~367) still works.
  const incomingIds = new Set(activeConvs.map(c => c.id));
  const otherAgentConvs = store.conversations.filter(c => !incomingIds.has(c.id));
  store.conversations = [...otherAgentConvs, ...activeConvs];

  for (const conv of serverConvs) {
    if (conv.title) {
      if (conv.customTitle) {
        store.customConversationTitles[conv.id] = conv.title;
      }
      if (!store.conversationTitles[conv.id]) {
        store.conversationTitles[conv.id] = conv.title;
      }
    }
  }

  console.log('[agent_selected] Merged conversations:', store.conversations.length,
              'from agent:', msg.agentId, 'kept from others:', otherAgentConvs.length);

  const agentConvIds = new Set(serverConvs.map(c => c.id));
  for (const conv of serverConvs) {
    if (conv.processing && !isRecentlyClosed(store, conv.id)
        && !store._turnCompletedConvs?.has(conv.id)) {
      store.processingConversations[conv.id] = true;
    } else if (store.processingConversations[conv.id]) {
      delete store.processingConversations[conv.id];
      stopProcessingWatchdog(store, conv.id);
      const status = store.executionStatusMap[conv.id];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(conv.id);
    }
  }
  for (const convId of Object.keys(store.processingConversations)) {
    if (!agentConvIds.has(convId)) {
      // Skip Yeaft virtual conversations — they're not tracked by the server's agent conversation list
      if (convId.startsWith('yeaft-')) continue;
      const isOtherAgent = otherAgentConvs.some(c => c.id === convId);
      if (!isOtherAgent) {
        console.log(`[agent_selected] Clearing stale processing state for ${convId}`);
        delete store.processingConversations[convId];
        stopProcessingWatchdog(store, convId);
        const status = store.executionStatusMap[convId];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(convId);
      }
    }
  }

  // A Yeaft conversation id belongs to the Agent bridge, not the ordinary
  // Chat conversation registry. Re-affirm the Agent catalog without mutating
  // hidden Chat selection, workDir or history state.
  if (store.currentView !== 'yeaft') {
    if (isSameAgent && store.currentConversation) {
      const currentConv = store.conversations.find(c => c.id === store.currentConversation);
      store.currentWorkDir = currentConv?.workDir || store.currentWorkDir || msg.workDir;
      console.log('[Reconnect] Restoring conversation selection:', store.currentConversation);
      clearSessionLoading(store);
      store.sendWsMessage({
        type: 'select_conversation',
        conversationId: store.currentConversation
      });

    } else {
      store.activeConversations = [];
      store.currentWorkDir = msg.workDir;

      const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
      if (lastViewed && store.conversations.find(c => c.id === lastViewed)) {
        console.log('[AutoRestore] Restoring last viewed conversation:', lastViewed);
        store.autoRestoreConversation(lastViewed);
        store.pendingRecovery = null;
      }
    }

    // Split panels are ordinary Chat state. Restoring them during a Yeaft ACK
    // would reintroduce Chat conversations and history into the Yeaft view.
    restorePanels(store);
  }
  return true;
}
