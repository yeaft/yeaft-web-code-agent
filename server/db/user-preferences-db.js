import { stmts } from './connection.js';

/** Server-owned browser preferences, scoped to an authenticated user's DB id. */
export const userPreferencesDb = {
  get(userId) {
    const row = stmts.getUserPreferences.get(userId);
    return { sidebarProjectsRatio: row?.sidebar_projects_ratio ?? 0.5 };
  },

  // The HTTP boundary validates the ratio; the schema also enforces its range.
  update(userId, sidebarProjectsRatio) {
    stmts.upsertUserPreferences.run(userId, sidebarProjectsRatio);
    return this.get(userId);
  },
};
