/**
 * Feature management tools — persistent feature tracking for Unify work.
 *
 * Features are persisted to ~/.yeaft/features/ via FeatureStore (one folder
 * per feature). Call initFeatureStore(yeaftDir) during session init before
 * tools are used.
 *
 * NOTE (PR-1a refactor): renamed from task-tools.js. Tools renamed
 * Task* → Feature*, exported symbols renamed (taskCreate → featureCreate,
 * etc.), tool param `task_id` → `feature_id`, parent param `parent_id`
 * is unchanged (still refers to a parent feature). The internal
 * feature-store object field names (parentTaskId, taskId, relatedTaskIds,
 * etc.) are still in use here — those rename to feature-equivalents in
 * PR-1b along with the memory schema migration. No backwards-compat
 * aliases are kept (per project policy).
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';
import { FeatureStore } from '../features/store.js';

/** @type {FeatureStore|null} */
let featureStore = null;

/**
 * Initialize the feature store with the yeaft directory.
 * Must be called during session startup before any feature tools are used.
 * @param {string} yeaftDir — Base ~/.yeaft directory
 * @param {{ readOnly?: boolean }} [opts]
 */
export function initFeatureStore(yeaftDir, opts) {
  featureStore = new FeatureStore(yeaftDir, opts);
}

/** Get the feature store instance (for other tools/tests). */
export function getFeatureStore() {
  return featureStore;
}

/** Get current plan text. */
export function getPlan() {
  return featureStore ? featureStore.getPlan() : '';
}

/** Internal helper — ensure store is initialized. */
function requireStore() {
  if (!featureStore) {
    return '{"error":"Feature store not initialized. Session may still be loading."}';
  }
  return null;
}

// ─── FeatureCreate ──────────────────────────────────────

export const featureCreate = defineTool({
  name: 'FeatureCreate',
  description: `Create a new feature for tracking work progress.

Features have a title, description, priority, and status.
Each feature gets its own folder with feature.md, progress.md, and memory.md.
Use this to break down complex work into trackable items.

Pass \`parent_id\` to create a sub-feature under an existing feature.

R6 multi-VP groups (Unify): pass \`group_id\` + \`members\` to create a
collaborative feature inside a group. The caller's vpId becomes the feature
\`initiator\`. \`members\` MUST be a subset of the group's roster — the
tool validates this server-side and returns a \`not_in_roster\` error
otherwise. The user owns invitations; the tool will not auto-invite.

Use \`related_feature_ids\` to soft-link to other features (cross-group OK).`,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short feature title',
      },
      description: {
        type: 'string',
        description: 'Detailed feature description',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Feature priority (default: "medium")',
      },
      parent_id: {
        type: 'string',
        description: 'Parent feature ID for subtasks',
      },
      group_id: {
        type: 'string',
        description: 'R6: group this feature belongs to. Required for multi-VP collaboration features.',
      },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'R6: VP ids participating in this feature (≥1). MUST be ⊆ group roster.',
      },
      related_feature_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'R6: soft-linked feature ids (cross-group OK). See arch §14.',
      },
      // PR-1a: legacy `parent_feature_id` (originally `parent_task_id`,
      // an alias absorbed from the former SpawnTask tool) was removed.
      // Use `parent_id` to create a sub-feature.
    },
    required: ['title'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const {
      title,
      description,
      priority = 'medium',
      parent_id,
      group_id,
      members,
      related_feature_ids,
    } = input;
    if (!title) return JSON.stringify({ error: 'title is required' });

    const parentId = parent_id || null;
    if (parentId && !featureStore.get(parentId)) {
      return JSON.stringify({ error: `Parent feature not found: ${parentId}` });
    }

    // R6 multi-VP fields — validated only when group_id is present, so
    // legacy single-tenant TaskCreate calls keep working.
    let groupId = null;
    let normalizedMembers = null;
    let initiator = null;
    if (group_id) {
      groupId = String(group_id);

      // Validate members ⊆ roster. We resolve the roster via the tool ctx
      // because the tool layer must not import group-store directly (loose
      // coupling — ctx.getGroupRoster is wired in session.js).
      let roster = null;
      if (typeof ctx?.getGroupRoster === 'function') {
        try { roster = ctx.getGroupRoster(groupId); } catch { roster = null; }
      }
      if (!Array.isArray(roster)) {
        return JSON.stringify({
          error: 'group_not_found',
          hint: `group ${groupId} has no roster (group not loaded or doesn't exist)`,
        });
      }

      // Default members to [initiator] if not given (R6 §1.5: members ≥ 1).
      const callerVpId = ctx?.currentVpId || null;
      const candidateMembers = Array.isArray(members) && members.length > 0
        ? members.map(String)
        : (callerVpId ? [callerVpId] : []);
      if (candidateMembers.length === 0) {
        return JSON.stringify({
          error: 'no_members',
          hint: 'Specify members[] (≥1) or call from a VP context (currentVpId resolves to self).',
        });
      }
      const offRoster = candidateMembers.filter((m) => !roster.includes(m));
      if (offRoster.length > 0) {
        return JSON.stringify({
          error: 'not_in_roster',
          offRoster,
          roster,
          hint: 'These VP ids are not in the group roster. Ask the user to invite them first; do not auto-invite.',
        });
      }
      // Always include the caller as a member (initiator must be ∈ members).
      if (callerVpId && !candidateMembers.includes(callerVpId)) {
        if (!roster.includes(callerVpId)) {
          return JSON.stringify({
            error: 'caller_not_in_roster',
            hint: `caller VP ${callerVpId} is not in group ${groupId} roster.`,
          });
        }
        candidateMembers.unshift(callerVpId);
      }
      normalizedMembers = Array.from(new Set(candidateMembers));
      initiator = callerVpId;
    }

    const id = `feat-${randomUUID().slice(0, 8)}`;
    const feature = {
      id,
      title,
      description: description || '',
      priority,
      status: 'pending',
      parentId,
      parentTaskId: parentId, // design §5 canonical field
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (groupId) {
      feature.groupId = groupId;
      feature.members = normalizedMembers;
      if (initiator) feature.initiator = initiator;
      if (Array.isArray(related_feature_ids) && related_feature_ids.length) {
        feature.relatedTaskIds = related_feature_ids.map(String);
      }
    }

    featureStore.create(feature);

    return JSON.stringify({
      success: true,
      feature: {
        id,
        title,
        priority,
        status: 'pending',
        parentTaskId: parentId,
        groupId: groupId || undefined,
        members: normalizedMembers || undefined,
        initiator: initiator || undefined,
      },
      message: groupId
        ? `Feature created in group ${groupId}: ${title} (${id}) with members [${(normalizedMembers || []).join(', ')}]`
        : parentId
          ? `Sub-feature created: ${title} (${id}) under ${parentId}`
          : `Feature created: ${title} (${id})`,
    });
  },
});

// ─── FeatureUpdate ──────────────────────────────────────

export const featureUpdate = defineTool({
  name: 'FeatureUpdate',
  description: `Update a feature's status, priority, or details.

Status values: pending, in_progress, completed, blocked, cancelled`,
  parameters: {
    type: 'object',
    properties: {
      feature_id: {
        type: 'string',
        description: 'Feature ID to update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
        description: 'New feature status',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'New priority',
      },
      title: {
        type: 'string',
        description: 'Updated title',
      },
      description: {
        type: 'string',
        description: 'Updated description',
      },
      result: {
        type: 'string',
        description: 'Feature result or completion notes',
      },
    },
    required: ['feature_id'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { feature_id, status, priority, title, description, result } = input;
    if (!feature_id) return JSON.stringify({ error: 'feature_id is required' });

    const updates = {};
    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (result) updates.result = result;

    const feature = featureStore.update(feature_id, updates);
    if (!feature) return JSON.stringify({ error: `Feature not found: ${feature_id}` });

    return JSON.stringify({
      success: true,
      feature: { id: feature.id, title: feature.title, status: feature.status, priority: feature.priority },
      message: `Feature "${feature.title}" updated`,
    });
  },
});

// ─── FeatureList ────────────────────────────────────────

export const featureList = defineTool({
  name: 'FeatureList',
  description: `List all tracked features with their status.

Shows feature IDs, titles, status, and priority. Filter by status if needed.`,
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
        description: 'Filter by status (optional)',
      },
      include_completed: {
        type: 'boolean',
        description: 'Include completed features (default: true)',
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { status, include_completed = true } = input;

    let results = featureStore.list(status ? { status } : undefined);
    if (!include_completed) {
      results = results.filter(t => t.status !== 'completed');
    }

    const taskItems = results.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      parentId: t.parentId,
      hasResult: !!t.result,
    }));

    // Sort: in_progress first, then pending, then others
    const ORDER = { in_progress: 0, pending: 1, blocked: 2, completed: 3, cancelled: 4 };
    taskItems.sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5));

    return JSON.stringify({
      features: taskItems,
      totalCount: taskItems.length,
      summary: {
        pending: taskItems.filter(t => t.status === 'pending').length,
        in_progress: taskItems.filter(t => t.status === 'in_progress').length,
        completed: taskItems.filter(t => t.status === 'completed').length,
        blocked: taskItems.filter(t => t.status === 'blocked').length,
      },
    }, null, 2);
  },
});

// ─── FeatureGet ─────────────────────────────────────────

export const featureGet = defineTool({
  name: 'FeatureGet',
  description: `Get detailed information about a specific feature, including its progress log and memory.`,
  parameters: {
    type: 'object',
    properties: {
      feature_id: {
        type: 'string',
        description: 'Feature ID to retrieve',
      },
    },
    required: ['feature_id'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { feature_id } = input;
    if (!feature_id) return JSON.stringify({ error: 'feature_id is required' });

    const feature = featureStore.get(feature_id);
    if (!feature) return JSON.stringify({ error: `Feature not found: ${feature_id}` });

    // Find subtasks
    const allTasks = featureStore.list();
    const subtasks = allTasks
      .filter(t => t.parentId === feature_id)
      .map(t => ({ id: t.id, title: t.title, status: t.status }));

    return JSON.stringify({
      ...feature,
      subtasks,
      hasProgress: !!featureStore.getProgress(feature_id),
      hasMemory: !!featureStore.getMemory(feature_id),
    }, null, 2);
  },
});

// ─── FeatureProgress ────────────────────────────────────

export const featureProgress = defineTool({
  name: 'FeatureProgress',
  description: `View or append to a feature's progress log.

The progress log is an append-only timeline of what happened during feature execution.
Use "view" to see the full log, or "append" to add a new entry.`,
  parameters: {
    type: 'object',
    properties: {
      feature_id: {
        type: 'string',
        description: 'Feature ID',
      },
      action: {
        type: 'string',
        enum: ['view', 'append'],
        description: '"view" shows progress log, "append" adds an entry',
      },
      note: {
        type: 'string',
        description: 'Progress note to append (required for "append")',
      },
    },
    required: ['feature_id', 'action'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { feature_id, action, note } = input;
    if (!feature_id) return JSON.stringify({ error: 'feature_id is required' });

    const feature = featureStore.get(feature_id);
    if (!feature) return JSON.stringify({ error: `Feature not found: ${feature_id}` });

    switch (action) {
      case 'view':
        return featureStore.getProgress(feature_id) || '(No progress entries yet)';

      case 'append':
        if (!note) return JSON.stringify({ error: 'note is required for "append"' });
        featureStore.appendProgress(feature_id, note, { status: feature.status });
        return JSON.stringify({ success: true, message: `Progress noted for "${feature.title}"` });

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});

// ─── FeatureMemory ──────────────────────────────────────

export const featureMemory = defineTool({
  name: 'FeatureMemory',
  description: `View or update a feature's memory (context notes, key decisions, references).

Feature memory stores persistent context relevant to the feature — key decisions,
references to files, architectural notes, etc. Unlike progress (append-only),
memory can be rewritten to keep it current.`,
  parameters: {
    type: 'object',
    properties: {
      feature_id: {
        type: 'string',
        description: 'Feature ID',
      },
      action: {
        type: 'string',
        enum: ['view', 'update'],
        description: '"view" shows memory, "update" replaces it',
      },
      content: {
        type: 'string',
        description: 'New memory content (required for "update")',
      },
    },
    required: ['feature_id', 'action'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { feature_id, action, content } = input;
    if (!feature_id) return JSON.stringify({ error: 'feature_id is required' });

    const feature = featureStore.get(feature_id);
    if (!feature) return JSON.stringify({ error: `Feature not found: ${feature_id}` });

    switch (action) {
      case 'view':
        return featureStore.getMemory(feature_id) || '(No memory entries yet)';

      case 'update':
        if (!content) return JSON.stringify({ error: 'content is required for "update"' });
        featureStore.updateMemory(feature_id, content);
        return JSON.stringify({ success: true, message: `Memory updated for "${feature.title}"` });

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});

// ─── FollowupFeature ────────────────────────────────────

export const followupFeature = defineTool({
  name: 'FollowupFeature',
  description: `Create a follow-up feature linked to an existing feature.

Use when a completed feature reveals additional work needed.
The new feature is linked as a child of the original.`,
  parameters: {
    type: 'object',
    properties: {
      parent_feature_id: {
        type: 'string',
        description: 'ID of the original feature',
      },
      title: {
        type: 'string',
        description: 'Follow-up feature title',
      },
      description: {
        type: 'string',
        description: 'Why this follow-up is needed',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
      },
    },
    required: ['parent_feature_id', 'title'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { parent_feature_id, title, description, priority = 'medium' } = input;
    if (!parent_feature_id) return JSON.stringify({ error: 'parent_feature_id is required' });
    if (!title) return JSON.stringify({ error: 'title is required' });

    const parent = featureStore.get(parent_feature_id);
    if (!parent) return JSON.stringify({ error: `Parent feature not found: ${parent_feature_id}` });

    const id = `feat-${randomUUID().slice(0, 8)}`;
    const feature = {
      id,
      title,
      description: description || `Follow-up to: ${parent.title}`,
      priority,
      status: 'pending',
      parentId: parent_feature_id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    featureStore.create(feature);

    return JSON.stringify({
      success: true,
      feature: { id, title, priority, status: 'pending', parentId: parent_feature_id },
      message: `Follow-up feature created: ${title} (linked to ${parent.title})`,
    });
  },
});

// ─── UpdatePlan ─────────────────────────────────────────

export const updatePlan = defineTool({
  name: 'UpdatePlan',
  description: `Update or view the current execution plan.

The plan is a free-form markdown document that describes the overall
approach, steps, and status of the current work.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'update', 'append'],
        description: '"view" shows current plan, "update" replaces it, "append" adds to it',
      },
      content: {
        type: 'string',
        description: 'Plan content (for "update" and "append" actions)',
      },
    },
    required: ['action'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { action, content } = input;

    switch (action) {
      case 'view':
        return featureStore.getPlan() || '(No plan set yet)';

      case 'update':
        if (!content) return JSON.stringify({ error: 'content is required for "update"' });
        featureStore.setPlan(content);
        return JSON.stringify({ success: true, message: 'Plan updated', length: content.length });

      case 'append': {
        if (!content) return JSON.stringify({ error: 'content is required for "append"' });
        const existing = featureStore.getPlan();
        const newPlan = existing ? `${existing}\n\n${content}` : content;
        featureStore.setPlan(newPlan);
        return JSON.stringify({ success: true, message: 'Plan updated (appended)', length: newPlan.length });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});

// ─── FeatureSummaryPost (task-334n) ─────────────────────

import { postSummary } from '../features/summary.js';
import { openGroup } from '../groups/group-store.js';
import { join } from 'path';

/**
 * task-334n §B — initiator posts a progress summary to the group log.
 * Triggers the summary-extractor automatically (§C).
 */
export const featureSummaryPost = defineTool({
  name: 'feature_summary_post',
  description: `Post a progress summary for a multi-VP feature (task-334n).

Only the feature initiator should call this. The summary is written to the
group message log as \`type=summary\` and auto-extracts 2-5 feature-memory
entries (kind=progress|decision) via the feature-memory shard lib.

To revise a prior summary, pass its msgId in \`supersedes\` — the old
summary is marked \`supersededBy\` while staying on disk for audit.`,
  parameters: {
    type: 'object',
    properties: {
      feature_id: { type: 'string', description: 'Target feature id' },
      body:       { type: 'string', description: 'Summary body (markdown)' },
      progress:   { type: 'number', description: '0..100, optional' },
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Prior summary msgIds this revision supersedes',
      },
    },
    required: ['feature_id', 'body'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;
    const { feature_id, body, progress, supersedes } = input || {};
    if (!feature_id || !body) {
      return JSON.stringify({ error: 'feature_id and body are required' });
    }
    const feature = featureStore.get(feature_id);
    if (!feature) return JSON.stringify({ error: `feature not found: ${feature_id}` });
    if (!feature.groupId) {
      return JSON.stringify({ error: 'feature has no groupId; summary requires a group' });
    }

    const currentVpId = ctx?.currentVpId;
    if (currentVpId && feature.initiator && currentVpId !== feature.initiator) {
      return JSON.stringify({ error: 'only the feature initiator may post summaries' });
    }

    const yeaftDir = ctx?.yeaftDir;
    if (!yeaftDir) {
      return JSON.stringify({ error: 'yeaftDir missing from tool context' });
    }
    const groupsRoot = join(yeaftDir, 'groups');
    const memoryDir = join(groupsRoot, feature.groupId, 'features', feature.id, 'memory');

    const group = openGroup(groupsRoot, feature.groupId);
    try {
      const res = postSummary({
        group,
        featureId: feature_id,
        fromVpId: currentVpId || feature.initiator || 'unknown',
        body,
        progress,
        supersedes,
        memoryDir,
      });
      return JSON.stringify({
        success: true,
        messageId: res.message.id,
        memoryIds: res.memoryIds,
        supersededSummaryIds: res.supersededSummaryIds,
      });
    } finally {
      group.close();
    }
  },
});

