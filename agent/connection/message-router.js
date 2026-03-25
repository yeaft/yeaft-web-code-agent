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
  sendConversationList, handleBtwQuestion
} from '../conversation.js';
import {
  createCrewSession, handleCrewHumanInput, handleCrewControl,
  addRoleToSession, removeRoleFromSession,
  handleListCrewSessions, handleCheckCrewExists, handleDeleteCrewDir, resumeCrewSession, removeFromCrewIndex, hideCrewSession,
  handleLoadCrewHistory, handleCheckCrewContext
} from '../crew.js';
import {
  createConductorSession, handleListConductorSessions,
  resumeConductorSession, handleConductorUserInput,
  handleUpdateWorkDir, handleUpdateConductorSession,
  stopConductorSession, clearConductorSession,
  hideConductorSession, handleLoadConductorHistory
} from '../conductor.js';
import { sendToServer, flushMessageBuffer } from './buffer.js';
import { handleRestartAgent, handleUpgradeAgent } from './upgrade.js';
import { loadMcpServers, updateMcpConfig } from '../mcp.js';

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
      break;

    case 'create_conversation':
      await createConversation(msg);
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
      await hideCrewSession(msg.sessionId);
      (await import('../conversation.js')).sendConversationList();
      break;

    case 'update_crew_session':
      await (await import('../crew.js')).handleUpdateCrewSession(msg);
      break;

    case 'crew_load_history':
      await handleLoadCrewHistory(msg);
      break;

    // Conductor (V2) messages
    case 'create_conductor_session':
      await createConductorSession(msg);
      break;

    case 'list_conductor_sessions':
      await handleListConductorSessions(msg);
      break;

    case 'resume_conductor_session':
      await resumeConductorSession(msg);
      break;

    case 'conductor_user_input':
      await handleConductorUserInput(msg);
      break;

    case 'conductor_update_workdir':
      await handleUpdateWorkDir(msg);
      break;

    case 'update_conductor_session':
      await handleUpdateConductorSession(msg);
      break;

    case 'stop_conductor_session':
      await stopConductorSession(msg.sessionId);
      break;

    case 'clear_conductor_session':
      await clearConductorSession(msg.sessionId);
      break;

    case 'delete_conductor_session':
      await hideConductorSession(msg.sessionId);
      break;

    case 'conductor_load_history':
      await handleLoadConductorHistory(msg);
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
  }
}
