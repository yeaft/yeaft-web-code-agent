/**
 * Conductor — 模块入口
 *
 * 导出三大核心子系统：
 * 1. Personas — 18 个人物定义（4 场景）
 * 2. Specialties — specialty 行为定义（通用 + 场景特有）
 * 3. CLAUDE.md Generator — 三段式动态生成
 * 4. Actor — Claude 实例创建/管理/释放
 * 5. Worktree — 按线程的 worktree 管理
 */

// ---- Personas ----
export {
  getPersonaById,
  getPersonasByScenario,
  getPersonaPoolForOrchestrator,
  getAllPersonas,
  getScenarios,
  personasByScenario
} from './personas/index.js';

// ---- Specialties ----
export {
  getSpecialty,
  getSpecialtiesByScenario,
  getThinkingMode,
  isDivergent,
  getPersonalizedBehavior,
  getOutputFormat,
  formatToolRules,
  personaSupportsSpecialty,
  allSpecialties,
  scenarioSpecialties
} from './specialties/index.js';

// ---- CLAUDE.md Generator ----
export {
  generateActorCLAUDEmd,
  generateActorInstanceId,
  generateActorDirName
} from './claudemd-generator.js';

// ---- Actor Management ----
export {
  createActor,
  sendToActor,
  releaseActor,
  releaseAllActors,
  getActor,
  getActiveActors,
  getAllActors,
  getActorPublicState,
  getActorStates,
  classifyActorError,
  actorRegistry
} from './actor.js';

// ---- Worktree Management ----
export {
  createThreadWorktree,
  cleanupTaskWorktrees,
  cleanupAllConductorWorktrees
} from './worktree.js';
