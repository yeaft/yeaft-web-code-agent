/**
 * 帮帮团 (Expert Panel) — Frontend role metadata
 *
 * This file contains ONLY display metadata (id, name, title, icon, group, actions list).
 * Message templates live in agent/expert-roles.js (agent-side).
 */

export const EXPERT_TEAMS = {
  dev: { id: 'dev', name: '软件开发', nameEn: 'Software Dev', icon: '🖥️', order: 0 },
  trading: { id: 'trading', name: '交易', nameEn: 'Trading', icon: '📈', order: 1, adminOnly: true },
  writing: { id: 'writing', name: '写作', nameEn: 'Writing', icon: '✍️', order: 2, adminOnly: true },
  video: { id: 'video', name: '视频', nameEn: 'Video', icon: '🎬', order: 3, adminOnly: true }
};

export const EXPERT_ROLES = {
  // ============================================================
  // 🖥️ 软件开发团队 (12 roles)
  // ============================================================
  jobs: {
    id: 'jobs',
    name: 'Jobs',
    fullName: 'Steve Jobs',
    title: '产品经理',
    titleEn: 'Product Manager',
    group: 'dev',
    actions: [
      { id: 'product-analysis', name: '产品分析', nameEn: 'Product Analysis' },
      { id: 'design-review', name: '设计审查', nameEn: 'Design Review' },
      { id: 'requirements', name: '需求拆解', nameEn: 'Requirements' }
    ]
  },
  fowler: {
    id: 'fowler',
    name: 'Fowler',
    fullName: 'Martin Fowler',
    title: '软件架构师',
    titleEn: 'Software Architect',
    group: 'dev',
    actions: [
      { id: 'architecture', name: '架构审查', nameEn: 'Architecture Review' },
      { id: 'refactoring', name: '重构分析', nameEn: 'Refactoring' },
      { id: 'code-review', name: '代码审查', nameEn: 'Code Review' }
    ]
  },
  torvalds: {
    id: 'torvalds',
    name: 'Torvalds',
    fullName: 'Linus Torvalds',
    title: '系统开发工程师',
    titleEn: 'Systems Engineer',
    group: 'dev',
    actions: [
      { id: 'system-design', name: '系统设计', nameEn: 'System Design' },
      { id: 'performance', name: '性能优化', nameEn: 'Performance' },
      { id: 'code-style', name: '代码风格', nameEn: 'Code Style' },
      { id: 'implementation', name: '代码实现', nameEn: 'Implementation' }
    ]
  },
  beck: {
    id: 'beck',
    name: 'Beck',
    fullName: 'Kent Beck',
    title: '测试工程师',
    titleEn: 'Test Engineer',
    group: 'dev',
    actions: [
      { id: 'test-strategy', name: '测试策略', nameEn: 'Test Strategy' },
      { id: 'tdd-guide', name: 'TDD 指导', nameEn: 'TDD Guide' },
      { id: 'quality-check', name: '质量评估', nameEn: 'Quality Check' }
    ]
  },
  schneier: {
    id: 'schneier',
    name: 'Schneier',
    fullName: 'Bruce Schneier',
    title: '安全工程师',
    titleEn: 'Security Engineer',
    group: 'dev',
    actions: [
      { id: 'security-audit', name: '安全审计', nameEn: 'Security Audit' },
      { id: 'threat-model', name: '威胁建模', nameEn: 'Threat Model' },
      { id: 'auth-review', name: '认证审查', nameEn: 'Auth Review' }
    ]
  },
  rams: {
    id: 'rams',
    name: 'Rams',
    fullName: 'Dieter Rams',
    title: 'UI/UX 设计师',
    titleEn: 'UI/UX Designer',
    group: 'dev',
    actions: [
      { id: 'ui-review', name: '界面审查', nameEn: 'UI Review' },
      { id: 'interaction', name: '交互设计', nameEn: 'Interaction Design' },
      { id: 'layout', name: '布局优化', nameEn: 'Layout Optimization' }
    ]
  },
  graham: {
    id: 'graham',
    name: 'Graham',
    fullName: 'Paul Graham',
    title: '技术写作 / 方案评估师',
    titleEn: 'Tech Writer / Evaluator',
    group: 'dev',
    actions: [
      { id: 'writing', name: '技术写作', nameEn: 'Tech Writing' },
      { id: 'proposal-review', name: '方案评估', nameEn: 'Proposal Review' },
      { id: 'explain', name: '概念解释', nameEn: 'Explain' }
    ]
  },
  hightower: {
    id: 'hightower',
    name: 'Hightower',
    fullName: 'Kelsey Hightower',
    title: 'DevOps / 运维工程师',
    titleEn: 'DevOps Engineer',
    group: 'dev',
    actions: [
      { id: 'deployment', name: '部署审查', nameEn: 'Deployment Review' },
      { id: 'cicd', name: 'CI/CD 评估', nameEn: 'CI/CD Review' },
      { id: 'infra', name: '基础设施', nameEn: 'Infrastructure' }
    ]
  },
  gregg: {
    id: 'gregg',
    name: 'Gregg',
    fullName: 'Brendan Gregg',
    title: '性能工程师',
    titleEn: 'Performance Engineer',
    group: 'dev',
    actions: [
      { id: 'perf-analysis', name: '性能分析', nameEn: 'Perf Analysis' },
      { id: 'tuning', name: '系统调优', nameEn: 'Tuning' },
      { id: 'benchmark', name: '基准测试', nameEn: 'Benchmark' }
    ]
  },
  codd: {
    id: 'codd',
    name: 'Codd',
    fullName: 'Edgar Codd',
    title: '数据库 / SQL 专家',
    titleEn: 'Database / SQL Expert',
    group: 'dev',
    actions: [
      { id: 'sql-optimization', name: 'SQL 优化', nameEn: 'SQL Optimization' },
      { id: 'schema-design', name: 'Schema 设计', nameEn: 'Schema Design' },
      { id: 'data-modeling', name: '数据建模', nameEn: 'Data Modeling' }
    ]
  },
  knuth: {
    id: 'knuth',
    name: 'Knuth',
    fullName: 'Donald Knuth',
    title: '算法 / 数据处理专家',
    titleEn: 'Algorithm Expert',
    group: 'dev',
    actions: [
      { id: 'algorithm-design', name: '算法设计', nameEn: 'Algorithm Design' },
      { id: 'data-processing', name: '数据处理', nameEn: 'Data Processing' },
      { id: 'optimization', name: '优化', nameEn: 'Optimization' }
    ]
  },
  thomas: {
    id: 'thomas',
    name: 'Thomas',
    fullName: 'Dave Thomas',
    title: '技术文档工程师',
    titleEn: 'Tech Doc Engineer',
    group: 'dev',
    actions: [
      { id: 'api-docs', name: 'API 文档', nameEn: 'API Docs' },
      { id: 'readme', name: 'README', nameEn: 'README' },
      { id: 'comment-review', name: '注释审查', nameEn: 'Comment Review' }
    ]
  },

  // ============================================================
  // 📈 交易团队 (6 roles)
  // ============================================================
  soros: {
    id: 'soros',
    name: 'Soros',
    fullName: 'George Soros',
    title: '宏观策略师',
    titleEn: 'Macro Strategist',
    group: 'trading',
    actions: [
      { id: 'macro-analysis', name: '宏观分析', nameEn: 'Macro Analysis' },
      { id: 'risk-assessment', name: '风险评估', nameEn: 'Risk Assessment' },
      { id: 'thesis-review', name: '论点审查', nameEn: 'Thesis Review' }
    ]
  },
  livermore: {
    id: 'livermore',
    name: 'Livermore',
    fullName: 'Jesse Livermore',
    title: '技术分析师',
    titleEn: 'Technical Analyst',
    group: 'trading',
    actions: [
      { id: 'price-action', name: '价格行为', nameEn: 'Price Action' },
      { id: 'pattern-recognition', name: '图形识别', nameEn: 'Pattern Recognition' },
      { id: 'trade-plan', name: '交易计划', nameEn: 'Trade Plan' }
    ]
  },
  dalio: {
    id: 'dalio',
    name: 'Dalio',
    fullName: 'Ray Dalio',
    title: '研究员 / 经济分析师',
    titleEn: 'Research / Economist',
    group: 'trading',
    actions: [
      { id: 'economic-analysis', name: '经济分析', nameEn: 'Economic Analysis' },
      { id: 'portfolio-review', name: '组合审查', nameEn: 'Portfolio Review' },
      { id: 'research-report', name: '研究报告', nameEn: 'Research Report' }
    ]
  },
  taleb: {
    id: 'taleb',
    name: 'Taleb',
    fullName: 'Nassim Taleb',
    title: '风控官',
    titleEn: 'Risk Manager',
    group: 'trading',
    actions: [
      { id: 'risk-audit', name: '风险审计', nameEn: 'Risk Audit' },
      { id: 'antifragile', name: '反脆弱评估', nameEn: 'Antifragile Assessment' },
      { id: 'stress-test', name: '压力测试', nameEn: 'Stress Test' }
    ]
  },
  jones: {
    id: 'jones',
    name: 'Jones',
    fullName: 'Paul Tudor Jones',
    title: '交易执行员',
    titleEn: 'Trade Executor',
    group: 'trading',
    actions: [
      { id: 'execution', name: '执行计划', nameEn: 'Execution Plan' },
      { id: 'position-sizing', name: '仓位计算', nameEn: 'Position Sizing' },
      { id: 'trade-review', name: '交易复盘', nameEn: 'Trade Review' }
    ]
  },
  simons: {
    id: 'simons',
    name: 'Simons',
    fullName: 'Jim Simons',
    title: '量化分析师',
    titleEn: 'Quant Analyst',
    group: 'trading',
    actions: [
      { id: 'quant-signal', name: '量化信号', nameEn: 'Quant Signal' },
      { id: 'backtest-review', name: '回测审查', nameEn: 'Backtest Review' },
      { id: 'model-design', name: '模型设计', nameEn: 'Model Design' }
    ]
  },

  // ============================================================
  // ✍️ 写作团队 (4 roles)
  // ============================================================
  jinyong: {
    id: 'jinyong',
    name: '金庸',
    fullName: '金庸（Louis Cha）',
    title: '武侠大师',
    titleEn: 'Wuxia Master',
    group: 'writing',
    actions: [
      { id: 'world-building', name: '武侠世界观', nameEn: 'Wuxia World Building' },
      { id: 'character-design', name: '人物塑造', nameEn: 'Character Design' },
      { id: 'plot-design', name: '情节编排', nameEn: 'Plot Design' }
    ]
  },
  zhouzi: {
    id: 'zhouzi',
    name: '肘子',
    fullName: '会说话的肘子',
    title: '网文天王',
    titleEn: 'Web Novel King',
    group: 'writing',
    actions: [
      { id: 'cool-factor', name: '爽感设计', nameEn: 'Cool Factor Design' },
      { id: 'pacing', name: '节奏把控', nameEn: 'Pacing Control' },
      { id: 'cheat-design', name: '金手指设计', nameEn: 'Cheat System Design' }
    ]
  },
  qiongyao: {
    id: 'qiongyao',
    name: '琼瑶',
    fullName: '琼瑶（Chiung Yao）',
    title: '言情宗师',
    titleEn: 'Romance Master',
    group: 'writing',
    actions: [
      { id: 'emotion-writing', name: '情感描写', nameEn: 'Emotion Writing' },
      { id: 'dialogue-design', name: '对话设计', nameEn: 'Dialogue Design' },
      { id: 'romance-arc', name: '虐恋架构', nameEn: 'Romance Arc' }
    ]
  },
  luxun: {
    id: 'luxun',
    name: '鲁迅',
    fullName: '鲁迅（Lu Xun）',
    title: '文学巨匠',
    titleEn: 'Literary Giant',
    group: 'writing',
    actions: [
      { id: 'satire', name: '讽刺写作', nameEn: 'Satirical Writing' },
      { id: 'character-sketch', name: '人物刻画', nameEn: 'Character Sketch' },
      { id: 'prose-craft', name: '文笔锤炼', nameEn: 'Prose Craft' }
    ]
  },

  // ============================================================
  // 🎬 视频团队 (4 roles)
  // ============================================================
  kubrick: {
    id: 'kubrick',
    name: 'Kubrick',
    fullName: 'Stanley Kubrick',
    title: '导演 / 视觉总监',
    titleEn: 'Director / Visual Director',
    group: 'video',
    actions: [
      { id: 'narrative-pacing', name: '叙事节奏', nameEn: 'Narrative Pacing' },
      { id: 'visual-concept', name: '视觉概念', nameEn: 'Visual Concept' },
      { id: 'scene-breakdown', name: '场景拆解', nameEn: 'Scene Breakdown' }
    ]
  },
  kaufman: {
    id: 'kaufman',
    name: 'Kaufman',
    fullName: 'Charlie Kaufman',
    title: '编剧',
    titleEn: 'Screenwriter',
    group: 'video',
    actions: [
      { id: 'script-writing', name: '脚本写作', nameEn: 'Script Writing' },
      { id: 'character-design', name: '角色设计', nameEn: 'Character Design' },
      { id: 'narrative-structure', name: '叙事结构', nameEn: 'Narrative Structure' }
    ]
  },
  spielberg: {
    id: 'spielberg',
    name: 'Spielberg',
    fullName: 'Steven Spielberg',
    title: '分镜 / 视觉叙事师',
    titleEn: 'Storyboard / Visual Storyteller',
    group: 'video',
    actions: [
      { id: 'storyboard', name: '分镜设计', nameEn: 'Storyboard' },
      { id: 'shot-design', name: '镜头方案', nameEn: 'Shot Design' },
      { id: 'visual-storytelling', name: '视觉叙事', nameEn: 'Visual Storytelling' }
    ]
  },
  schoonmaker: {
    id: 'schoonmaker',
    name: 'Schoonmaker',
    fullName: 'Thelma Schoonmaker',
    title: '剪辑师',
    titleEn: 'Editor',
    group: 'video',
    actions: [
      { id: 'editing-rhythm', name: '剪辑节奏', nameEn: 'Editing Rhythm' },
      { id: 'sequence-design', name: '序列设计', nameEn: 'Sequence Design' },
      { id: 'final-cut', name: '最终审片', nameEn: 'Final Cut' }
    ]
  }
};

/**
 * Get all roles grouped by team
 * @returns {{ teamId: string, team: object, roles: object[] }[]}
 */
export function getRolesByTeam() {
  const teamOrder = Object.values(EXPERT_TEAMS).sort((a, b) => a.order - b.order);
  return teamOrder.map(team => ({
    teamId: team.id,
    team,
    roles: Object.values(EXPERT_ROLES).filter(r => r.group === team.id)
  }));
}

/**
 * Build autocomplete items for @ mention search.
 * Returns flat list of { roleId, roleName, actionId?, actionName?, searchText, displayText }
 * @param {Array} [customRoles] - optional custom roles to include
 */
export function buildAutocompleteItems(customRoles) {
  const items = [];
  for (const role of Object.values(EXPERT_ROLES)) {
    // Pure role entry (no action)
    items.push({
      roleId: role.id,
      roleName: role.name,
      roleTitle: role.title,
      actionId: null,
      actionName: null,
      searchText: `${role.name} ${role.fullName} ${role.title} ${role.titleEn}`.toLowerCase(),
      displayText: role.name,
      group: role.group
    });
    // Role + Action entries
    for (const action of role.actions) {
      items.push({
        roleId: role.id,
        roleName: role.name,
        roleTitle: role.title,
        actionId: action.id,
        actionName: action.name,
        searchText: `${role.name} ${role.fullName} ${role.title} ${action.name} ${action.nameEn}`.toLowerCase(),
        displayText: `${role.name}\u00B7${action.name}`,
        group: role.group
      });
    }
  }
  // Include custom roles if provided
  if (customRoles && customRoles.length > 0) {
    for (const role of customRoles) {
      items.push({
        roleId: role.id,
        roleName: role.name,
        roleTitle: role.title,
        actionId: null,
        actionName: null,
        searchText: `${role.name} ${role.fullName || ''} ${role.title} ${role.titleEn || ''}`.toLowerCase(),
        displayText: role.name,
        group: 'custom'
      });
      if (role.actions) {
        for (const action of role.actions) {
          items.push({
            roleId: role.id,
            roleName: role.name,
            roleTitle: role.title,
            actionId: action.id,
            actionName: action.name,
            searchText: `${role.name} ${role.fullName || ''} ${role.title} ${action.name} ${action.nameEn || ''}`.toLowerCase(),
            displayText: `${role.name}\u00B7${action.name}`,
            group: 'custom'
          });
        }
      }
    }
  }
  return items;
}

/**
 * Get display label for a selection { role, action }
 * @param {object} selection - { role: string, action?: string }
 * @param {Array} [customRoles] - optional array of custom roles to look up
 */
export function getSelectionLabel(selection, customRoles) {
  // Try built-in first
  const role = EXPERT_ROLES[selection.role];
  if (role) {
    if (selection.action) {
      const action = role.actions.find(a => a.id === selection.action);
      return action ? `${role.name}\u00B7${action.name}` : role.name;
    }
    return role.name;
  }
  // Try custom roles
  if (customRoles) {
    const custom = customRoles.find(r => r.id === selection.role);
    if (custom) {
      if (selection.action) {
        const action = custom.actions?.find(a => a.id === selection.action);
        return action ? `${custom.name}\u00B7${action.name}` : custom.name;
      }
      return custom.name;
    }
  }
  return selection.role;
}

/**
 * Default team to load when panel first opens
 */
export const DEFAULT_TEAM = 'dev';

/**
 * Maximum number of expert selections allowed
 */
export const MAX_SELECTIONS = 3;

/**
 * Build the effective prompt for a custom expert role on the client side.
 * For custom roles (not in EXPERT_ROLES), the frontend constructs the full prompt
 * so the agent doesn't need the custom role definitions.
 *
 * @param {Array<{role: string, action?: string}>} selections
 * @param {Array} customRoles - custom roles from server (with messagePrefix, actions, etc.)
 * @param {string} userText - user's typed message
 * @param {string} language - 'zh-CN' or 'en'
 * @returns {{ effectivePrompt: string } | null} - null if not a custom role (let agent handle it)
 */
export function buildClientExpertMessage(selections, customRoles, userText, language = 'zh-CN') {
  if (!selections || selections.length === 0 || !customRoles || customRoles.length === 0) {
    return null;
  }

  const isZh = language === 'zh-CN';

  // Check if any selection is a custom role
  const hasCustomRole = selections.some(s => {
    return !EXPERT_ROLES[s.role] && customRoles.some(cr => cr.id === s.role);
  });

  if (!hasCustomRole) return null;

  // Build prompt for custom roles (single selection only for now)
  if (selections.length === 1) {
    const { role, action } = selections[0];
    const customRole = customRoles.find(cr => cr.id === role);
    if (!customRole) return null;

    let effectivePrompt;

    if (action && customRole.actions) {
      const actionDef = customRole.actions.find(a => a.id === action);
      if (actionDef) {
        if (userText) {
          // Action + user text
          effectivePrompt = (isZh ? actionDef.messageTemplate : actionDef.messageTemplateEn) || '';
          effectivePrompt += userText;
        } else {
          // Action + no text
          effectivePrompt = (isZh ? actionDef.defaultMessage : actionDef.defaultMessageEn) || '';
        }
      } else {
        // Action not found, fall back to role prefix
        effectivePrompt = ((isZh ? customRole.messagePrefix : customRole.messagePrefixEn) || '') + (userText || '');
      }
    } else {
      // Pure role + user text
      effectivePrompt = ((isZh ? customRole.messagePrefix : customRole.messagePrefixEn) || '') + (userText || '');
    }

    return { effectivePrompt };
  }

  // Multi-selection with custom roles: build combined prompt
  const parts = [];
  for (const { role, action } of selections) {
    const customRole = customRoles.find(cr => cr.id === role);
    const builtinRole = EXPERT_ROLES[role];

    if (customRole) {
      if (action) {
        const actionDef = customRole.actions?.find(a => a.id === action);
        if (actionDef) {
          parts.push((isZh ? actionDef.messageTemplate : actionDef.messageTemplateEn) || '');
        }
      } else {
        parts.push((isZh ? customRole.messagePrefix : customRole.messagePrefixEn) || '');
      }
    } else if (builtinRole) {
      // Built-in roles are handled by the agent, skip
      return null;
    }
  }

  if (parts.length === 0) return null;

  const combined = parts.join('\n---\n\n');
  return { effectivePrompt: combined + (userText || '') };
}

/**
 * Get teams visible to the current user.
 * Non-admin users only see teams without adminOnly flag.
 * @param {boolean} isAdmin
 * @returns {object[]} sorted team list
 */
export function getVisibleTeams(isAdmin) {
  return Object.values(EXPERT_TEAMS)
    .filter(team => isAdmin || !team.adminOnly)
    .sort((a, b) => a.order - b.order);
}
