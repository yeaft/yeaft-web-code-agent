/**
 * index.js — Public barrel for agent/unify/vp.
 */

export { parseRoleMd, loadVpFromDir, scanVpLibrary, count, DEFAULT_VP_LIB_DIR } from './vp-store.js';
export { RoleInstance } from './role-instance.js';
export { Registry, defaultRegistry } from './registry.js';
export { VpLoader } from './vp-loader.js';

// task-334c
export { buildSystemPrompt } from './system-prompt.js';
export { recallCoreMemory, searchCoreMemory } from './core-memory-recall.js';
export { createEngineBinder } from './engine-binding.js';
export { createTurnRunner } from './run-turn.js';
