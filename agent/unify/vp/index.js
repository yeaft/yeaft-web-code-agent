/**
 * index.js — Public barrel for agent/unify/vp.
 */

export { parseRoleMd, loadVpFromDir, scanVpLibrary, count, DEFAULT_VP_LIB_DIR } from './vp-store.js';
export { RoleInstance } from './role-instance.js';
export { Registry, defaultRegistry } from './registry.js';
export { VpLoader } from './vp-loader.js';
