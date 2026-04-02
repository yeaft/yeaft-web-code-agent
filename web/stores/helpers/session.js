// Session persistence, recovery, and history helpers

import { useAuthStore } from '../auth.js';
import { t } from '../../utils/i18n.js';

// ★ sessionLoading 超时保护：防止 loading 状态永远卡住
const SESSION_LOADING_TIMEOUT = 30000; // 30 秒
let _sessionLoadingTimer = null;

export function setSessionLoading(store, loading, text = '') {
  if (_sessionLoadingTimer) {
    clearTimeout(_sessionLoadingTimer);
    _sessionLoadingTimer = null;
  }
  store.sessionLoading = loading;
  store.sessionLoadingText = text;
  if (loading) {
    _sessionLoadingTimer = setTimeout(() => {
      if (store.sessionLoading) {
        console.warn('[SessionLoading] Timeout, clearing loading state');
        store.sessionLoading = false;
        store.sessionLoadingText = '';
      }
      _sessionLoadingTimer = null;
    }, SESSION_LOADING_TIMEOUT);
  }
}

export function clearSessionLoading(store) {
  setSessionLoading(store, false);
}

export function checkPendingRecovery(store) {
  if (store.currentConversation) {
    store.pendingRecovery = null;
    return;
  }

  const lastSession = store.lastUsedSession;
  const lastAgent = store.lastUsedAgent;

  if (lastSession && lastSession.sessionId && lastAgent) {
    const agent = store.agents.find(a => a.id === lastAgent && a.online);
    if (agent) {
      store.pendingRecovery = {
        agentId: lastAgent,
        agentName: agent.name,
        sessionId: lastSession.sessionId,
        workDir: lastSession.workDir
      };
      store.recoveryDismissed = false;
      console.log('[Recovery] Found recoverable session:', store.pendingRecovery);
    }
  }
}

export function performRecovery(store) {
  if (!store.pendingRecovery) return;

  const { agentId, sessionId, workDir } = store.pendingRecovery;
  console.log('[Recovery] Performing recovery:', sessionId);

  store.selectAgent(agentId);

  setTimeout(() => {
    store.resumeConversation(sessionId, workDir, agentId);
    store.pendingRecovery = null;
    store.recoveryDismissed = false;
  }, 500);
}

export function dismissRecovery(store) {
  store.recoveryDismissed = true;
  store.pendingRecovery = null;
}

export function autoRestoreConversation(store, conversationId) {
  const conv = store.conversations.find(c => c.id === conversationId);
  if (!conv) return;

  // For crew conversations, initialize crewMessagesMap BEFORE setting activeConversations
  if (conv.type === 'crew') {
    if (!store.crewMessagesMap[conversationId]) {
      store.crewMessagesMap[conversationId] = [];
    }
    store.messagesMap[conversationId] = [];
  }

  store.activeConversations = [conversationId];
  store.currentWorkDir = conv.workDir;

  if (conv.type === 'crew') {
    // Crew conversations: resume crew session to load messages
    const hasCrewMessages = store.crewMessagesMap[conversationId].length > 0;
    if (!hasCrewMessages) {
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: conversationId,
        agentId: conv.agentId || store.currentAgent
      });
    }
  } else if (store.messagesMap[conversationId]?.length > 0) {
    // Messages already in messagesMap, nothing to do
    console.log('[AutoRestore] Restored from messagesMap:', store.messagesMap[conversationId].length, 'messages');
  } else if (conv.claudeSessionId) {
    store.messagesMap[conversationId] = [];
    setSessionLoading(store, true, t('chat.session.loadingHistory'));
    console.log('[AutoRestore] Loading history for session:', conv.claudeSessionId);
    store.sendWsMessage({
      type: 'resume_conversation',
      agentId: conv.agentId || store.currentAgent,
      claudeSessionId: conv.claudeSessionId,
      workDir: conv.workDir,
      conversationId: conversationId
    });
  } else {
    store.messagesMap[conversationId] = [];
    // ★ Phase 6.1: 使用 turns 加载最近 5 个 turn
    store.sendWsMessage({
      type: 'sync_messages',
      conversationId,
      turns: 5
    });
  }

  store.sendWsMessage({
    type: 'select_conversation',
    conversationId
  });

  // ★ Restore panels is now called directly from agentHandler after conversation restore
}

/**
 * Restore panels from localStorage.
 * Filters out panels with conversationIds that no longer exist in store.conversations.
 * If only 0-1 valid panels remain, exit split mode (empty array).
 * Exported so agentHandler can call it independently of autoRestoreConversation.
 */
export function restorePanels(store) {
  // Only restore once per session — skip if already in split mode
  if (store.panels.length > 0) return;

  const raw = localStorage.getItem('panels');
  if (!raw) return;

  let panels;
  try {
    panels = JSON.parse(raw);
  } catch {
    localStorage.removeItem('panels');
    return;
  }

  if (!Array.isArray(panels) || panels.length < 2) {
    localStorage.removeItem('panels');
    return;
  }

  // Validate: each panel needs an id; conversationId must exist (or be null)
  const convIds = new Set(store.conversations.map(c => c.id));
  const validPanels = panels
    .filter(p => p && typeof p.id === 'string')
    .map(p => ({
      id: p.id,
      conversationId: (p.conversationId && convIds.has(p.conversationId)) ? p.conversationId : null,
      crewPanelVisible: p.crewPanelVisible || { roles: true, features: true },
      activeRightPanel: p.activeRightPanel || null,
      crewMobilePanel: p.crewMobilePanel || null
    }));

  if (validPanels.length < 2) {
    localStorage.removeItem('panels');
    return;
  }

  store.panels = validPanels;
  store.activePanelId = validPanels[0]?.id || null;

  // Ensure all panel conversationIds are in activeConversations + have messagesMap entries
  for (const panel of validPanels) {
    if (panel.conversationId) {
      if (!store.activeConversations.includes(panel.conversationId)) {
        store.activeConversations.push(panel.conversationId);
      }
      if (!store.messagesMap[panel.conversationId]) {
        store.messagesMap[panel.conversationId] = [];
      }
      const conv = store.conversations.find(c => c.id === panel.conversationId);
      if (conv?.type === 'crew') {
        // Crew conversations: init crew messages + resume session
        if (!store.crewMessagesMap[panel.conversationId]) {
          store.crewMessagesMap[panel.conversationId] = [];
        }
        store.sendWsMessage({
          type: 'resume_crew_session',
          sessionId: panel.conversationId,
          agentId: conv.agentId || store.currentAgent
        });
      } else {
        // Chat conversations: sync recent messages
        if (!store.messagesMap[panel.conversationId].length) {
          store.sendWsMessage({ type: 'sync_messages', conversationId: panel.conversationId, turns: 5 });
        }
      }
    }
  }

  console.log('[Panels] Restored', validPanels.length, 'panels from localStorage');
}

export function saveOpenSessions(store) {
  if (!store.currentAgent) return;

  localStorage.setItem('lastUsedAgent', store.currentAgent);
  localStorage.setItem('lastViewedConversation', store.currentConversation || '');
  store.lastViewedConversation = store.currentConversation;

  if (store.currentConversation) {
    const conv = store.conversations.find(c => c.id === store.currentConversation);
    if (conv?.claudeSessionId && conv?.workDir) {
      localStorage.setItem('lastUsedSession', JSON.stringify({
        sessionId: conv.claudeSessionId,
        workDir: conv.workDir,
        agentId: store.currentAgent
      }));
      store.lastUsedSession = { sessionId: conv.claudeSessionId, workDir: conv.workDir, agentId: store.currentAgent };
    }
  }
  store.lastUsedAgent = store.currentAgent;

  // ★ Persist panels to localStorage (split-screen state survives refresh)
  if (store.panels.length > 0) {
    localStorage.setItem('panels', JSON.stringify(store.panels));
  } else {
    localStorage.removeItem('panels');
  }
}

export function getLastSession(store) {
  return store.lastUsedSession;
}

export function clearLastSession(store) {
  localStorage.removeItem('lastUsedAgent');
  localStorage.removeItem('lastUsedSession');
  localStorage.removeItem('lastViewedConversation');
  localStorage.removeItem('panels');
  localStorage.removeItem('splitPanesSaved');
  store.lastUsedAgent = null;
  store.lastUsedSession = null;
  store.lastViewedConversation = null;
}

export function listHistorySessions(store, workDir) {
  if (!store.currentAgent) {
    store.historySessionsLoading = false;
    return;
  }
  if (!workDir) {
    store.historySessions = [];
    store.historySessionsLoading = false;
    return;
  }
  const requestId = Date.now().toString();
  store._historySessionsRequestId = requestId;
  store.historySessionsLoading = true;
  store.historySessions = [];
  store.sendWsMessage({
    type: 'list_history_sessions',
    workDir,
    requestId
  });
}

export function listFolders(store) {
  if (!store.currentAgent) {
    store.foldersLoading = false;
    return Promise.resolve();
  }
  store.foldersLoading = true;
  store.folders = [];

  const requestId = Date.now().toString();
  store._foldersRequestId = requestId;

  return new Promise((resolve) => {
    // 如果有旧的 pending resolve，先 resolve 它
    if (store._foldersResolve) {
      store._foldersResolve();
    }
    store._foldersResolve = resolve;
    store.sendWsMessage({
      type: 'list_folders',
      requestId
    });
    setTimeout(() => {
      if (store._foldersResolve === resolve) {
        store._foldersResolve();
        store._foldersResolve = null;
        store.foldersLoading = false;
      }
    }, 10000);
  });
}

export function listFoldersForAgent(store, agentId) {
  if (!agentId) {
    store.foldersLoading = false;
    return Promise.resolve();
  }
  store.foldersLoading = true;
  store.folders = [];

  const requestId = Date.now().toString();
  store._foldersRequestId = requestId;

  return new Promise((resolve) => {
    if (store._foldersResolve) {
      store._foldersResolve();
    }
    store._foldersResolve = resolve;
    store.sendWsMessage({
      type: 'list_folders',
      agentId,
      requestId
    });
    setTimeout(() => {
      if (store._foldersResolve === resolve) {
        store._foldersResolve();
        store._foldersResolve = null;
        store.foldersLoading = false;
      }
    }, 10000);
  });
}

export function listHistorySessionsForAgent(store, agentId, workDir) {
  if (!agentId) {
    store.historySessionsLoading = false;
    return;
  }
  if (!workDir) {
    store.historySessions = [];
    store.historySessionsLoading = false;
    return;
  }
  const requestId = Date.now().toString();
  store._historySessionsRequestId = requestId;
  store.historySessionsLoading = true;
  store.historySessions = [];
  store.sendWsMessage({
    type: 'list_history_sessions',
    agentId,
    workDir,
    requestId
  });
}

export async function loadGlobalSessions(store, limit = 20) {
  const authStore = useAuthStore();
  if (!authStore.token) return;

  store.globalSessionsLoading = true;
  try {
    const response = await fetch(`/api/sessions?limit=${limit}`, {
      headers: {
        'Authorization': `Bearer ${authStore.token}`
      }
    });
    if (response.ok) {
      const data = await response.json();
      store.globalSessions = data.sessions || [];
    }
  } catch (err) {
    console.error('Failed to load global sessions:', err);
  } finally {
    store.globalSessionsLoading = false;
  }
}

export async function deleteGlobalSession(store, sessionId) {
  const authStore = useAuthStore();
  if (!authStore.token) return false;

  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${authStore.token}`
      }
    });
    if (response.ok) {
      store.globalSessions = store.globalSessions.filter(s => s.id !== sessionId);
      return true;
    }
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
  return false;
}

export function findAgentForSession(store, session) {
  if (session.agentId) {
    return store.agents.find(a => a.id === session.agentId);
  }
  if (session.agentName) {
    return store.agents.find(a => a.name === session.agentName);
  }
  return null;
}

export function isSessionResumable(store, session) {
  const agent = findAgentForSession(store, session);
  return agent && agent.online;
}
