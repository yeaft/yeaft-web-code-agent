/**
 * groups/ — Group Coordinator module (task-334b).
 *
 * Layered over 334o storage + 334a VP Registry. Provides:
 *   - Persistent group directory (group.json + messages/ jsonl-log)
 *   - Roster mutation helpers
 *   - Coordinator that parses @-mentions on USER messages and dispatches to
 *     target RoleInstances via a caller-supplied `deliver(vpId, envelope)`.
 *   - Feature flag reader for `yeaft.multiVp.enabled`
 *   - First-boot default group seeder
 *
 * See agent/yeaft/sessions/coordinator.js for the dispatch contract.
 */

export {
  openSession,
  createSession,
  loadSessionMeta,
  listSessions,
} from './session-store.js';
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
  seedDefaultSession,
  DEFAULT_SESSION_ID,
} from './seed-default.js';
export {
  SessionCrudError,
  makeSessionId,
  ensureDefaultSessionIfEmpty,
  createSessionFromSpec,
  renameSession,
  archiveSession,
  deleteSession,
  purgeArchivedSessions,
  addMember,
  removeMember,
  setSessionDefaultVp,
  snapshotSessions,
  updateSessionConfig,
  updateSessionAnnouncement,
  scanWorkdirSessions,
  restoreSessionToRegistry,
} from './session-crud.js';
export {
  loadSessionConfig,
  saveSessionConfig,
  resolveSessionConfig,
  validateSessionConfig,
  SessionConfigError,
} from './session-config.js';
export {
  nextMsgId,
  nextSessionId,
  newUlidLite,
  isReservedVpId,
  RESERVED_VP_IDS,
  ReservedVpIdError,
  isValidVpId,
  validateVpId,
  InvalidVpIdError,
} from './ids.js';
