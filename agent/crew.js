/**
 * Crew Mode - Multi-Agent Orchestrator
 *
 * 管理多个 AI 角色的协作：每个角色是一个独立的持久 query 实例，
 * 编排器负责解析路由、分发消息、管理生命周期。
 *
 * 支持：
 * - 动态添加/移除角色（群聊加人）
 * - 角色级 CLAUDE.md + memory.md（利用 Claude Code 的 CLAUDE.md 自动向上查找机制）
 * - 共享级 .crew/CLAUDE.md（所有角色自动继承）
 * - Session resume（每个角色的 claudeSessionId 持久化）
 * - 自动路由 + 人工混合
 *
 * 本文件为入口模块，聚合并重新导出各子模块的公共 API。
 */

// Session 核心
export {
  crewSessions,
  createCrewSession,
  resumeCrewSession,
  handleListCrewSessions,
  handleCheckCrewExists,
  handleDeleteCrewDir,
  handleUpdateCrewSession
} from './crew/session.js';

// 持久化
export {
  loadCrewIndex,
  removeFromCrewIndex,
  handleLoadCrewHistory
} from './crew/persistence.js';

// 控制操作
export { handleCrewControl } from './crew/control.js';

// 人工交互
export { handleCrewHumanInput } from './crew/human-interaction.js';

// 角色管理
export {
  addRoleToSession,
  removeRoleFromSession
} from './crew/role-management.js';

// Crew 上下文检测
export { handleCheckCrewContext } from './crew/context-loader.js';
