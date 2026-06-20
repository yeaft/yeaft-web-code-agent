/**
 * message-router.js — Server-bound message dispatcher.
 *
 * task-330c lint guard:
 *   ⚠️ DO NOT introduce greedy `text.replace(/---ROUTE---[\s\S]*$/g, '')`
 *      style strips on routed message payloads. Crew ROUTE stripping is
 *      owned EXCLUSIVELY by `agent/crew/routing.js` `parseRoutes()` which
 *      returns `{routes, displayBody}` with exact ranges removed. A second
 *      strip here would re-process already-cleaned text and risks both
 *      double-strip artefacts and the trailing-prose bug fixed by task-328.
 */
import ctx from '../context.js';
import { decodeKey } from '../encryption.js';
import { handleTerminalCreate, handleTerminalInput, handleTerminalResize, handleTerminalClose } from '../terminal.js';
import { handleProxyHttpRequest, handleProxyWsOpen, handleProxyWsMessage, handleProxyWsClose } from '../proxy.js';
import {
  handleReadFile, handleWriteFile, handleListDirectory,
  handleGitStatus, handleGitDiff, handleGitAdd, handleGitReset, handleGitRestore, handleGitCommit, handleGitPush,
  handleFileSearch, handleCreateFile, handleDeleteFiles, handleMoveFiles, handleCopyFiles, handleUploadToDir, handleTransferFiles
} from '../workbench.js';
import { handleListHistorySessions, handleListFolders, handleListModels } from '../history.js';
import {
  createConversation, resumeConversation, deleteConversation,
  handleRefreshConversation, handleCancelExecution,
  handleUserInput, handleUpdateConversationSettings, handleAskUserAnswer,
  sendConversationList, handleBtwQuestion, preloadSlashCommands,
  handlePingSession
} from '../conversation.js';
import {
  createCrewSession, handleCrewHumanInput, handleCrewControl,
  addRoleToSession, removeRoleFromSession,
  handleListCrewSessions, handleCheckCrewExists, handleDeleteCrewDir, resumeCrewSession, removeFromCrewIndex,
  handleLoadCrewHistory, handleCheckCrewContext
} from '../crew.js';
import { sendToServer, flushMessageBuffer } from './buffer.js';
import { handleRestartAgent, handleUpgradeAgent } from './upgrade.js';
import { loadMcpServers, updateMcpConfig } from '../mcp.js';
import { getLlmConfig, updateLlmConfig, getYeaftSettings, updateYeaftSettings, getSearchSettings, updateSearchSettings, fetchTavilyUsage } from '../yeaft/config-api.js';
import { discoverLlmModels } from '../llm-model-discovery.js';
import { fetchModelsDev } from '../yeaft/llm/models-dev.js';
import { handleYeaftSessionSend, handleYeaftSubAgentPrompt, handleYeaftTaskCancel, handleYeaftModeSwitch, handleYeaftModelSwitch, resetYeaftSession, handleYeaftLoadHistory, handleYeaftLoadMoreHistory, handleYeaftAbortThread, handleYeaftAbortAll, handleYeaftAbortTurn, handleYeaftVpSubscribe, handleYeaftVpCreate, handleYeaftVpUpdate, handleYeaftVpDelete, handleYeaftVpRead, handleYeaftListSessions, handleYeaftCreateSession, handleYeaftRenameSession, handleYeaftUpdateSession, handleYeaftUpdateSessionConfig, handleYeaftArchiveSession, handleYeaftDeleteSession, handleYeaftSessionAddMember, handleYeaftSessionRemoveMember, handleYeaftSessionSetDefaultVp, handleYeaftScanWorkdirSessions, handleYeaftRestoreSession, handleYeaftDreamTrigger, handleYeaftFetchToolStats, handleYeaftFetchDebugHistory, handleYeaftMcpList, handleYeaftMcpAdd, handleYeaftMcpRemove, handleYeaftMcpReload, broadcastLanguageChange, broadcastYeaftSessionSnapshotEager } from '../yeaft/web-bridge.js';
import { startYeaftStatusRefresh, refreshYeaftStatus } from '../yeaft/status-cache.js';

export async function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      if (msg.sessionKey) {
        ctx.sessionKey = decodeKey(msg.sessionKey);
        console.log('Encryption enabled');
      }

      // feat-ws-plaintext-negotiation: new server advertises that it
      // will accept plaintext frames from us. Stop encrypting outbound.
      // The receive path (parseMessage) stays unconditional so the old
      // ciphertext that may already be in flight still decrypts.
      if (msg.acceptPlaintext === true) {
        ctx.serverEncryptionRequired = false;
        console.log('[WS] Server accepts plaintext, disabling outbound encryption');
      }

      // 只保存基本配置（不再保存 agentId，因为现在用 agentName 作为 ID）
      ctx.saveConfig({
        serverUrl: ctx.CONFIG.serverUrl,
        agentName: ctx.CONFIG.agentName,
        workDir: ctx.CONFIG.workDir,
        reconnectInterval: ctx.CONFIG.reconnectInterval
        // 不保存 agentSecret 到配置文件（安全考虑）
      });
      console.log(`Registered as agent: ${msg.agentId} (name: ${ctx.CONFIG.agentName})`);

      // Check server-pushed upgrade notification
      if (msg.upgradeAvailable) {
        console.log(`\n  Update available: ${ctx.agentVersion} → ${msg.upgradeAvailable}`);
        console.log(`  Run "yeaft-agent upgrade" to update\n`);
      }

      sendConversationList();
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

      // ★ Flush 断连期间缓冲的消息
      await flushMessageBuffer();

      // ★ Phase 1: 通知 server 同步完成
      sendToServer({ type: 'agent_sync_complete' });

      // ★ 发送 MCP servers 列表给 server（供前端 Settings > Tools tab 使用）
      if (ctx.mcpServers.length > 0) {
        sendToServer({ type: 'mcp_servers_list', servers: ctx.mcpServers });
      }

      // ★ Preload slash commands for immediate skill availability in new sessions
      preloadSlashCommands().catch(() => {});
      break;

    case 'create_conversation':
      await createConversation(msg);
      break;

    case 'request_slash_commands':
      preloadSlashCommands().catch(() => {});
      break;

    case 'check_crew_context':
      handleCheckCrewContext(msg);
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

    // Crew (multi-agent) messages
    case 'create_crew_session':
      await createCrewSession(msg);
      break;

    case 'crew_human_input':
      await handleCrewHumanInput(msg);
      break;

    case 'crew_control':
      await handleCrewControl(msg);
      break;

    case 'crew_add_role':
      await addRoleToSession(msg);
      break;

    case 'crew_remove_role':
      await removeRoleFromSession(msg);
      break;

    case 'list_crew_sessions':
      await handleListCrewSessions(msg);
      break;

    case 'check_crew_exists':
      await handleCheckCrewExists(msg);
      break;

    case 'delete_crew_dir':
      await handleDeleteCrewDir(msg);
      break;

    case 'resume_crew_session':
      await resumeCrewSession(msg);
      break;

    case 'delete_crew_session':
      await removeFromCrewIndex(msg.sessionId);
      (await import('../conversation.js')).sendConversationList();
      break;

    case 'update_crew_session':
      await (await import('../crew.js')).handleUpdateCrewSession(msg);
      break;

    case 'crew_load_history':
      await handleLoadCrewHistory(msg);
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
      handleRestartAgent();
      break;

    case 'upgrade_agent':
      await handleUpgradeAgent();
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
      sendToServer({ type: 'llm_config', ...config });
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
      // Capture the user's intent BEFORE updateLlmConfig — the return
      // envelope ALWAYS populates `language` (falls back to 'en'), so
      // gating on the *output* would broadcast on every provider /
      // primaryModel / fastModel save, not just locale flips. Gate on
      // the *input* `language` field instead.
      const incomingLanguage = typeof msg.config?.language === 'string' && msg.config.language
        ? msg.config.language
        : null;
      const result = updateLlmConfig(msg.config || {}, ctx.CONFIG?.yeaftDir);
      // task-708: live locale propagation. When the user flips the UI
      // language dropdown, push the new value into every cached Engine
      // (per-VP pool + 1:1 chat session.engine) so the very next turn
      // renders the system prompt in the chosen language without the
      // user reloading the session.
      if (!result.error && incomingLanguage) {
        broadcastLanguageChange(result.language);
      }
      if (!result.error) {
        refreshYeaftStatus({ reason: 'llm_config_updated' }).catch(() => {});
        if (!incomingLanguage) {
          resetYeaftSession().catch(err => {
            console.error('[LLM] Failed to reload Yeaft session after local config update:', err.message);
          });
        }
      }
      sendToServer({ type: 'llm_config_updated', ...result });
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

    case 'yeaft_load_history':
    case 'unify_load_history':
      await handleYeaftLoadHistory(msg);
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

    // fix-vp-multi-thread (bug 4): hydrate the Yeaft debug panel from
    // the persistent SQLite trace. Without this, the panel only shows
    // turns that happened after the panel was opened — every previous
    // turn is invisible.
    case 'yeaft_fetch_debug_history':
    case 'unify_fetch_debug_history':
      await handleYeaftFetchDebugHistory(msg);
      break;

    // Expert roles definition (for ExpertPanel detail view)
    case 'get_expert_roles': {
      const { getExpertRolesDefinition } = await import('../expert-roles.js');
      sendToServer({ type: 'expert_roles_list', roles: getExpertRolesDefinition() });
      break;
    }
  }
}
