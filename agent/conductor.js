/**
 * Conductor Mode — 自适应项目执行引擎
 *
 * V2 的核心入口。与 crew.js 并存，不替代。
 *
 * 本文件聚合并重新导出 conductor 子模块的公共 API，
 * 供 message-router.js 消费。
 *
 * hideConductorSession / handleLoadConductorHistory 需要跨模块依赖，
 * 在这里注入，避免 persistence.js ↔ session.js 循环引用。
 */

// Session 核心
export {
  conductorSessions,
  createConductorSession,
  handleListConductorSessions,
  resumeConductorSession,
  handleConductorUserInput,
  handleUpdateWorkDir,
  handleUpdateConductorSession,
  stopConductorSession,
  clearConductorSession
} from './conductor/session.js';

// 持久化（原始导出）
export { loadConductorIndex } from './conductor/persistence.js';

// 依赖注入包装：hideConductorSession
import { conductorSessions } from './conductor/session.js';
import { sendConductorMessage } from './conductor/ui-messages.js';
import {
  hideConductorSession as _hideConductorSession,
  handleLoadConductorHistory as _handleLoadConductorHistory
} from './conductor/persistence.js';

export async function hideConductorSession(sessionId) {
  return _hideConductorSession(sessionId, conductorSessions);
}

export async function handleLoadConductorHistory(msg) {
  return _handleLoadConductorHistory(msg, conductorSessions, sendConductorMessage);
}

// 信号量
export { globalSemaphore } from './conductor/semaphore.js';
