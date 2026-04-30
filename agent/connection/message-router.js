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
import { handleListHistorySessions, handleListFolders } from '../history.js';
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
import { getLlmConfig, updateLlmConfig, getUnifySettings, updateUnifySettings } from '../unify/config-api.js';
import { handleUnifyChat, handleUnifyGroupChat, handleUnifyModeSwitch, handleUnifyModelSwitch, resetUnifySession, handleUnifyLoadHistory, handleUnifyAbortThread, handleUnifyAbortAll, handleUnifyVpSubscribe, handleUnifyVpCreate, handleUnifyVpUpdate, handleUnifyVpDelete, handleUnifyVpRead, handleUnifyFeatureMessage, handleUnifyFetchSummaryHistory, handleUnifyFeatureCrud, handleUnifyListGroups, handleUnifyCreateGroup, handleUnifyRenameGroup, handleUnifyArchiveGroup, handleUnifyDeleteGroup, handleUnifyAddMember, handleUnifyRemoveMember, handleUnifySetDefaultVp, handleUnifyDreamTrigger } from '../unify/web-bridge.js';

export async function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      if (msg.sessionKey) {
        ctx.sessionKey = decodeKey(msg.sessionKey);
        console.log('Encryption enabled');
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

    // LLM configuration (read/write ~/.yeaft/config.json)
    case 'get_llm_config': {
      const config = getLlmConfig(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'llm_config', ...config });
      break;
    }

    case 'update_llm_config': {
      const result = updateLlmConfig(msg.config || {}, ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'llm_config_updated', ...result });
      break;
    }

    // task-318: Unify runtime settings (thread concurrency + auto-archive).
    // Read/write the nested `unify` section of config.json — LLM fields
    // untouched. On update we broadcast a `unify_settings_updated` event
    // so the UI reflects the new values and in-process consumers
    // (ThreadEngineRegistry, ThreadStore) can reload their caps.
    case 'get_unify_settings': {
      const settings = getUnifySettings(ctx.CONFIG?.yeaftDir);
      sendToServer({ type: 'unify_settings', ...settings });
      break;
    }

    case 'update_unify_settings': {
      const result = updateUnifySettings(msg.settings || msg.config || {}, ctx.CONFIG?.yeaftDir);
      // Let live consumers pick up the new caps without a session restart.
      // The registry/store are created per-session; we update the exported
      // accessors so subsequent dispatches see the new values.
      if (!result.error && ctx.unifyRuntimeSettings) {
        ctx.unifyRuntimeSettings.maxConcurrentThreads = result.maxConcurrentThreads;
        ctx.unifyRuntimeSettings.autoArchiveIdleDays = result.autoArchiveIdleDays;
      }
      sendToServer({ type: 'unify_settings_updated', ...result });
      break;
    }

    // Unify — independent chat via Engine
    case 'unify_chat':
      await handleUnifyChat(msg);
      break;

    // task-338-F4: Unify group-chat dispatch via GroupCoordinator.
    case 'unify_group_chat':
      await handleUnifyGroupChat(msg);
      break;

    case 'unify_load_history':
      await handleUnifyLoadHistory(msg);
      break;

    case 'unify_mode_switch':
      handleUnifyModeSwitch(msg);
      break;

    case 'unify_model_switch':
      handleUnifyModelSwitch(msg);
      break;

    case 'unify_reset':
      await resetUnifySession();
      break;

    case 'unify_abort_thread':
      // task-325c: user-initiated abort of an in-flight query. The
      // legacy `threadId` field on the payload is accepted but ignored
      // (H2.f.5: single-conversation model).
      handleUnifyAbortThread(msg);
      break;

    case 'unify_abort_all':
      // task-325c: user-initiated abort of ALL in-flight queries across
      // every thread. Always emits `unify_aborted` ack.
      handleUnifyAbortAll();
      break;

    // task-334-ui-a: VP library subscribe — replies with one-shot
    // vp_snapshot event. Live diff (vp_updated/vp_removed) deferred to 334h.
    case 'unify_vp_subscribe':
      handleUnifyVpSubscribe(msg);
      break;

    // task-334-ui-g: VP CRUD (create / update / delete / read-single).
    // All four reply via `vp_crud_result`; VpLoader's rescan emits the
    // authoritative `vp_updated` / `vp_removed` events so the store stays
    // in sync without a bespoke ack path.
    case 'unify_vp_create':
      handleUnifyVpCreate(msg);
      break;
    case 'unify_vp_update':
      handleUnifyVpUpdate(msg);
      break;
    case 'unify_vp_delete':
      handleUnifyVpDelete(msg);
      break;
    case 'unify_vp_read':
      handleUnifyVpRead(msg);
      break;

    // task-334h (R6 §Δ28 / §Δ31.6): feature-scoped direct message echo.
    // Replaces the withdrawn R3 `unify_task_private_chat`. Agent validates,
    // stamps msgId + ts, and broadcasts the `feature_message` mirror back.
    case 'unify_feature_message':
      handleUnifyFeatureMessage(msg);
      break;

    // R6 G1a — feature summary history + feature affiliation CRUD.
    case 'unify_fetch_summary_history':
      await handleUnifyFetchSummaryHistory(msg);
      break;
    case 'unify_feature_crud':
      await handleUnifyFeatureCrud(msg);
      break;

    // task-334m: Group CRUD + D1 seed wiring (§Δ10 334m + R6 §Δ31.2).
    // All handlers reply via `group_crud_result`; mutating ops additionally
    // emit `group_roster_changed` (add/remove/default) or
    // `group_list_updated` (create/rename/archive) for listener sync.
    case 'unify_list_groups':
      handleUnifyListGroups(msg);
      break;
    case 'unify_create_group':
      handleUnifyCreateGroup(msg);
      break;
    case 'unify_rename_group':
      handleUnifyRenameGroup(msg);
      break;
    case 'unify_archive_group':
      handleUnifyArchiveGroup(msg);
      break;
    case 'unify_delete_group':
      handleUnifyDeleteGroup(msg);
      break;
    case 'unify_add_member':
      handleUnifyAddMember(msg);
      break;
    case 'unify_remove_member':
      handleUnifyRemoveMember(msg);
      break;
    case 'unify_set_default_vp':
      handleUnifySetDefaultVp(msg);
      break;

    // wave-6b: manual dream trigger from VP detail page
    case 'unify_dream_trigger':
      await handleUnifyDreamTrigger(msg);
      break;

    // Expert roles definition (for ExpertPanel detail view)
    case 'get_expert_roles': {
      const { getExpertRolesDefinition } = await import('../expert-roles.js');
      sendToServer({ type: 'expert_roles_list', roles: getExpertRolesDefinition() });
      break;
    }
  }
}
