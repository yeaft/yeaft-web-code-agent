/**
 * Crew — 共享目录和 CLAUDE.md 管理
 * initSharedDir, initRoleDir, writeSharedClaudeMd, writeRoleClaudeMd, updateSharedClaudeMd
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { getMessages, getAllMemoryTitles } from '../crew-i18n.js';

/** Format role label: "icon displayName" or just "displayName" if no icon */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

const MEMORY_BACKUP_FILE = '.memory-backup.json';

/**
 * Extract user-written content after a memory section title.
 * Searches for any known locale's title (e.g. "# 共享记忆" or "# Shared Memory"),
 * returns the trimmed content after the title line until EOF or next top-level heading.
 * Returns null if section not found or content is only the default placeholder.
 */
function extractMemorySection(fileContent, titles, defaults) {
  for (const title of titles) {
    const idx = fileContent.indexOf(title);
    if (idx === -1) continue;
    // Content starts after the title line
    const afterTitle = fileContent.slice(idx + title.length);
    // Find next top-level heading (# at start of line) — that's where memory ends
    const nextHeading = afterTitle.search(/\n#\s/);
    const raw = nextHeading === -1 ? afterTitle : afterTitle.slice(0, nextHeading);
    const trimmed = raw.trim();
    // Skip if empty or is just the default placeholder
    if (!trimmed) return null;
    for (const d of defaults) {
      if (trimmed === d.trim()) return null;
    }
    return trimmed;
  }
  return null;
}

/**
 * Backup memory content from .crew/CLAUDE.md and .crew/roles/<role>/CLAUDE.md
 * before deletion. Writes .crew/.memory-backup.json.
 */
export async function backupMemoryContent(crewDir) {
  const { sharedTitles, sharedDefaults, personalTitles, personalDefaults } = getAllMemoryTitles();
  const backup = { shared: null, roles: {} };

  // Extract shared memory from .crew/CLAUDE.md
  try {
    const sharedContent = await fs.readFile(join(crewDir, 'CLAUDE.md'), 'utf-8');
    backup.shared = extractMemorySection(sharedContent, sharedTitles, sharedDefaults);
  } catch { /* CLAUDE.md doesn't exist — skip */ }

  // Extract personal memory from each role's CLAUDE.md
  try {
    const rolesDir = join(crewDir, 'roles');
    const roleDirs = await fs.readdir(rolesDir);
    for (const roleName of roleDirs) {
      try {
        const roleClaudeMd = await fs.readFile(join(rolesDir, roleName, 'CLAUDE.md'), 'utf-8');
        const memory = extractMemorySection(roleClaudeMd, personalTitles, personalDefaults);
        if (memory) {
          backup.roles[roleName] = memory;
        }
      } catch { /* Role dir or file missing — skip */ }
    }
  } catch { /* roles/ doesn't exist — skip */ }

  // Only write backup if there's something to preserve
  if (backup.shared || Object.keys(backup.roles).length > 0) {
    await fs.writeFile(join(crewDir, MEMORY_BACKUP_FILE), JSON.stringify(backup, null, 2));
    console.log(`[Crew] Memory backup saved: shared=${!!backup.shared}, roles=${Object.keys(backup.roles).join(',') || 'none'}`);
  }
}

/**
 * Load memory backup from .crew/.memory-backup.json, returns null if not found.
 */
async function loadMemoryBackup(sharedDir) {
  try {
    const data = await fs.readFile(join(sharedDir, MEMORY_BACKUP_FILE), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Delete memory backup file after successful restore.
 */
async function cleanupMemoryBackup(sharedDir) {
  try {
    await fs.rm(join(sharedDir, MEMORY_BACKUP_FILE), { force: true });
  } catch { /* ignore */ }
}

/**
 * 初始化共享目录
 */
export async function initSharedDir(sharedDir, roles, projectDir, language = 'zh-CN') {
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(join(sharedDir, 'context'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'sessions'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'roles'), { recursive: true });

  // 初始化每个角色的目录
  for (const role of roles) {
    await initRoleDir(sharedDir, role, language, roles);
  }

  // 生成 .crew/CLAUDE.md（共享级）
  await writeSharedClaudeMd(sharedDir, roles, projectDir, language);

  // 清理记忆备份文件（已在 write 阶段恢复）
  await cleanupMemoryBackup(sharedDir);
}

/**
 * 初始化角色目录: .crew/roles/{roleName}/CLAUDE.md
 */
export async function initRoleDir(sharedDir, role, language = 'zh-CN', allRoles = []) {
  const roleDir = join(sharedDir, 'roles', role.name);
  await fs.mkdir(roleDir, { recursive: true });

  // 角色 CLAUDE.md（仅首次创建，后续角色自己维护记忆内容）
  const claudeMdPath = join(roleDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
    // 已存在，不覆盖（保留角色自己写入的记忆）
  } catch {
    await writeRoleClaudeMd(sharedDir, role, language, allRoles);
  }
}

/**
 * 写入 .crew/CLAUDE.md — 共享级（所有角色自动继承）
 */
export async function writeSharedClaudeMd(sharedDir, roles, projectDir, language = 'zh-CN') {
  const m = getMessages(language);

  // Check for memory backup to restore
  const backup = await loadMemoryBackup(sharedDir);
  const sharedMemoryContent = (backup && backup.shared) ? backup.shared : m.sharedMemoryDefault;

  const claudeMd = `${m.projectGoal}

${m.projectCodePath}
${projectDir}
${m.useAbsolutePath}

${m.teamMembersTitle}
${roles.length > 0 ? roles.map(r => `- ${roleLabel(r)}(${r.name}): ${r.description}${r.isDecisionMaker ? ` (${m.decisionMakerTag})` : ''}`).join('\n') : m.noMembers}

${m.workConventions}
${m.workConventionsContent}

${m.mergeRules}
${m.mergeRulesContent}

${m.taskSplitRules}
${m.taskSplitRulesContent}

${m.stuckRules}
${m.stuckRulesContent}

${m.worktreeRules}
${m.worktreeRulesContent}

${m.featureRecordShared}

${m.sharedMemoryTitle}
${sharedMemoryContent}
`;

  await fs.writeFile(join(sharedDir, 'CLAUDE.md'), claudeMd);
}

/**
 * Replace generic role names in ROUTE examples with actual instance names.
 *
 * Given a role with groupIndex=2 and the full role list containing
 * dev-1, dev-2, rev-1, rev-2, test-1, test-2, the function rewrites:
 *   "to: reviewer"  → "to: rev-2"
 *   "to: developer" → "to: dev-2"
 *   "to: tester"    → "to: test-2"
 *
 * For roles without a groupIndex (pm, designer, etc.), or when no matching
 * instance exists, the generic name is left untouched.
 *
 * @param {string} text - claudeMd content with generic ROUTE targets
 * @param {object} role - the role being written (must have roleType, groupIndex)
 * @param {Array}  allRoles - full expanded role list
 * @returns {string} text with generic names replaced by instance names
 */
export function resolveRouteTargets(text, role, allRoles) {
  if (!allRoles || allRoles.length === 0 || !role.groupIndex) return text;

  // Build a lookup: generic roleType → instance name at this groupIndex
  // e.g. { developer: 'dev-2', reviewer: 'rev-2', tester: 'test-2' }
  const instanceMap = {};
  for (const r of allRoles) {
    if (r.groupIndex === role.groupIndex && r.roleType && r.name !== r.roleType) {
      instanceMap[r.roleType] = r.name;
    }
  }

  if (Object.keys(instanceMap).length === 0) return text;

  // Replace "to: <genericName>" inside ROUTE blocks
  // Use a careful regex that only touches the `to:` field value
  return text.replace(/(to:\s*)(developer|reviewer|tester)\b/gi, (match, prefix, genericName) => {
    const resolved = instanceMap[genericName.toLowerCase()];
    return resolved ? `${prefix}${resolved}` : match;
  });
}

/**
 * 写入 .crew/roles/{roleName}/CLAUDE.md — 角色级
 * @param {string} sharedDir
 * @param {object} role
 * @param {string} language
 * @param {Array}  [allRoles] - full expanded role list for ROUTE target resolution
 */
export async function writeRoleClaudeMd(sharedDir, role, language = 'zh-CN', allRoles = []) {
  const roleDir = join(sharedDir, 'roles', role.name);
  const m = getMessages(language);

  // Check for memory backup to restore
  const backup = await loadMemoryBackup(sharedDir);
  const personalMemoryContent = (backup && backup.roles && backup.roles[role.name])
    ? backup.roles[role.name]
    : m.personalMemoryDefault;

  // Resolve generic ROUTE targets to actual instance names
  const resolvedClaudeMd = resolveRouteTargets(role.claudeMd || role.description, role, allRoles);

  let claudeMd = `${m.roleTitle(roleLabel(role))}
${resolvedClaudeMd}
`;

  // 有独立 worktree 的角色，覆盖代码工作目录
  if (role.workDir) {
    claudeMd += `
${m.codeWorkDir}
${role.workDir}
${m.codeWorkDirNote}
`;
  }

  claudeMd += `
${m.personalMemory}
${personalMemoryContent}
`;

  await fs.writeFile(join(roleDir, 'CLAUDE.md'), claudeMd);
}

/**
 * 角色变动时更新 .crew/CLAUDE.md
 */
export async function updateSharedClaudeMd(session) {
  const roles = Array.from(session.roles.values());
  await writeSharedClaudeMd(session.sharedDir, roles, session.projectDir, session.language || 'zh-CN');
}
