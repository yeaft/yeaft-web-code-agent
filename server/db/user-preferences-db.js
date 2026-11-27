import { stmts } from './connection.js';

function parseJsonObject(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeCosmosConfig(existing, patch) {
  const next = { ...existing };
  if (Object.hasOwn(patch, 'constants')) {
    next.constants = { ...(existing.constants || {}), ...patch.constants };
  }
  if (Object.hasOwn(patch, 'planetBindings')) {
    next.planetBindings = { ...patch.planetBindings };
  }
  if (Object.hasOwn(patch, 'drawerWidth')) {
    next.drawerWidth = patch.drawerWidth;
  }
  if (Object.hasOwn(patch, 'uiMode')) {
    next.uiMode = patch.uiMode;
  }
  return next;
}

function toPreferences(row) {
  return {
    sidebarProjectsRatio: row?.sidebar_projects_ratio ?? 0.5,
    sidebarActionsCompact: !!row?.sidebar_actions_compact,
    sidebarCollapsedProjects: parseJsonObject(row?.sidebar_collapsed_projects ?? '{}'),
    sidebarCollapsedSections: parseJsonObject(row?.sidebar_collapsed_sections ?? '{}'),
    cosmosConfig: parseJsonObject(row?.cosmos_config ?? '{}'),
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
    let cosmosJson = null;
    if (Object.hasOwn(patch, 'cosmosConfig')) {
      const existingRow = stmts.getUserPreferences.get(userId);
      const existingCosmos = parseJsonObject(existingRow?.cosmos_config ?? '{}');
      cosmosJson = JSON.stringify(mergeCosmosConfig(existingCosmos, patch.cosmosConfig));
    }
    return toPreferences(stmts.upsertUserPreferences.get(
      userId, ratio, compact, projects, sections, cosmosJson, ratio, compact, cosmosJson,
    ));
  },
};
