import { stmts } from './connection.js';

function toPreferences(row) {
  return {
    sidebarProjectsRatio: row?.sidebar_projects_ratio ?? 0.5,
    sidebarActionsCompact: !!row?.sidebar_actions_compact,
    sidebarCollapsedProjects: JSON.parse(row?.sidebar_collapsed_projects ?? '{}'),
    sidebarCollapsedSections: JSON.parse(row?.sidebar_collapsed_sections ?? '{}'),
  };
}

/** Server-owned browser preferences, scoped to an authenticated user's DB id. */
export const userPreferencesDb = {
  get(userId) {
    return toPreferences(stmts.getUserPreferences.get(userId));
  },

  // The HTTP boundary validates the patch. A single upsert preserves omitted
  // fields and merges map keys without a read/merge/write race between clients.
  // Empty maps are no-ops; explicit false values remain stored overrides.
  update(userId, patch) {
    const ratio = patch.sidebarProjectsRatio ?? null;
    const compact = patch.sidebarActionsCompact === undefined ? null : Number(patch.sidebarActionsCompact);
    const projects = JSON.stringify(patch.sidebarCollapsedProjects ?? {});
    const sections = JSON.stringify(patch.sidebarCollapsedSections ?? {});
    return toPreferences(stmts.upsertUserPreferences.get(
      userId, ratio, compact, projects, sections, ratio, compact,
    ));
  },
};
