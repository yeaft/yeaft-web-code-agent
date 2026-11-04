import { stmts } from './connection.js';

function toPreferences(row) {
  return {
    sidebarProjectsRatio: row?.sidebar_projects_ratio ?? 0.5,
    sidebarActionsCompact: !!row?.sidebar_actions_compact,
  };
}

/** Server-owned browser preferences, scoped to an authenticated user's DB id. */
export const userPreferencesDb = {
  get(userId) {
    return toPreferences(stmts.getUserPreferences.get(userId));
  },

  // The HTTP boundary validates the patch. A single upsert preserves omitted
  // fields without a read/merge/write race between independent clients.
  update(userId, patch) {
    const ratio = patch.sidebarProjectsRatio ?? null;
    const compact = patch.sidebarActionsCompact === undefined ? null : Number(patch.sidebarActionsCompact);
    return toPreferences(stmts.upsertUserPreferences.get(userId, ratio, compact, ratio, compact));
  },
};
