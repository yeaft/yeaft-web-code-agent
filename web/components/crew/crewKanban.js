/**
 * crewKanban.js — Feature Kanban 和 TODO 追踪纯逻辑
 * 从 computed 逻辑提取：activeTasks, todosByFeature, featureKanban 等
 */

/**
 * Parse TASKS blocks from crew messages.
 * Returns the latest parsed task list (later blocks override earlier ones).
 */
export function parseCrewTasks(messages) {
  let tasks = [];
  for (const msg of messages) {
    if (msg.type !== 'text' || !msg.content) continue;
    const match = msg.content.match(/---TASKS---([\s\S]*?)---END_TASKS---/);
    if (!match) continue;
    const block = match[1].trim();
    const parsed = [];
    for (const line of block.split('\n')) {
      const m = line.match(/^-\s*\[([ xX])\]\s*(.+)/);
      if (!m) continue;
      const done = m[1] !== ' ';
      let text = m[2].trim();
      let assignee = null;
      let taskId = null;
      const atMatch = text.match(/@(\w+)\s*$/);
      if (atMatch) {
        assignee = atMatch[1];
        text = text.replace(/@\w+\s*$/, '').trim();
      }
      const idMatch = text.match(/#(\S+)/);
      if (idMatch) {
        taskId = idMatch[1];
        text = text.replace(/#\S+/, '').trim();
      }
      parsed.push({ done, text, assignee, taskId });
    }
    if (parsed.length > 0) tasks = parsed;
  }
  return tasks;
}

/**
 * Compute completedTaskIds by matching done crewTasks to activeTasks.
 */
export function computeCompletedTaskIds(doneTasks, activeTasks) {
  const ids = new Set();
  if (doneTasks.length === 0) return ids;
  const activeTaskIdSet = new Set(activeTasks.map(at => at.id));
  for (const task of doneTasks) {
    if (task.taskId && activeTaskIdSet.has(task.taskId)) {
      // Primary: exact taskId match
      ids.add(task.taskId);
    } else if (!task.taskId) {
      // Fallback: exact title match only (no substring matching to avoid false positives)
      const t = task.text.toLowerCase().trim();
      if (!t) continue;
      for (const at of activeTasks) {
        if (t === at.title.toLowerCase().trim()) {
          ids.add(at.id);
        }
      }
    }
    // If task has a taskId but it doesn't match any active task, skip it entirely
  }
  return ids;
}

/**
 * Collect active tasks from persisted features and messages.
 */
export function collectActiveTasks(persistedFeatures, messages) {
  const taskMap = new Map();
  for (const f of (persistedFeatures || [])) {
    taskMap.set(f.taskId, { title: f.taskTitle, createdAt: f.createdAt || 0 });
  }
  for (const msg of (messages || [])) {
    if (msg.taskId && msg.taskTitle && !taskMap.has(msg.taskId)) {
      taskMap.set(msg.taskId, { title: msg.taskTitle, createdAt: msg.timestamp || 0 });
    }
  }
  return Array.from(taskMap, ([id, info]) => ({ id, title: info.title, createdAt: info.createdAt }));
}

/**
 * Build todosByFeature from messages containing TodoWrite tool calls.
 */
export function buildTodosByFeature(messages) {
  if (!messages) return [];

  const historyMap = new Map();
  const latestMap = new Map();

  for (const m of messages) {
    if (m.type !== 'tool' || m.toolName !== 'TodoWrite' || !m.toolInput?.todos) continue;
    // Defensive: ensure todos is an array
    const todos = Array.isArray(m.toolInput.todos) ? m.toolInput.todos : [];
    if (todos.length === 0) continue;
    const key = `${m.taskId || 'global'}::${m.role}`;

    if (!historyMap.has(key)) historyMap.set(key, []);
    historyMap.get(key).push({ timestamp: m.timestamp, todos });

    latestMap.set(key, {
      taskId: m.taskId || null,
      taskTitle: m.taskTitle || null,
      role: m.role, roleIcon: m.roleIcon, roleName: m.roleName,
      todos,
      timestamp: m.timestamp,
    });
  }

  for (const [key, entry] of latestMap) {
    const history = historyMap.get(key) || [];
    entry.todos = entry.todos.map(todo => {
      if (todo.status !== 'in_progress') return todo;
      let startedAt = entry.timestamp;
      for (const snapshot of history) {
        // Defensive: snapshot.todos may not be an array
        const snapshotTodos = Array.isArray(snapshot.todos) ? snapshot.todos : [];
        const match = snapshotTodos.find(t => t.content === todo.content);
        if (match && match.status === 'in_progress') {
          startedAt = snapshot.timestamp;
          break;
        }
      }
      return { ...todo, startedAt };
    });
  }

  const groups = new Map();
  for (const entry of latestMap.values()) {
    const tid = entry.taskId || '_global';
    if (!groups.has(tid)) {
      groups.set(tid, { taskId: entry.taskId, taskTitle: entry.taskTitle, entries: [] });
    }
    groups.get(tid).entries.push(entry);
  }

  return Array.from(groups.values());
}

/**
 * Build featureKanban from activeTasks, todosByFeature, featureBlocks, completedTaskIds.
 */
export function buildFeatureKanban(activeTasks, todosByFeature, featureBlocks, completedTaskIds, globalTaskLabel) {
  const features = new Map();

  for (const task of (activeTasks || [])) {
    features.set(task.id, {
      taskId: task.id,
      taskTitle: task.title,
      todos: [],
      doneCount: 0,
      totalCount: 0,
      activeRoles: [],
      isCompleted: completedTaskIds.has(task.id),
      hasStreaming: false,
      createdAt: task.createdAt || 0,
      lastActivityAt: 0,
    });
  }

  for (const group of (todosByFeature || [])) {
    const tid = group.taskId || '_global';
    let feature = features.get(tid);
    if (!feature) {
      feature = {
        taskId: tid,
        taskTitle: group.taskTitle || globalTaskLabel,
        todos: [],
        doneCount: 0,
        totalCount: 0,
        activeRoles: [],
        isCompleted: false,
        hasStreaming: false,
        createdAt: 0,
        lastActivityAt: 0,
      };
      features.set(tid, feature);
    }
    for (const entry of group.entries) {
      for (const todo of (entry.todos || [])) {
        feature.todos.push({
          ...todo,
          roleIcon: entry.roleIcon,
          roleName: entry.roleName,
          id: `${tid}_${entry.role}_${feature.todos.length}`
        });
        feature.totalCount++;
        if (todo.status === 'completed') feature.doneCount++;
      }
    }
  }

  for (const block of (featureBlocks || [])) {
    if (block.type !== 'feature') continue;
    const feature = features.get(block.taskId);
    if (feature) {
      if (block.activeRoles) feature.activeRoles = block.activeRoles;
      if (block.hasStreaming) feature.hasStreaming = true;
      if (block.lastActivityAt > feature.lastActivityAt) {
        feature.lastActivityAt = block.lastActivityAt;
      }
    }
  }

  return Array.from(features.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Group kanban features into inProgress and completed.
 */
export function groupKanban(featureKanban) {
  const inProgress = [];
  const completed = [];
  if (!Array.isArray(featureKanban)) return { inProgress, completed };
  for (const f of featureKanban) {
    if (f.isCompleted) {
      completed.push(f);
    } else {
      inProgress.push(f);
    }
  }
  return { inProgress, completed };
}

/**
 * Compute kanban total progress.
 */
export function kanbanProgress(featureKanban) {
  let total = 0, done = 0;
  if (!Array.isArray(featureKanban)) return { total, done };
  for (const f of featureKanban) {
    total += f.totalCount;
    done += f.doneCount;
  }
  return { total, done };
}
