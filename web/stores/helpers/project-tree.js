/**
 * Sidebar folder tree. A Project is a folder; `parentId` nests it under another
 * folder of the same user, and null is the top level. The Server owns the tree
 * invariants (server/db/yeaft-project-db.js); this read model stays defensive
 * and treats a missing parent or a cycle as top level, so every folder renders.
 */

/** Deepest nesting the Server accepts; a top-level folder is depth 1. */
export const MAX_PROJECT_DEPTH = 5;

function compareSiblings(left, right) {
  const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const created = (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
  return created || String(left.id).localeCompare(String(right.id));
}

/**
 * @param {Array<{ id: string, parentId?: string|null, sortOrder?: number, createdAt?: number }>} projects
 */
export function buildProjectTree(projects) {
  const rows = (Array.isArray(projects) ? projects : []).filter(project => project?.id);
  const byId = new Map(rows.map(project => [project.id, project]));
  const parents = new Map();
  for (const project of rows) {
    const parentId = typeof project.parentId === 'string' ? project.parentId : '';
    parents.set(project.id, parentId && parentId !== project.id && byId.has(parentId) ? parentId : null);
  }
  for (const project of rows) {
    const seen = new Set([project.id]);
    for (let current = project.id; parents.get(current);) {
      const parentId = parents.get(current);
      if (seen.has(parentId)) {
        parents.set(current, null);
        break;
      }
      seen.add(parentId);
      current = parentId;
    }
  }
  const children = new Map();
  for (const project of rows) {
    const parentId = parents.get(project.id);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(project);
  }
  for (const list of children.values()) list.sort(compareSiblings);

  const parentOf = id => parents.get(id) ?? null;
  const childrenOf = (id = null) => children.get(id ?? null) || [];
  const pathOf = (id) => {
    const chain = [];
    for (let current = byId.has(id) ? id : null; current; current = parents.get(current)) {
      chain.unshift(byId.get(current));
    }
    return chain;
  };
  const subtreeIds = (id) => {
    if (!byId.has(id)) return [];
    const out = [];
    const visit = (current) => {
      out.push(current);
      for (const child of childrenOf(current)) visit(child.id);
    };
    visit(id);
    return out;
  };
  const heightOf = id => 1 + Math.max(0, ...childrenOf(id).map(child => heightOf(child.id)));
  const depthOf = id => pathOf(id).length;
  return {
    byId,
    parentOf,
    childrenOf,
    pathOf,
    subtreeIds,
    heightOf,
    depthOf,
    /** Whether `projectId` may move under `parentId` (null = top level). */
    canMove(projectId, parentId = null) {
      if (!byId.has(projectId)) return false;
      if (parentId === null) return heightOf(projectId) <= MAX_PROJECT_DEPTH;
      if (!byId.has(parentId) || subtreeIds(projectId).includes(parentId)) return false;
      return depthOf(parentId) + heightOf(projectId) <= MAX_PROJECT_DEPTH;
    },
    /** Every folder in display order with its depth (0 = top level). */
    flatten() {
      const out = [];
      const visit = (parentId, depth) => {
        for (const project of childrenOf(parentId)) {
          out.push({ project, depth });
          visit(project.id, depth + 1);
        }
      };
      visit(null, 0);
      return out;
    },
  };
}
