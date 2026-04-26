/**
 * system-prompt.js — assemble a VP's system prompt per architecture §8.
 *
 * Three sections:
 *   § STATIC
 *     - identity (yeaft base — short)
 *     - vp_persona (role.md persona body)
 *     - capabilities (tools) — 334d owns the real list; this slice leaves
 *       a stub that names the MVP tool surface ("route_forward" ...).
 *
 *   § SEMI-DYNAMIC
 *     - group_roster (name + on-line status via Registry.activeCount)
 *     - (skills / mcp / user_profile — owned by other slices; 334c emits
 *       placeholder only if the caller provides them)
 *
 *   § DYNAMIC
 *     - runtime_ctx  { vpId, groupId, taskId?, isDream=false }
 *     - core_memory  (recall top-K; vp single-dim per R3 §Δ2.3)
 *     - task_ctx     (R6 §8: lists active tasks in current group + affiliation
 *                    hint guiding the LLM to call task_create / continue an
 *                    existing task / reply at group level — this is the
 *                    mechanism that lets tasks "auto-emerge" from chat per
 *                    R6 §6 trigger #6.)
 *
 * Caching: the STATIC persona section is cached per RoleInstance via
 * `ri._promptBuiltForMtime === vp.mtimeMs`. DYNAMIC is always rebuilt.
 *
 * Hard constraint (334c): this module does not touch 334f/334g memory
 * internals. It calls `memoryStore.query({vp})` (duck-typed) and falls
 * back to an empty top-K if the store is null.
 */

import { recallCoreMemory } from './core-memory-recall.js';

const CORE_MEMORY_TOP_K = 7;          // §8
const ROSTER_STATUS_ONLINE = 'online';
const ROSTER_STATUS_BUSY = 'busy';

/**
 * Build one complete system prompt string.
 *
 * @param {import('./role-instance.js').RoleInstance} ri
 * @param {{
 *   registry?: import('./registry.js').Registry,
 *   rosterMembers?: string[],           // explicit override (334b GroupHandle.roster)
 *   runtimeCtx?: { taskId?: string|null, isDream?: boolean, recentChatSummary?: string },
 *   capabilitiesLine?: string,          // 334d injects tool inventory
 *   userProfile?: string,               // 334l injects top-5 user-memory
 *   recentGroupChat?: string,           // 334h injects N recent msgs
 *   taskCtx?: {
 *     activeTasks?: Array<{
 *       id: string, title?: string, status?: string,
 *       members?: string[], initiator?: string,
 *       lastActivityAt?: number,
 *     }>,                                // tasks in this group the VP can join/continue
 *     currentTask?: {                    // the task the VP is currently inside
 *       id: string, title?: string, members?: string[], initiator?: string,
 *     },
 *     relatedTasks?: Array<{ id: string, title?: string, groupId?: string }>,
 *   },
 * }} opts
 * @returns {string}
 */
export async function buildSystemPrompt(ri, opts = {}) {
  if (!ri || !ri.vp) throw new Error('buildSystemPrompt: role instance required');
  const vp = ri.vp;

  // ─── § STATIC (cached per mtime) ────────────────────────────
  let staticBlock = ri.systemPrompt;
  if (!staticBlock || ri._promptBuiltForMtime !== vp.mtimeMs) {
    staticBlock = buildStatic(vp, opts.capabilitiesLine);
    ri.systemPrompt = staticBlock;
    ri._promptBuiltForMtime = vp.mtimeMs;
  }

  // ─── § SEMI-DYNAMIC ─────────────────────────────────────────
  const roster = buildRoster(ri, opts.registry, opts.rosterMembers);
  const userProfile = opts.userProfile ? `\n## user_profile\n${opts.userProfile.trim()}\n` : '';

  // ─── § DYNAMIC ──────────────────────────────────────────────
  const ctx = opts.runtimeCtx || {};
  const runtime = buildRuntimeCtx(ri, ctx);
  const recent = opts.recentGroupChat
    ? `\n## recent_group_chat\n${opts.recentGroupChat.trim()}\n`
    : '';
  const coreMem = await buildCoreMemoryBlock(ri, ctx);
  const taskCtx = buildTaskCtxBlock(ri, opts.taskCtx, ctx);

  return [
    '# § STATIC',
    staticBlock,
    '',
    '# § SEMI-DYNAMIC',
    roster,
    userProfile.trim() ? userProfile : '',
    '',
    '# § DYNAMIC',
    runtime,
    recent.trim() ? recent : '',
    coreMem,
    taskCtx,
  ]
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ──────────────────────────────────────────────────────────────
// STATIC
// ──────────────────────────────────────────────────────────────

function buildStatic(vp, capabilitiesLine) {
  const identity =
    'You are a Virtual Person (VP) in a yeaft multi-agent group.\n' +
    'Respect §6 triggers: text @-mentions do NOT route. Use the `route_forward` tool for explicit dispatch.';

  const persona = vp.persona && vp.persona.trim()
    ? vp.persona.trim()
    : `(no persona body for ${vp.id})`;

  const caps = (capabilitiesLine && capabilitiesLine.trim())
    || 'Tools: route_forward, memory_search, memory_trace, task_summary_post (if initiator).';

  // personaHash travels in the static block so downstream (334h live-diff)
  // can detect changes without re-hashing.
  return [
    '## identity',
    identity,
    '',
    `## vp_persona (id=${vp.id}, hash=${vp.personaHash || '-'})`,
    `Name: ${vp.name}`,
    vp.role ? `Role: ${vp.role}` : '',
    vp.traits && vp.traits.length ? `Traits: ${vp.traits.join(', ')}` : '',
    '',
    persona,
    '',
    '## capabilities',
    caps,
  ].filter(Boolean).join('\n');
}

// ──────────────────────────────────────────────────────────────
// SEMI-DYNAMIC — Roster
// ──────────────────────────────────────────────────────────────

function buildRoster(ri, registry, rosterMembers) {
  const members = Array.isArray(rosterMembers) && rosterMembers.length > 0
    ? rosterMembers
    : registry
      ? Array.from(new Set(registry.listRoleInstances()
          .filter((r) => r.groupId === ri.groupId)
          .map((r) => r.vpId)))
      : [ri.vpId];

  const lines = [`## 群成员 (${members.length})`];
  for (const vpId of members) {
    if (vpId === ri.vpId) {
      lines.push(`- 你自己：${vpId}`);
      continue;
    }
    const status = memberStatus(vpId, registry);
    const name = registry?.getVp?.(vpId)?.name || vpId;
    lines.push(`- ${name} (${vpId}) · ${status}`);
  }
  return lines.join('\n');
}

function memberStatus(vpId, registry) {
  if (!registry) return ROSTER_STATUS_ONLINE;
  // §8.2: busy if any RoleInstance for this VP has state==='running' in any group.
  // MVP: also 'running' while 'queued'? — spec says "running RoleInstance 数 > 0".
  const ris = registry.listRoleInstances?.() || [];
  const busy = ris.some((r) => r.vpId === vpId && r.state === 'running');
  return busy ? ROSTER_STATUS_BUSY : ROSTER_STATUS_ONLINE;
}

// ──────────────────────────────────────────────────────────────
// DYNAMIC
// ──────────────────────────────────────────────────────────────

function buildRuntimeCtx(ri, ctx) {
  return [
    '## runtime_ctx',
    `vpId: ${ri.vpId}`,
    `groupId: ${ri.groupId}`,
    ctx.taskId ? `taskId: ${ctx.taskId}` : null,
    `isDream: ${Boolean(ctx.isDream)}`,
  ].filter(Boolean).join('\n');
}

async function buildCoreMemoryBlock(ri, ctx) {
  if (!ri.memoryStore) return '';
  const entries = await recallCoreMemory(ri.memoryStore, {
    vp: ri.vpId,
    limit: CORE_MEMORY_TOP_K,
  });
  if (!entries || entries.length === 0) return '';
  void ctx; // task_ctx injection is 334n's scope; reserved param.
  const lines = ['## core_memory'];
  for (const e of entries) {
    const shard = e.shard || 'general';
    const body = (e.body || '').trim();
    if (!body) continue;
    lines.push(`- [mem:${shard}] ${body}`);
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
// DYNAMIC — task_ctx (R6 §6 trigger #6 + §8)
//
// The affiliation hint is the load-bearing piece that lets tasks
// auto-emerge from chat. Without it, VPs never call task_create —
// the spec lists the tool but a model with no nudge will just keep
// chatting at group level. We list active tasks in the group + give
// crisp guidance on when to (a) continue an existing task, (b) start
// a new one, or (c) reply at group level.
// ──────────────────────────────────────────────────────────────

function buildTaskCtxBlock(ri, taskCtx, runtimeCtx) {
  if (!taskCtx) return '';

  const currentTask = taskCtx.currentTask;
  const activeTasks = Array.isArray(taskCtx.activeTasks) ? taskCtx.activeTasks : [];
  const relatedTasks = Array.isArray(taskCtx.relatedTasks) ? taskCtx.relatedTasks : [];

  const otherTasks = activeTasks
    .filter((t) => t && t.id && (!currentTask || t.id !== currentTask.id))
    .slice(0, 8); // cap to avoid prompt bloat — coordinator orders by recency

  // Nothing useful to say — drop the block entirely. Without active tasks,
  // a current task, or related tasks, the affiliation_hint has no anchor.
  if (otherTasks.length === 0 && !currentTask && relatedTasks.length === 0) {
    return '';
  }

  const lines = ['## task_ctx'];

  // (a) currently inside a task → focus on this one
  if (currentTask && currentTask.id) {
    lines.push(`### current_task`);
    lines.push(`- id: ${currentTask.id}`);
    if (currentTask.title) lines.push(`- title: ${currentTask.title}`);
    if (currentTask.initiator) lines.push(`- initiator: ${currentTask.initiator}`);
    if (Array.isArray(currentTask.members) && currentTask.members.length) {
      lines.push(`- members: ${currentTask.members.join(', ')}`);
    }
  }

  // (b) other open tasks in the same group — candidates for affiliation
  if (otherTasks.length > 0) {
    lines.push(`### active_tasks_in_group (${otherTasks.length})`);
    for (const t of otherTasks) {
      const parts = [`- ${t.id}`];
      if (t.title) parts.push(`"${t.title}"`);
      if (t.status) parts.push(`(${t.status})`);
      if (Array.isArray(t.members) && t.members.length) {
        parts.push(`members=[${t.members.join(',')}]`);
      }
      lines.push(parts.join(' '));
    }
  }

  // (c) related tasks (recall top-N from §14)
  if (relatedTasks.length > 0) {
    lines.push(`### related_tasks (${relatedTasks.length})`);
    for (const t of relatedTasks.slice(0, 3)) {
      const parts = [`- ${t.id}`];
      if (t.title) parts.push(`"${t.title}"`);
      if (t.groupId && t.groupId !== ri.groupId) parts.push(`(grp:${t.groupId})`);
      lines.push(parts.join(' '));
    }
  }

  // (d) affiliation hint — the actual decision rubric
  // Suppress full hint when already inside a task (focus on continuing).
  const inTask = Boolean(runtimeCtx?.taskId || currentTask?.id);
  if (!inTask) {
    lines.push('');
    lines.push('### affiliation_hint');
    lines.push('Decide BEFORE replying:');
    lines.push('- If this user message clearly continues one of the active_tasks_in_group above,');
    lines.push('  use the `task_message` route (other VPs in that task will see your reply, others will not).');
    lines.push('- If this is a NEW multi-turn collaboration worth tracking (decisions, deliverables,');
    lines.push('  multiple VPs needed), call `TaskCreate` with title + members[] + groupId; you become');
    lines.push('  the task initiator and may post `task_summary_post` to broadcast progress.');
    lines.push('- If this is just a quick question / chitchat / single-shot answer, reply at group level — no task.');
    lines.push('Do NOT create a task for trivial back-and-forth. Do NOT continue a task whose topic clearly diverged.');
  } else {
    lines.push('');
    lines.push('### affiliation_hint');
    lines.push('You are inside a task. Stay focused on its scope. Use `task_summary_post` (initiator only)');
    lines.push('to broadcast progress to the group. Use `route_forward` to hand off; do not silently leave.');
  }

  if (lines.length === 1) return '';
  return lines.join('\n');
}
