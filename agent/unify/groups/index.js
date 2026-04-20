/**
 * groups/ — Group Coordinator module (task-334b).
 *
 * Layered over 334o storage + 334a VP Registry. Provides:
 *   - Persistent group directory (group.json + messages/ jsonl-log)
 *   - Roster mutation helpers
 *   - Coordinator that parses @-mentions on USER messages and dispatches to
 *     target RoleInstances via a caller-supplied `deliver(vpId, envelope)`.
 *   - Feature flag reader for `unify.multiVp.enabled`
 *   - First-boot default group seeder
 *
 * See agent/unify/groups/coordinator.js for the dispatch contract.
 */

export {
  openGroup,
  createGroup,
  loadGroupMeta,
  listGroups,
} from './group-store.js';
export {
  addVp,
  removeVp,
  setDefaultVp,
  isMember,
  resolveFallbackVp,
} from './roster.js';
export {
  createCoordinator,
  parseMentions,
} from './coordinator.js';
export {
  isMultiVpEnabled,
  setMultiVpEnabled,
} from './feature-flag.js';
export {
  seedDefaultGroup,
  DEFAULT_GROUP_ID,
} from './seed-default.js';
export {
  nextMsgId,
  nextGroupId,
  newUlidLite,
  isReservedVpId,
  RESERVED_VP_IDS,
  ReservedVpIdError,
  isValidVpId,
  validateVpId,
  InvalidVpIdError,
} from './ids.js';
