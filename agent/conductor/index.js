/**
 * Conductor — Module Entry
 *
 * Exports core subsystems:
 * 1. Personas — 18 persona definitions (4 scenarios)
 * 2. Specialties — specialty behavior definitions
 * 3. CLAUDE.md Generator — dynamic 3-section generation
 * 4. Actor — Claude instance create/manage/release
 * 5. Worktree — per-task worktree management
 * 6. Task Runner — Orchestrator ↔ Actor bridge layer
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
  createTaskWorktree,
  cleanupTaskWorktree,
  cleanupAllConductorWorktrees,
  getTaskWorktreePath,
  getActorCwd,
  READ_WRITE_SPECIALTIES
} from './worktree.js';

// ---- Task Runner (Orchestrator ↔ Actor bridge) ----
export {
  startTaskExecution,
  stopTaskExecution,
  stopAllTaskExecutions,
  forwardToTask,
  getOrchestrator
} from './task-runner.js';
