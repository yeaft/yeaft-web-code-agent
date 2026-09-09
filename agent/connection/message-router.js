/**
 * message-router.js — Server-bound message dispatcher.
 *
 * task-330c lint guard:
 *   ⚠️ DO NOT introduce greedy `text.replace(/---ROUTE---[\s\S]*$/g, '')`
 *      style strips on routed message payloads.
 */
import ctx from '../context.js';
import { decodeKey } from '../encryption.js';
import { handleTerminalCreate, handleTerminalInput, handleTerminalResize, handleTerminalClose } from '../terminal.js';
import { handleProxyHttpRequest, handleProxyWsOpen, handleProxyWsMessage, handleProxyWsClose } from '../proxy.js';
import {
  handleReadFile, handleWriteFile, handleListDirectory,
  handleGitStatus, handleGitDiff, handleGitAdd, handleGitReset, handleGitRestore, handleGitCommit, handleGitPush,
  handleFileSearch, handleResolveFileReferences, handleCreateFile, handleDeleteFiles, handleMoveFiles, handleCopyFiles, handleUploadToDir, handleTransferFiles
} from '../workbench.js';
import { handleListHistorySessions, handleListFolders, handleListModels } from '../history.js';
import {
  createConversation, resumeConversation, deleteConversation,
  handleRefreshConversation, handleCancelExecution,
  handleUserInput, handleUpdateConversationSettings, handleAskUserAnswer,
  sendConversationList, handleBtwQuestion, preloadSlashCommands,
  handlePingSession
} from '../conversation.js';
import { sendToServer, flushMessageBuffer } from './buffer.js';
import { sendAgentMetricsSnapshot } from '../metrics.js';
import { handleRestartAgent, handleUpgradeAgent } from './upgrade.js';
import { loadMcpServers, updateMcpConfig } from '../mcp.js';
import { getLlmConfig, updateLlmConfig, getYeaftSettings, updateYeaftSettings, getPluginConfig, updatePluginConfig, getTelemetrySettings, updateTelemetrySettings, getSearchSettings, updateSearchSettings, fetchTavilyUsage } from '../yeaft/config-api.js';
import { loadConfig } from '../yeaft/config.js';
import { mutateAgentConfig } from '../yeaft/config-store.js';
import { discoverLlmModels } from '../llm-model-discovery.js';
import { fetchModelsDev } from '../yeaft/llm/models-dev.js';
import { handleYeaftSessionSend, handleYeaftAskUserAnswer, handleYeaftSubAgentPrompt, handleYeaftTaskCancel, handleYeaftModeSwitch, handleYeaftModelSwitch, resetYeaftSession, refreshLiveSessionConfig, setLiveDreamEnabled, handleYeaftLoadHistory, handleYeaftLoadHistoryOutline, handleYeaftSearchHistory, handleYeaftLoadHistoryWindow, handleYeaftLoadMoreHistory, handleYeaftAbortThread, handleYeaftAbortAll, handleYeaftAbortTurn, handleYeaftVpSubscribe, handleYeaftVpCreate, handleYeaftVpUpdate, handleYeaftVpDelete, handleYeaftVpRead, handleYeaftListSessions, handleYeaftProjectContextSync, handleYeaftProjectMutation, handleYeaftCreateSession, handleYeaftRenameSession, handleYeaftUpdateSession, handleYeaftUpdateSessionConfig, handleYeaftArchiveSession, handleYeaftDeleteSession, handleYeaftSessionAddMember, handleYeaftSessionRemoveMember, handleYeaftSessionSetDefaultVp, handleYeaftScanWorkdirSessions, handleYeaftRestoreSession, handleYeaftDreamTrigger, handleYeaftFetchToolStats, handleYeaftFetchDebugHistory, handleYeaftMcpList, handleYeaftMcpAdd, handleYeaftMcpRemove, handleYeaftMcpReload, handleYeaftPluginCatalog, handleYeaftManagedSkill, ensureSessionLoaded, broadcastLanguageChange, broadcastYeaftSessionSnapshotEager, broadcastYeaftVpSnapshotEager, preloadYeaftSkillSlashCommands } from '../yeaft/web-bridge.js';
import { startYeaftStatusRefresh, forceRefreshYeaftStatus } from '../yeaft/status-cache.js';
import { handleWorkCenterRequest } from '../yeaft/work-center/bridge.js';
import { handleBrowserRuntimeMessage } from '../browser-runtime/messages.js';

export async function applyLlmConfigUpdate(msg, dependencies = {}) {
  const updateConfig = dependencies.updateLlmConfig || updateLlmConfig;
  const broadcastLanguage = dependencies.broadcastLanguageChange || broadcastLanguageChange;
  const forceStatusRefresh = dependencies.forceRefreshYeaftStatus || forceRefreshYeaftStatus;
  const refreshRuntimeConfig = dependencies.refreshLiveSessionConfig || refreshLiveSessionConfig;
  const readConfig = dependencies.loadConfig || loadConfig;
  const send = dependencies.sendToServer || sendToServer;
  const yeaftDir = dependencies.yeaftDir ?? ctx.CONFIG?.yeaftDir;
  const incomingLanguage = typeof msg.config?.language === 'string' && msg.config.language
    ? msg.config.language
    : null;
  let previousDefaultModel = null;
  try {
    const previousConfig = readConfig({ dir: yeaftDir });
    previousDefaultModel = previousConfig?.primaryModel || previousConfig?.model || null;
  } catch { /* updateLlmConfig will report the actual config error */ }
  const result = updateConfig(msg.config || {}, yeaftDir);
  if (!result.error && incomingLanguage) broadcastLanguage(result.language);

  let statusRefreshError = null;
  if (!result.error) {
    try {
      await refreshRuntimeConfig({ previousDefaultModel });
    } catch (err) {
      statusRefreshError = err?.message || String(err);
    }
    try {
      const statusEvent = await forceStatusRefresh({ reason: 'llm_config_updated' });
      statusRefreshError = statusRefreshError || statusEvent?.refreshError || null;
    } catch (err) {
      statusRefreshError = statusRefreshError || err?.message || String(err);
    }
  }

  const response = {
    type: 'llm_config_updated',
    ...result,
    agentId: msg.agentId ?? null,
    requestId: msg.requestId ?? null,
    statusRefreshError,
  };
  send(response);
  return response;
}

export function applyRegisteredTransport(msg) {
  ctx.serverCapabilities = new Set(Array.isArray(msg.serverCapabilities) ? msg.serverCapabilities : []);
  if (msg.sessionKey) {
    ctx.sessionKey = decodeKey(msg.sessionKey);
    console.log('Encryption enabled');
  }

  // New servers advertise plaintext acceptance. This mutation is scoped to
  // the active connection because connect() restores conservative defaults.
  if (msg.acceptPlaintext === true) {
    ctx.serverEncryptionRequired = false;
    console.log('[WS] Server accepts plaintext, disabling outbound encryption');
  }
}

export async function handleMessage(msg) {
  if (await handleBrowserRuntimeMessage(msg)) return;
  switch (msg.type) {
    case 'registered':
      applyRegisteredTransport(msg);

      // 只保存基本配置。instanceId 是本地服务实例身份；agentName 只用于展示。
      ctx.saveConfig({
        instanceId: ctx.CONFIG.instanceId,
        serverUrl: ctx.CONFIG.serverUrl,
        agentName: ctx.CONFIG.agentName,
        workDir: ctx.CONFIG.workDir,
        yeaftDir: ctx.CONFIG.yeaftDir,
        reconnectInterval: ctx.CONFIG.reconnectInterval
        // 不保存 agentSecret 到配置文件（安全考虑）
      });
      ctx.AGENT_ID = msg.agentId;
      ctx.agentId = msg.agentId;
      console.log(`Registered as agent: ${msg.agentId} (name: ${ctx.CONFIG.agentName})`);

      // Check server-pushed upgrade notification
      if (msg.upgradeAvailable) {
        console.log(`\n  Update available: ${ctx.agentVersion} → ${msg.upgradeAvailable}`);
        console.log(`  Run "yeaft-agent upgrade" to update\n`);
      }

      sendConversationList();
      sendAgentMetricsSnapshot();
      startYeaftStatusRefresh();

      // fix-yeaft-session-per-agent: eagerly broadcast this agent's
      // yeaft session snapshot on register so the unified sidebar can
      // populate ALL online agents' rows without waiting for the user
      // to send a first yeaft message (which is what historically
      // triggered ensureSessionLoaded → snapshot emit). This fixes the
      // "switch to Agent B and B's sessions are invisible" symptom.
      // The callee already wraps its FS scan + emit in try/catch and
      // logs via console.warn — no second guard needed here.
      broadcastYeaftSessionSnapshotEager();
      // Stock VPs are bundled Agent data. Seed + publish them during register so
      // a first-install user can open the create dialog immediately instead of
      // depending on a later Session runtime or modal subscription race.
      broadcastYeaftVpSnapshotEager();

      // ★ Flush 断连期间缓冲的消息
      await flushMessageBuffer();
      await ctx.assetOutbox?.drain();

      // ★ Phase 1: 通知 server 同步完成
      const runtimeConfig = loadConfig({ dir: ctx.CONFIG?.yeaftDir });
      sendToServer({ type: 'agent_sync_complete', dreamEnabled: runtimeConfig.dream?.enabled === true });

      // ★ 发送 MCP servers 列表给 server（供前端 Settings > Tools tab 使用）
      if (ctx.mcpServers.length > 0) {
        sendToServer({ type: 'mcp_servers_list', servers: ctx.mcpServers });
      }

      // ★ Preload slash commands for immediate skill availability in new sessions.
      // Load Claude/CLI commands first; Yeaft skill preload merges into that
      // cache instead of making Claude Chat think the Yeaft-only list is final.
      preloadSlashCommands()
        .catch(() => {})
        .finally(() => { preloadYeaftSkillSlashCommands(); });
      break;

    case 'yeaft_asset_ack':
      if ((msg.ok === true || msg.permanent === true) && ctx.assetOutbox?.acknowledge(msg.deliveryId)) {
        ctx.assetOutbox.drain().catch(err => console.warn('[AssetOutbox] drain failed:', err?.message || err));
      }
      break;

    case 'create_conversation':
      await createConversation(msg);
      break;

    case 'request_slash_commands':
      preloadSlashCommands().catch(() => {});
      break;

    case 'resume_conversation':
      await resumeConversation(msg);
      break;

    case 'delete_conversation':
      deleteConversation(msg);
      break;

    case 'get_conversations':
      sendConversationList();
      break;

    case 'get_agent_metrics':
      sendAgentMetricsSnapshot();
      break;

    case 'list_history_sessions':
      await handleListHistorySessions(msg);
      break;

    case 'list_folders':
      await handleListFolders(msg);
      break;

    case 'list_models':
      await handleListModels(msg);
      break;

    case 'transfer_files':
      await handleTransferFiles(msg);
      break;

    case 'execute':
      await handleUserInput(msg);
      break;

    case 'btw_question':
      await handleBtwQuestion(msg);
      break;

    case 'cancel_execution':
      await handleCancelExecution(msg);
      break;

    // clear_queue 和 cancel_queued_message 已移至 server 端管理 (Phase 3.6)

    case 'refresh_conversation':
      await handleRefreshConversation(msg);
      break;

    case 'ping_session':
      handlePingSession(msg);
      break;

    // Terminal (PTY) messages
    case 'terminal_create':
      await handleTerminalCreate(msg);
      break;

    case 'terminal_input':
      handleTerminalInput(msg);
      break;

    case 'terminal_resize':
      handleTerminalResize(msg);
      break;

    case 'terminal_close':
      handleTerminalClose(msg);
      break;

    // File operation messages
    case 'read_file':
      await handleReadFile(msg);
      break;

    case 'write_file':
      await handleWriteFile(msg);
      break;

    case 'list_directory':
      await handleListDirectory(msg);
      break;

    case 'git_status':
      await handleGitStatus(msg);
      break;

    case 'git_diff':
      await handleGitDiff(msg);
      break;

    case 'git_add':
      await handleGitAdd(msg);
      break;

    case 'git_reset':
      await handleGitReset(msg);
      break;

    case 'git_restore':
      await handleGitRestore(msg);
      break;

    case 'git_commit':
      await handleGitCommit(msg);
      break;

    case 'git_push':
      await handleGitPush(msg);
      break;

    case 'file_search':
      await handleFileSearch(msg);
      break;

    case 'resolve_file_references':
      await handleResolveFileReferences(msg);
      break;

    case 'create_file':
      await handleCreateFile(msg);
      break;

    case 'delete_files':
      await handleDeleteFiles(msg);
      break;

    case 'move_files':
      await handleMoveFiles(msg);
      break;

    case 'copy_files':
      await handleCopyFiles(msg);
      break;

    case 'upload_to_dir':
      await handleUploadToDir(msg);
      break;

    case 'update_conversation_settings':
      handleUpdateConversationSettings(msg);
      break;

    case 'ask_user_answer':
      handleAskUserAnswer(msg);
      break;

    case 'yeaft_ask_user_answer':
      handleYeaftAskUserAnswer(msg);
      break;


    // Port proxy
    case 'proxy_request':
      handleProxyHttpRequest(msg);
      break;

    case 'proxy_ws_open':
      handleProxyWsOpen(msg);
      break;

    case 'proxy_ws_message':
      handleProxyWsMessage(msg);
      break;

    case 'proxy_ws_close':
      handleProxyWsClose(msg);
      break;

    case 'proxy_update_ports':
      ctx.proxyPorts = msg.ports || [];
      sendToServer({ type: 'proxy_ports_update', ports: ctx.proxyPorts });
      break;

    case 'restart_agent':
      await handleRestartAgent({ requestId: msg.requestId, clientId: msg.clientId });
      break;

    case 'set_dream_enabled': {
      const enabled = msg.enabled !== false;
      try {
        mutateAgentConfig(ctx.CONFIG?.yeaftDir, (config) => {
          if (!config.dream || typeof config.dream !== 'object' || Array.isArray(config.dream)) config.dream = {};
          config.dream.enabled = enabled;
        });
        const persisted = loadConfig({ dir: ctx.CONFIG?.yeaftDir }).dream?.enabled === true;
        if (persisted !== enabled) throw new Error('Dream setting was not persisted');
        try {
          setLiveDreamEnabled(persisted);
        } catch (error) {
          console.warn('[Dream] persisted setting but live runtime update failed:', error?.message || error);
        }
        sendToServer({ type: 'dream_enabled_changed', enabled: persisted, requestId: msg.requestId, clientId: msg.clientId });
      } catch (error) {
        sendToServer({ type: 'dream_enabled_changed', enabled: !enabled, error: error?.message || String(error), requestId: msg.requestId, clientId: msg.clientId });
      }
      break;
    }

    case 'upgrade_agent':
      await handleUpgradeAgent({ requestId: msg.requestId, clientId: msg.clientId });
      break;

    // MCP configuration
    case 'get_mcp_servers':
      sendToServer({ type: 'mcp_servers_list', servers: ctx.mcpServers });
      break;

    case 'update_mcp_config': {
      const updated = updateMcpConfig(msg.config || {});
      sendToServer({ type: 'mcp_config_updated', servers: updated });
      break;
    }

    // LLM configuration (read/write this agent's ~/.yeaft/config.json)
    case 'get_llm_config': {
      const config = getLlmConfig(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'llm_config', requestId: msg.requestId, ...config });
      break;
    }

    case 'discover_llm_models': {
      try {
        const result = await discoverLlmModels(msg || {});
        sendToServer({
          type: 'llm_models_discovered',
          agentId: msg.agentId,
          requestId: msg.requestId,
          providerType: msg.providerType || msg.provider || msg.preset,
          ...result,
        });
      } catch (e) {
        sendToServer({
          type: 'llm_models_discovered',
          agentId: msg.agentId,
          requestId: msg.requestId,
          providerType: msg.providerType || msg.provider || msg.preset,
          error: e.message || String(e),
        });
      }
      break;
    }

    case 'update_llm_config': {
      // The bridge publishes the replacement config and provider index at the
      // next Engine loop boundary. The frontend must not reset or abort the
      // active Session turn after a successful save.
      await applyLlmConfigUpdate(msg);
      break;
    }

    // models.dev registry (community-maintained provider/model catalog).
    // Used by the LLM settings preset picker to populate provider + model lists.
    case 'get_models_dev_registry': {
      try {
        const data = await fetchModelsDev({
          forceRefresh: !!msg.forceRefresh,
          yeaftDir: ctx.CONFIG?.yeaftDir,
        });
        sendToServer({
          type: 'models_dev_registry',
          requestId: msg.requestId || null,
          registry: data,
          fetchedAt: Date.now(),
        });
      } catch (err) {
        sendToServer({
          type: 'models_dev_registry',
          requestId: msg.requestId || null,
          registry: {},
          error: err?.message || String(err),
        });
      }
      break;
    }

    // task-318: Yeaft runtime settings (thread concurrency + auto-archive).
    // Read/write the nested `yeaft` section of config.json — LLM fields
    // untouched. On update we broadcast a `yeaft_settings_updated` event
    // so the UI reflects the new values and in-process consumers
    // (ThreadEngineRegistry, ThreadStore) can reload their caps.
    case 'get_yeaft_settings':
    case 'get_unify_settings': {
      const settings = getYeaftSettings(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'yeaft_settings', ...settings });
      break;
    }

    case 'get_yeaft_plugins': {
      const result = getPluginConfig(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'yeaft_plugins', requestId: msg.requestId || null, ...result });
      break;
    }

    case 'update_yeaft_plugins': {
      const hasPlugins = Object.prototype.hasOwnProperty.call(msg, 'plugins');
      const hasConfig = Object.prototype.hasOwnProperty.call(msg, 'config');
      const payload = hasPlugins ? msg.plugins : (hasConfig ? msg.config : {});
      const result = updatePluginConfig(payload, ctx.CONFIG?.yeaftDir);
      if (!result.error) {
        try { await refreshLiveSessionConfig(); } catch { /* next runtime load still sees disk config */ }
      }
      sendToServer({ type: 'yeaft_plugins_updated', requestId: msg.requestId || null, ...result });
      break;
    }

    case 'update_yeaft_settings':
    case 'update_unify_settings': {
      const result = updateYeaftSettings(msg.settings || msg.config || {}, ctx.CONFIG?.yeaftDir);
      // Let live consumers pick up the new caps without a session restart.
      // The registry/store are created per-session; we update the exported
      // accessors so subsequent dispatches see the new values.
      if (!result.error && ctx.yeaftRuntimeSettings) {
        ctx.yeaftRuntimeSettings.maxConcurrentThreads = result.maxConcurrentThreads;
        ctx.yeaftRuntimeSettings.autoArchiveIdleDays = result.autoArchiveIdleDays;
      }
      sendToServer({ type: 'yeaft_settings_updated', ...result });
      break;
    }

    // Local performance telemetry settings — read/write the `telemetry`
    // section of config.json. This does not expose trace payloads.
    case 'get_telemetry_settings': {
      const settings = getTelemetrySettings(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'telemetry_settings', requestId: msg.requestId, clientId: msg.clientId, ...settings });
      break;
    }

    case 'update_telemetry_settings': {
      const result = updateTelemetrySettings(msg.settings || msg.config || {}, ctx.CONFIG?.yeaftDir);
      if (!result.error) {
        // Bridge trace producers use the agent-owned config object directly.
        // The result is the normalized section that was successfully written,
        // so apply it before refresh can yield and leave no enabled-by-default
        // gap for diagnostics emitted outside a loaded Session.
        if (ctx.CONFIG && typeof ctx.CONFIG === 'object') {
          ctx.CONFIG.telemetry = { ...result };
        }
        try {
          await refreshLiveSessionConfig({});
        } catch (error) {
          result.runtimeRefreshError = error?.message || String(error);
        }
      }
      sendToServer({ type: 'telemetry_settings_updated', requestId: msg.requestId, clientId: msg.clientId, ...result });
      break;
    }

    // Search settings (web-search backend + Tavily key) — read/write the
    // `search` section of config.json. `get_tavily_usage` hits Tavily's
    // /usage endpoint with the saved key and is fired from the UI only
    // when the Search tab opens or the user clicks "Refresh" (no polling
    // — the user explicitly asked for live read on open).
    case 'get_search_settings': {
      const settings = getSearchSettings(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'search_settings', ...settings });
      break;
    }

    case 'update_search_settings': {
      const result = updateSearchSettings(msg.settings || msg.config || {}, ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'search_settings_updated', ...result });
      break;
    }

    case 'get_tavily_usage': {
      const usage = await fetchTavilyUsage(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'tavily_usage', ...usage });
      break;
    }

    // Yeaft MCP CRUD (Claude-Code-style Settings → MCP tab).
    // Each wire op mutates ~/.yeaft/config.json `mcpServers` AND, when
    // the session is alive, mirrors the change into `mcpManager` + hot-
    // swaps the live `toolRegistry`. See handlers in web-bridge.js for
    // the broadcast contract (`yeaft_mcp_updated`).
    case 'yeaft_mcp_list':
      handleYeaftMcpList(msg);
      break;

    case 'yeaft_mcp_add':
      await handleYeaftMcpAdd(msg);
      break;

    case 'yeaft_mcp_remove':
      await handleYeaftMcpRemove(msg);
      break;

    case 'yeaft_mcp_reload':
      await handleYeaftMcpReload(msg);
      break;

    // Yeaft — single conversation backed by the default session.
    //
    // Wire-alias scope: the `yeaft_group_chat` op (and its envelope
    // dual-emit) was REMOVED in this rename. The `unify_*` aliases (and
    // the `yeaft_*_group` CRUD aliases below) are PRE-EXISTING wire-
    // compat hooks from earlier renames (Unify→Yeaft, Phase 2
    // group→session); they remain so older agent / web bundles in the
    // wild keep working. Deleting them is a separate, future PR with
    // its own deployment plan.
    case 'yeaft_session_chat':
    case 'unify_group_chat':
      await handleYeaftSessionSend(msg);
      break;

    case 'yeaft_project_context_sync':
      handleYeaftProjectContextSync(msg);
      break;

    case 'yeaft_project_mutation':
      handleYeaftProjectMutation(msg);
      break;

    case 'yeaft_load_history':
    case 'unify_load_history':
      await handleYeaftLoadHistory(msg);
      break;

    case 'yeaft_load_history_outline':
      await handleYeaftLoadHistoryOutline(msg);
      break;

    case 'yeaft_search_history':
      await handleYeaftSearchHistory(msg);
      break;

    case 'yeaft_load_history_window':
      await handleYeaftLoadHistoryWindow(msg);
      break;

    case 'yeaft_load_more_history':
    case 'unify_load_more_history':
      await handleYeaftLoadMoreHistory(msg);
      break;

    case 'yeaft_mode_switch':
    case 'unify_mode_switch':
      handleYeaftModeSwitch(msg);
      break;

    case 'yeaft_model_switch':
    case 'unify_model_switch':
      handleYeaftModelSwitch(msg);
      break;

    case 'yeaft_reset':
    case 'unify_reset':
      await resetYeaftSession();
      break;

    case 'yeaft_abort_thread':
    case 'unify_abort_thread':
      // task-325c: user-initiated abort of an in-flight query. The
      // legacy `threadId` field on the payload is accepted but ignored
      // (H2.f.5: single-conversation model).
      handleYeaftAbortThread(msg);
      break;

    case 'yeaft_abort_all':
    case 'unify_abort_all':
      // task-325c: user-initiated abort. With sessionId present this is scoped
      // to that Yeaft Session; older clients omit it and keep abort-all.
      handleYeaftAbortAll(msg);
      break;

    case 'yeaft_abort_turn':
    case 'unify_abort_turn':
      // Per-VP stop: abort a single VP turn by turnId.
      handleYeaftAbortTurn(msg);
      break;

    // task-334-ui-a: VP library subscribe — replies with one-shot
    // vp_snapshot event. Live diff (vp_updated/vp_removed) deferred to 334h.
    case 'yeaft_vp_subscribe':
    case 'unify_vp_subscribe':
      handleYeaftVpSubscribe(msg);
      break;

    // task-334-ui-g: VP CRUD (create / update / delete / read-single).
    // All four reply via `vp_crud_result`; VpLoader's rescan emits the
    // authoritative `vp_updated` / `vp_removed` events so the store stays
    // in sync without a bespoke ack path.
    case 'yeaft_plugin_catalog':
      handleYeaftPluginCatalog(msg);
      break;

    case 'yeaft_managed_skill':
      handleYeaftManagedSkill(msg);
      break;

    case 'yeaft_vp_create':
    case 'unify_vp_create':
      handleYeaftVpCreate(msg);
      break;
    case 'yeaft_vp_update':
    case 'unify_vp_update':
      handleYeaftVpUpdate(msg);
      break;
    case 'yeaft_vp_delete':
    case 'unify_vp_delete':
      handleYeaftVpDelete(msg);
      break;
    case 'yeaft_vp_read':
    case 'unify_vp_read':
      handleYeaftVpRead(msg);
      break;

    // task-334m: Group CRUD + D1 seed wiring (§Δ10 334m + R6 §Δ31.2).
    // All handlers reply via `group_crud_result`; mutating ops additionally
    // emit `group_roster_changed` (add/remove/default) or
    // `group_list_updated` (create/rename/archive) for listener sync.
    case 'yeaft_list_groups':
    case 'unify_list_groups':
    case 'yeaft_list_sessions':
      handleYeaftListSessions(msg);
      break;
    case 'yeaft_create_group':
    case 'unify_create_group':
    case 'yeaft_create_session':
      handleYeaftCreateSession(msg);
      break;
    case 'yeaft_rename_group':
    case 'unify_rename_group':
    case 'yeaft_rename_session':
      handleYeaftRenameSession(msg);
      break;
    case 'yeaft_update_group':
    case 'unify_update_group':
    case 'yeaft_update_session':
      handleYeaftUpdateSession(msg);
      break;
    case 'yeaft_update_group_config':
    case 'unify_update_group_config':
    case 'yeaft_update_session_config':
      handleYeaftUpdateSessionConfig(msg);
      break;
    case 'yeaft_archive_group':
    case 'unify_archive_group':
    case 'yeaft_archive_session':
      handleYeaftArchiveSession(msg);
      break;
    case 'yeaft_delete_group':
    case 'unify_delete_group':
    case 'yeaft_delete_session':
      handleYeaftDeleteSession(msg);
      break;
    case 'yeaft_add_member':
    case 'unify_add_member':
    case 'yeaft_session_add_member':
      handleYeaftSessionAddMember(msg);
      break;
    case 'yeaft_remove_member':
    case 'unify_remove_member':
    case 'yeaft_session_remove_member':
      handleYeaftSessionRemoveMember(msg);
      break;
    case 'yeaft_set_default_vp':
    case 'unify_set_default_vp':
    case 'yeaft_session_set_default_vp':
      handleYeaftSessionSetDefaultVp(msg);
      break;
    // feat-yeaft-session-restore: probe + register a session by workdir.
    // `scan_workdir` is read-only (lists what's on disk + flags whether it's
    // already in the central registry); `restore` writes the registry entry
    // and triggers a snapshot rebroadcast so the sidebar updates.
    case 'yeaft_scan_workdir_sessions':
      handleYeaftScanWorkdirSessions(msg);
      break;
    case 'yeaft_restore_session':
      handleYeaftRestoreSession(msg);
      break;
    // Phase 2: session_send is just group_chat (N≥1 fan-out already works).
    case 'yeaft_session_send':
      handleYeaftSessionSend(msg);
      break;
    case 'yeaft_sub_agent_prompt':
      handleYeaftSubAgentPrompt(msg);
      break;
    case 'yeaft_task_cancel':
      handleYeaftTaskCancel(msg);
      break;

    // wave-6b: manual dream trigger from VP detail page
    case 'yeaft_dream_trigger':
    case 'unify_dream_trigger':
      await handleYeaftDreamTrigger(msg);
      break;

    // 2026-05-13: per-tool call counters for the Yeaft debug drawer.
    case 'yeaft_fetch_tool_stats':
    case 'unify_fetch_tool_stats':
      await handleYeaftFetchToolStats(msg);
      break;

    // Hydrate the Yeaft debug panel from the persistent file-backed trace.
    // Without this, the panel only shows turns that happened after it was
    // opened — every previous turn is invisible.
    case 'yeaft_fetch_debug_history':
    case 'unify_fetch_debug_history':
      await handleYeaftFetchDebugHistory(msg);
      break;

    case 'work_center_request':
      if (ctx.CONFIG?.workCenterEnabled === true) {
        await handleWorkCenterRequest(msg);
      } else {
        await sendToServer({
          type: 'work_center_response',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
          op: typeof msg.op === 'string' ? msg.op : '',
          ok: false,
          error: 'Work Center is disabled',
          _requestUserId: msg._requestUserId || null,
        });
      }
      break;

    // Expert roles definition (for ExpertPanel detail view)
    case 'get_expert_roles': {
      const { getExpertRolesDefinition } = await import('../expert-roles.js');
      sendToServer({ type: 'expert_roles_list', roles: getExpertRolesDefinition() });
      break;
    }
  }
}
