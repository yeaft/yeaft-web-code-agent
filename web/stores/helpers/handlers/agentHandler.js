/**
 * Agent-related message handlers: agent_list, agent_selected.
 * The most complex handler — includes auto-restore and reconnection logic.
 */

import { isRecentlyClosed, stopProcessingWatchdog } from '../watchdog.js';
import { clearSessionLoading, restorePanels } from '../session.js';

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
  // For crew conversations, initialize crewMessagesMap BEFORE setting activeConversations
  if (conv.type === 'crew' && !store.crewMessagesMap[lastViewed]) {
    store.crewMessagesMap[lastViewed] = [];
  }
  store.activeConversations = [lastViewed];
  store.currentWorkDir = conv.workDir;
  store.messagesMap[lastViewed] = [];
  store.sendWsMessage({ type: 'select_conversation', conversationId: lastViewed });

  if (conv.type === 'crew') {
    store.sendWsMessage({
      type: 'resume_crew_session',
      sessionId: lastViewed,
      agentId
    });
  } else {
    store.sendWsMessage({
      type: 'sync_messages',
      conversationId: lastViewed,
      turns: 5
    });
    store.sendWsMessage({ type: 'refresh_conversation', conversationId: lastViewed });
  }
  return true;
}

/**
 * Handle agent_list message: sync conversations, proxy ports, reconnection.
 */
export function handleAgentList(store, msg) {
  store.agents = msg.agents;

  // Agent-restart detection. When the agent PROCESS restarts (deploy/update
  // or crash), the web↔server websocket never drops, so the onclose-based
  // _yeaftReconnectCatchUpPending latch never fires and the Yeaft session is
  // left un-reloaded. Detect the restart edge here and arm the SAME one-shot
  // latch the reconnect-restore branch below already consumes.
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
    const nextRec = msg.agents.find(a => a.id === trackedAgentId) || null;
    if (store.currentView === 'yeaft' && detectYeaftAgentRestart(seen, nextRec)) {
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
    const agentIds = new Set(msg.agents.map(a => a.id));
    for (const agent of msg.agents) {
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
    const agent = msg.agents.find(a => a.id === store.currentAgent);
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
    const online = msg.agents.find(a => a.online);
    if (online) {
      store.currentAgent = online.id;
      store.currentAgentInfo = online;
    }
  }
  if (store.currentView === 'yeaft' && typeof store.loadOpenedYeaftSessionsForConnectedAgents === 'function') {
    const onlineIds = msg.agents.filter(a => a && a.online && a.id).map(a => a.id);
    store.loadOpenedYeaftSessionsForConnectedAgents(onlineIds);
  }
  // ★ 同步所有 agent 的 conversations 到 store.conversations
  {
    const allServerConvs = [];
    const allServerConvIds = new Set();
    for (const agent of msg.agents) {
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
        // Preserve crew session name from server; keep existing if server has none
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
    const listedAgentIds = new Set(msg.agents.map(a => a.id));
    store.conversations = store.conversations.filter(conv => {
      if (allServerConvIds.has(conv.id)) return true; // still in server list
      // Don't remove conversations the user is currently viewing
      if (store.activeConversations.includes(conv.id)) return true;
      // Crew history rows are loaded on demand through crew_sessions_list, not routine agent_list snapshots.
      if (conv.type === 'crew' && store.crewModeEnabled && conv.crewListLoaded) return true;
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
      const isStaleCrewProcessing = serverConv.processing && serverConv.type === 'crew'
        && !store.crewSessions?.[serverConv.id];
      if (serverConv.processing && !isRecentlyClosed(store, serverConv.id)
          && !store._turnCompletedConvs?.has(serverConv.id)
          && !isStaleCrewProcessing) {
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
    const agent = msg.agents.find(a => a.id === store.currentAgent && a.online);
    if (agent) {
      console.log('[Reconnect] Agent online, restoring selection:', store.currentAgent);
      store.currentAgentInfo = agent;
      store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
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
        const reconnectEdge = !!store._yeaftReconnectCatchUpPending;
        store._yeaftReconnectCatchUpPending = false;
        // A real reconnect/restart edge needs a fresh session_ready too: the
        // restarted agent has a new engine + conversationId, so the cached
        // yeaftSessionReady/model/status are stale even though they're still
        // truthy. Force the replay on the edge (in addition to the usual
        // "state missing" trigger) so the conversationId re-migrates and VP
        // subscription re-primes — not just the history delta.
        const needsYeaftSessionReady = reconnectEdge
          || !store.yeaftSessionReady || !store.yeaftModel || !store.yeaftStatus;
        store.requestYeaftSessionBootstrap({ forceSessionReady: needsYeaftSessionReady, catchUpHistory: reconnectEdge });
      }
      if (store.currentConversation) {
        const conv = store.conversations.find(c => c.id === store.currentConversation);
        store.sendWsMessage({ type: 'select_conversation', conversationId: store.currentConversation });
        if (conv?.type === 'crew') {
          // ★ Only send resume_crew_session when the local session is NOT already
          // active with messages. During normal operation, agent_list arrives
          // frequently (after every status change) and re-sending resume would
          // trigger crew_session_restored which replaces crewMessagesMap,
          // wiping the local human message and making the typing indicator disappear.
          const crewMsgs = store.crewMessagesMap[store.currentConversation];
          if (!crewMsgs || crewMsgs.length === 0) {
            console.log('[Reconnect] Crew conversation detected, resuming crew session:', store.currentConversation);
            store.sendWsMessage({
              type: 'resume_crew_session',
              sessionId: store.currentConversation,
              agentId: store.currentAgent
            });
          }
        } else {
          // Unlike the Yeaft catch-up above (gated behind
          // _yeaftReconnectCatchUpPending), this Chat-mode sync runs on
          // every agent_list by design: sync_messages{afterMessageId} is a
          // client-idempotent edge-triggered request (server returns only
          // rows after a stable id, deduped on arrival), so repeating it on
          // routine broadcasts is harmless. The Yeaft history catch-up is
          // level-triggered (shouldCatchUpLoadedYeaftSession re-arms after
          // each history_loaded), which is why only it needs the latch.
          const currentMsgs = store.messagesMap[store.currentConversation] || [];
          if (currentMsgs.length > 0) {
            const lastMessageId = currentMsgs[currentMsgs.length - 1]?.id;
            console.log('[Reconnect] Requesting missed messages after:', lastMessageId);
            store.sendWsMessage({
              type: 'sync_messages',
              conversationId: store.currentConversation,
              afterMessageId: lastMessageId
            });
          } else {
            store.sendWsMessage({
              type: 'sync_messages',
              conversationId: store.currentConversation,
              turns: 5
            });
          }
          store.sendWsMessage({
            type: 'refresh_conversation',
            conversationId: store.currentConversation
          });
        }
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
      // any agent. Without this, a user sending a message in the
      // intervening window hits `chat handler -> No conversation
      // selected -> error`, and (because that error is classified
      // system-transient) the typing indicator spins forever while the
      // chat is silently dropped. The full resume path (sync_messages,
      // refresh_conversation) still waits for the agent to come online
      // via the `if (agent)` branch above on the next `agent_list`.
      console.log('[Reconnect] Agent not online yet, restoring conversation context only:', store.currentAgent);
      if (store.currentConversation) {
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
        const agent = msg.agents.find(a => a.id === conv.agentId && a.online);
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
  store.agentSwitching = false;
  const isSameAgent = store.currentAgent === msg.agentId;
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = {
    id: msg.agentId,
    name: msg.agentName,
    workDir: msg.workDir,
    capabilities: msg.capabilities || ['terminal', 'file_editor', 'background_tasks']
  };

  if (msg.slashCommands && msg.slashCommands.length > 0) {
    // Store as agent-level default, used as fallback when a conversation
    // hasn't reported its own slashCommands yet
    const slashCommands = [...new Set(msg.slashCommands)];
    store.slashCommandsMap[`agent:${msg.agentId}`] = slashCommands;
    if (store.currentView === 'yeaft' && store.yeaftConversationId) {
      store.slashCommandsMap[store.yeaftConversationId] = slashCommands;
    }
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

  if (isSameAgent && store.currentConversation) {
    const currentConv = store.conversations.find(c => c.id === store.currentConversation);
    store.currentWorkDir = currentConv?.workDir || store.currentWorkDir || msg.workDir;
    console.log('[Reconnect] Restoring conversation selection:', store.currentConversation);
    clearSessionLoading(store);
    store.sendWsMessage({
      type: 'select_conversation',
      conversationId: store.currentConversation
    });
    // ★ Crew session needs resume to restore roles after server restart
    if (currentConv?.type === 'crew') {
      console.log('[Reconnect] Crew conversation detected in agent_selected, resuming:', store.currentConversation);
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: store.currentConversation,
        agentId: msg.agentId
      });
    }
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

  // ★ Restore split-screen panels from localStorage (independent of conversation restore)
  restorePanels(store);
}
