/**
 * Crew — Task 文件管理（系统自动管理）
 * ensureTaskFile, appendTaskRecord, readTaskFile, parseCompletedTasks,
 * updateFeatureIndex, appendChangelog, saveRoleWorkSummary,
 * updateKanban, readKanban
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { getMessages } from '../crew-i18n.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 自动创建 task 进度文件
 */
export async function ensureTaskFile(session, taskId, taskTitle, assignee, summary) {
  const featuresDir = join(session.sharedDir, 'context', 'features');
  const filePath = join(featuresDir, `${taskId}.md`);

  try {
    await fs.access(filePath);
    // 文件已存在，不覆盖
    return;
  } catch {
    // 文件不存在，创建
  }

  await fs.mkdir(featuresDir, { recursive: true });

  const m = getMessages(session.language || 'zh-CN');
  const now = new Date().toISOString();
  const content = `# ${m.featureLabel}: ${taskTitle}
- task-id: ${taskId}
- ${m.statusPending}
- ${m.assigneeLabel}: ${assignee}
- ${m.createdAtLabel}: ${now}

${m.requirementDesc}
${summary}

${m.workRecord}
`;

  await fs.writeFile(filePath, content);

  // 同步到 session.features
  if (!session.features.has(taskId)) {
    session.features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
  }

  console.log(`[Crew] Task file created: ${taskId} (${taskTitle})`);

  // 更新 feature 索引
  updateFeatureIndex(session).catch(e => console.warn('[Crew] Failed to update feature index:', e.message));
}

/**
 * 追加工作记录到 task 文件
 */
export async function appendTaskRecord(session, taskId, roleName, summary) {
  const filePath = join(session.sharedDir, 'context', 'features', `${taskId}.md`);

  try {
    await fs.access(filePath);
  } catch {
    // 文件不存在，跳过
    return;
  }

  const role = session.roles.get(roleName);
  const label = role ? roleLabel(role) : roleName;
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const record = `\n### ${label} - ${now}\n${summary}\n`;

  await fs.appendFile(filePath, record);
  console.log(`[Crew] Task record appended: ${taskId} by ${roleName}`);
}

/**
 * 读取 task 文件内容（用于注入上下文）
 */
export async function readTaskFile(session, taskId) {
  const filePath = join(session.sharedDir, 'context', 'features', `${taskId}.md`);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 从文本中提取已完成任务的 taskId 集合。
 *
 * Primary: parse TASKS block (---TASKS--- / ---END_TASKS---) for checked items with #taskId.
 * Fallback: when no TASKS block is found AND knownTaskIds are provided,
 *   scan the full text for known taskId + completion keyword combinations.
 *   This handles cases where the PM mentions task completion in prose without
 *   emitting a formal TASKS block.
 *
 * @param {string} text - accumulated role output text
 * @param {string[]} [knownTaskIds] - list of known task IDs to search for in fallback mode
 * @returns {Set<string>} completed task IDs
 */
export function parseCompletedTasks(text, knownTaskIds) {
  const ids = new Set();

  // Primary: TASKS block parsing
  const match = text.match(/---TASKS---([\s\S]*?)---END_TASKS---/);
  if (match) {
    for (const line of match[1].split('\n')) {
      const m = line.match(/^-\s*\[[xX]\]\s*.+#(\S+)/);
      if (m) ids.add(m[1]);
    }
    return ids;
  }

  // Fallback: scan plain text for known taskId + completion keywords
  if (!knownTaskIds || knownTaskIds.length === 0) return ids;

  const completionPatterns = [
    /已完成/, /完成/, /已合并/, /合并/, /DONE/, /DONE_MERGED/, /MERGED/,
    /已关闭/, /关闭/, /✅/, /通过/, /passed/i, /merged/i, /completed/i
  ];

  for (const taskId of knownTaskIds) {
    // Search for lines/sentences containing the taskId
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^.*${escaped}.*$`, 'gm');
    let lineMatch;
    while ((lineMatch = re.exec(text)) !== null) {
      const line = lineMatch[0];
      if (completionPatterns.some(p => p.test(line))) {
        ids.add(taskId);
        break;
      }
    }
  }

  return ids;
}

/**
 * 更新 feature 索引文件 .crew/context/features/index.md
 */
export async function updateFeatureIndex(session) {
  const featuresDir = join(session.sharedDir, 'context', 'features');
  await fs.mkdir(featuresDir, { recursive: true });

  const m = getMessages(session.language || 'zh-CN');
  const completed = session._completedTaskIds || new Set();
  const allFeatures = Array.from(session.features.values());

  allFeatures.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const inProgress = allFeatures.filter(f => !completed.has(f.taskId));
  const done = allFeatures.filter(f => completed.has(f.taskId));

  const locale = (session.language === 'en') ? 'en-US' : 'zh-CN';
  const now = new Date().toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
  let content = `${m.featureIndex}\n> ${m.lastUpdated}: ${now}\n`;

  content += `\n${m.inProgressGroup(inProgress.length)}\n`;
  if (inProgress.length > 0) {
    content += `| ${m.colTaskId} | ${m.colTitle} | ${m.colCreatedAt} |\n|---------|------|----------|\n`;
    for (const f of inProgress) {
      const date = f.createdAt ? new Date(f.createdAt).toLocaleDateString(locale) : '-';
      content += `| ${f.taskId} | ${f.taskTitle} | ${date} |\n`;
    }
  }

  content += `\n${m.completedGroup(done.length)}\n`;
  if (done.length > 0) {
    content += `| ${m.colTaskId} | ${m.colTitle} | ${m.colCreatedAt} |\n|---------|------|----------|\n`;
    for (const f of done) {
      const date = f.createdAt ? new Date(f.createdAt).toLocaleDateString(locale) : '-';
      content += `| ${f.taskId} | ${f.taskTitle} | ${date} |\n`;
    }
  }

  await fs.writeFile(join(featuresDir, 'index.md'), content);
  console.log(`[Crew] Feature index updated: ${inProgress.length} in progress, ${done.length} completed`);
}

/**
 * 追加完成汇总到 .crew/context/changelog.md
 */
export async function appendChangelog(session, taskId, taskTitle) {
  const contextDir = join(session.sharedDir, 'context');
  await fs.mkdir(contextDir, { recursive: true });
  const changelogPath = join(contextDir, 'changelog.md');

  const m = getMessages(session.language || 'zh-CN');

  // 读取 feature 文件提取最后一条工作记录作为摘要
  const taskContent = await readTaskFile(session, taskId);
  let summaryText = '';
  if (taskContent) {
    const records = taskContent.split(/\n### /);
    if (records.length > 1) {
      const lastRecord = records[records.length - 1];
      const lines = lastRecord.split('\n');
      summaryText = lines.slice(1).join('\n').trim();
    }
  }
  if (!summaryText) {
    summaryText = m.noSummary;
  }

  // 限制摘要长度
  if (summaryText.length > 500) {
    summaryText = summaryText.substring(0, 497) + '...';
  }

  const locale = (session.language === 'en') ? 'en-US' : 'zh-CN';
  const now = new Date().toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
  const entry = `\n## ${taskId}: ${taskTitle}\n- ${m.completedAt}: ${now}\n- ${m.summaryLabel}: ${summaryText}\n`;

  let exists = false;
  try {
    await fs.access(changelogPath);
    exists = true;
  } catch {}

  if (!exists) {
    await fs.writeFile(changelogPath, `${m.changelogTitle}\n${entry}`);
  } else {
    await fs.appendFile(changelogPath, entry);
  }

  console.log(`[Crew] Changelog appended: ${taskId} (${taskTitle})`);
}

/**
 * Context 超限 clear 前，将角色当前输出摘要保存到 feature 文件
 */
export async function saveRoleWorkSummary(session, roleName, accumulatedText) {
  const roleState = session.roleStates.get(roleName);
  const taskId = roleState?.currentTask?.taskId;
  if (!taskId || !accumulatedText) return;

  // 截取最后 2000 字符作为工作摘要
  const summary = accumulatedText.length > 2000
    ? '...' + accumulatedText.slice(-2000)
    : accumulatedText;

  const m = getMessages(session.language || 'zh-CN');
  await appendTaskRecord(session, taskId, roleName,
    `[${m.kanbanAutoSave}] ${summary}`);
}

// 看板写入锁：防止并发写入
let _kanbanWriteLock = Promise.resolve();

/**
 * 校验 taskId 是否合法。
 * 拒绝：占位符（<task-id>、task-XX）、纯数字、空/带尖括号。
 * 允许：以字母开头、字母数字/连字符/下划线，例如 task-289、fix-crew-xxx。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isValidTaskId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (!s) return false;
  if (s.includes('<') || s.includes('>')) return false;
  // explicit placeholder
  if (/^task-x+$/i.test(s)) return false;
  // pure digits (e.g. bare "279")
  if (/^\d+$/.test(s)) return false;
  // must start with a letter and contain only alnum/_/-
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,79}$/.test(s)) return false;
  return true;
}

/**
 * 规范化 "最新进展" 摘要：
 * - 换行/回车合并为单空格
 * - 去掉 markdown 分隔符 `---`、heading `##`
 * - 转义 `|` 为 `\|`（避免撑坏表格）
 * - 合并多余空白
 * - 截断到 maxLen 字符（默认 80），超出追加 …
 *
 * @param {string} summary
 * @param {number} [maxLen=80]
 * @returns {string}
 */
export function sanitizeKanbanSummary(summary, maxLen = 80) {
  if (!summary || typeof summary !== 'string') return '-';
  let s = summary;
  // strip horizontal rule lines and heading markers
  s = s.replace(/^\s*-{3,}\s*$/gm, ' ');
  s = s.replace(/^\s*#{1,6}\s+/gm, '');
  // strip leading list/quote markers on each line
  s = s.replace(/^\s*[-*>]\s+/gm, '');
  // newlines → space
  s = s.replace(/[\r\n]+/g, ' ');
  // escape pipe chars so table doesn't break
  s = s.replace(/\|/g, '\\|');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '-';
  if (s.length > maxLen) {
    s = s.substring(0, Math.max(1, maxLen - 1)) + '…';
  }
  return s;
}

/**
 * 更新工作看板 .crew/context/kanban.md
 *
 * @param {object} session
 * @param {object} [opts]
 * @param {string} [opts.taskId] - 要更新的任务 ID
 * @param {string} [opts.assignee] - 负责人
 * @param {string} [opts.status] - 当前状态
 * @param {string} [opts.summary] - 最新进展摘要
 * @param {boolean} [opts.completed] - 是否标记为已完成
 */
export async function updateKanban(session, opts = {}) {
  const doUpdate = async () => {
    const contextDir = join(session.sharedDir, 'context');
    await fs.mkdir(contextDir, { recursive: true });
    const kanbanPath = join(contextDir, 'kanban.md');
    const m = getMessages(session.language || 'zh-CN');

    // 加载现有看板数据
    let entries = new Map(); // taskId → { taskId, taskTitle, assignee, status, summary }
    let completedEntries = new Map();
    try {
      const existing = await fs.readFile(kanbanPath, 'utf-8');
      // 解析表格行
      const lines = existing.split('\n');
      let section = null;
      for (const line of lines) {
        if (line.startsWith('## ') && line.includes('🔨')) section = 'active';
        else if (line.startsWith('## ') && line.includes('✅')) section = 'completed';
        else if (line.startsWith('|') && !line.startsWith('|--') && section) {
          const cols = line.split('|').map(c => c.trim()).filter(Boolean);
          if (cols.length >= 3 && cols[0] !== m.colTaskId && cols[0] !== 'task-id') {
            // Skip illegal / placeholder rows (e.g. <task-id>, task-XX, bare "279")
            if (!isValidTaskId(cols[0])) continue;
            const entry = {
              taskId: cols[0],
              taskTitle: cols[1] || cols[0],
              assignee: cols[2] || '-',
              status: cols[3] || '-',
              summary: sanitizeKanbanSummary(cols[4] || '-')
            };
            if (section === 'completed') {
              completedEntries.set(entry.taskId, entry);
            } else {
              entries.set(entry.taskId, entry);
            }
          }
        }
      }
    } catch { /* 文件不存在 */ }

    // 从 session.features 补充缺失的任务
    const completed = session._completedTaskIds || new Set();
    for (const [taskId, feature] of session.features) {
      if (!isValidTaskId(taskId)) continue;
      if (completed.has(taskId)) {
        if (!completedEntries.has(taskId)) {
          completedEntries.set(taskId, {
            taskId,
            taskTitle: feature.taskTitle,
            assignee: '-',
            status: '✅',
            summary: '-'
          });
        }
        entries.delete(taskId);
      } else if (!entries.has(taskId)) {
        entries.set(taskId, {
          taskId,
          taskTitle: feature.taskTitle,
          assignee: '-',
          status: '-',
          summary: '-'
        });
      }
    }

    // 应用更新
    if (opts.taskId) {
      // Reject illegal task ids early (placeholders, bare numbers, angle brackets, etc.)
      if (!isValidTaskId(opts.taskId)) {
        console.warn(`[Crew] updateKanban: rejected invalid taskId "${opts.taskId}"`);
      } else if (opts.completed) {
        const entry = entries.get(opts.taskId) || completedEntries.get(opts.taskId);
        if (entry) {
          entry.status = '✅';
          if (opts.summary) entry.summary = sanitizeKanbanSummary(opts.summary);
          completedEntries.set(opts.taskId, entry);
          entries.delete(opts.taskId);
        }
      } else {
        let entry = entries.get(opts.taskId);
        if (!entry) {
          const feature = session.features.get(opts.taskId);
          entry = {
            taskId: opts.taskId,
            taskTitle: opts.taskTitle || feature?.taskTitle || opts.taskId,
            assignee: '-',
            status: '-',
            summary: '-'
          };
        }
        if (opts.assignee) entry.assignee = opts.assignee;
        if (opts.status) entry.status = opts.status;
        if (opts.summary) {
          // 单行化、去 markdown、转义 |、截断到 80
          entry.summary = sanitizeKanbanSummary(opts.summary);
        }
        entries.set(opts.taskId, entry);
      }
    }

    // Final safety: drop any lingering invalid ids before writing
    for (const id of Array.from(entries.keys())) {
      if (!isValidTaskId(id)) entries.delete(id);
    }
    for (const id of Array.from(completedEntries.keys())) {
      if (!isValidTaskId(id)) completedEntries.delete(id);
    }

    // 生成看板文件
    const locale = (session.language === 'en') ? 'en-US' : 'zh-CN';
    const now = new Date().toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
    let content = `${m.kanbanTitle}\n> ${m.lastUpdated}: ${now}\n`;

    const activeArr = Array.from(entries.values());
    content += `\n## 🔨 ${m.kanbanActive} (${activeArr.length})\n`;
    if (activeArr.length > 0) {
      content += `| ${m.colTaskId} | ${m.colTitle} | ${m.kanbanColAssignee} | ${m.kanbanColStatus} | ${m.kanbanColSummary} |\n|---------|------|--------|------|----------|\n`;
      for (const e of activeArr) {
        content += `| ${e.taskId} | ${e.taskTitle} | ${e.assignee} | ${e.status} | ${e.summary} |\n`;
      }
    }

    const doneArr = Array.from(completedEntries.values());
    content += `\n## ✅ ${m.kanbanCompleted} (${doneArr.length})\n`;
    if (doneArr.length > 0) {
      content += `| ${m.colTaskId} | ${m.colTitle} | ${m.kanbanColAssignee} |\n|---------|------|--------|\n`;
      for (const e of doneArr) {
        content += `| ${e.taskId} | ${e.taskTitle} | ${e.assignee} |\n`;
      }
    }

    await fs.writeFile(kanbanPath, content);
    console.log(`[Crew] Kanban updated: ${activeArr.length} active, ${doneArr.length} completed`);
  };

  // 串行化写入
  _kanbanWriteLock = _kanbanWriteLock.then(doUpdate, doUpdate);
  return _kanbanWriteLock;
}

/**
 * 读取看板文件内容
 */
export async function readKanban(session) {
  const kanbanPath = join(session.sharedDir, 'context', 'kanban.md');
  try {
    return await fs.readFile(kanbanPath, 'utf-8');
  } catch {
    return null;
  }
}
