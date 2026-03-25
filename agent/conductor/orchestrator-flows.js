/**
 * Conductor Orchestrator — 场景特化流程定义
 *
 * 4 大场景 (Dev / Writing / Trading / Video) 各自定义：
 * - TRIAGE 判定逻辑
 * - 每个 Phase 的 Actor 编排策略
 * - Quality Gate 规则
 * - Acceptance 验收方式
 *
 * 这些流程被 Orchestrator 状态机消费，驱动具体的 Actor 调度。
 */

import { Phase, ThinkingMode } from './task.js';

// =====================================================================
// Specialty 思维模式映射
// =====================================================================

const DIVERGENT_SPECIALTIES = new Set([
  'planning', 'discussion', 'pacing', 'scripting', 'macro-analysis'
]);

/**
 * 根据 specialty 返回思维模式
 */
export function getThinkingMode(specialty) {
  return DIVERGENT_SPECIALTIES.has(specialty)
    ? ThinkingMode.DIVERGENT
    : ThinkingMode.CONVERGENT;
}

// =====================================================================
// Dev 场景流程
// =====================================================================

const devFlow = {
  scenario: 'dev',

  /**
   * TRIAGE: 判定任务复杂度
   * 返回 'trivial' | 'small' | 'complex'
   */
  triageRules: {
    trivial: [
      '任务描述少于 2 句话',
      '明确指向单个文件/单个函数的修改',
      '不涉及架构变化，不涉及多文件联动'
    ],
    small: [
      '任务目标清晰，不需要讨论方向',
      '可能涉及多个文件，但变更模式明确',
      '不需要先出设计方案'
    ],
    complex: [
      '任务描述模糊或有多种理解方式',
      '涉及架构决策、技术选型、用户体验取舍',
      '需要多角色的视角碰撞才能确定方向',
      '涉及 UI/前端时通常需要先 design'
    ]
  },

  /**
   * DISCUSSION 编排：创建哪些 actor，如何协作
   */
  discussion: {
    defaultActors: [
      { personaId: 'rams', specialty: 'design', condition: 'ui_involved' },
      { personaId: 'jobs', specialty: 'discussion' },
      { personaId: 'torvalds', specialty: 'discussion' }
    ],
    outputTarget: 'memory'  // 讨论结果写入 memory.md
  },

  /**
   * PLANNING 编排
   */
  planning: {
    actors: [
      { personaId: 'jobs', specialty: 'planning', role: 'product' },
      { personaId: 'torvalds', specialty: 'planning', role: 'lead' }
    ],
    lead: 'torvalds',       // Lead 负责合并最终 plan
    minPlanners: 2,
    outputTarget: 'plan'    // 产出写入 plan.json
  },

  /**
   * EXECUTION 编排：按 plan step 创建 coding actor
   */
  execution: {
    primaryCoder: 'torvalds',
    secondaryCoder: 'beck',
    supportsParallel: true   // 可并行步骤同时创建多个 actor
  },

  /**
   * QUALITY GATE 编排
   */
  qualityGate: {
    reviewer: { personaId: 'martin', specialty: 'review' },
    tester: { personaId: 'beck', specialty: 'testing' },
    parallel: true,          // review 和 testing 可并行
    passThreshold: 9,        // 10分制, ≥9 通过
    maxRetries: 2,           // 同一步骤 fail ≥ 此值 → 升级 discussion
    codingRequiresReview: true,
    codingRequiresTesting: true,
    designRequiresReview: false,
    docRequiresReview: false
  },

  /**
   * ACCEPTANCE 编排
   */
  acceptance: {
    verifier: { personaId: 'jobs', specialty: 'planning' },
    focusAreas: ['用户体验达标', 'successCriteria 逐条检查']
  }
};

// =====================================================================
// Writing 场景流程
// =====================================================================

const writingFlow = {
  scenario: 'writing',

  triageRules: {
    trivial: [
      '修改单章内容',
      '调整已有文本的措辞/表达'
    ],
    small: [
      '续写已有章节（基于已有大纲）',
      '为已有卷添加章节'
    ],
    complex: [
      '新卷/新书（需要完整的大纲设计）',
      '涉及人物弧线调整或世界观修改'
    ]
  },

  discussion: {
    defaultActors: [
      { personaId: 'maoni', specialty: 'discussion' },
      { personaId: 'zhouzi', specialty: 'discussion' },
      { personaId: 'jinyong', specialty: 'discussion' }
    ],
    focusAreas: {
      maoni: '故事结构、伏笔布局、人物弧线',
      zhouzi: '节奏体感、笑点密度、读者情绪过山车',
      jinyong: '人物厚度、武侠精神内核、大格局叙事'
    },
    outputTarget: 'memory'
  },

  planning: {
    actors: [
      { personaId: 'maoni', specialty: 'planning', role: 'lead' },
      { personaId: 'zhouzi', specialty: 'planning', role: 'execution-review' },
      { personaId: 'zhouzi', specialty: 'pacing', role: 'pacing' }
    ],
    lead: 'maoni',
    minPlanners: 2,
    outputTarget: 'plan'
  },

  execution: {
    primaryWriter: 'zhouzi',
    supportsParallel: false   // 章节串行写作
  },

  qualityGate: {
    reviewer: { personaId: 'maboyong', specialty: 'editing' },
    tester: null,             // Writing 无 tester
    parallel: false,
    checkAreas: ['设定一致性', '时间线', '人物逻辑', '爽点落地', '文字质量'],
    maxRetries: 2
  },

  acceptance: {
    verifier: { personaId: 'maoni', specialty: 'planning' },
    focusAreas: ['伏笔按计划埋设/回收', '人物弧线推进', '卷级目标达成']
  }
};

// =====================================================================
// Trading 场景流程
// =====================================================================

const tradingFlow = {
  scenario: 'trading',

  triageRules: {
    trivial: [
      '紧急交易指令（明确的品种/方向/仓位）',
      '已有策略的简单执行'
    ],
    small: [
      '已有策略调整（参数微调、止损调整）',
      '单一品种分析'
    ],
    complex: [
      '新策略制定',
      '跨资产组合分析',
      '市场拐点判断'
    ]
  },

  /**
   * Trading 特有：发散分析阶段（替代标准 discussion）
   * 宏观分析和技术分析并行，然后进入 planning
   */
  discussion: {
    defaultActors: [
      { personaId: 'dalio', specialty: 'macro-analysis' },
      { personaId: 'livermore', specialty: 'technical-analysis' }
    ],
    parallel: true,
    outputTarget: 'memory'
  },

  planning: {
    actors: [
      { personaId: 'soros', specialty: 'planning', role: 'lead' }
    ],
    lead: 'soros',
    minPlanners: 1,
    outputTarget: 'plan'
  },

  /**
   * Trading 特有：对抗性讨论
   * planning 之后、execution 之前，索罗斯 vs 塔勒布 压力测试
   */
  adversarialReview: {
    actors: [
      { personaId: 'soros', specialty: 'discussion' },
      { personaId: 'taleb', specialty: 'discussion' }
    ],
    purpose: '策略反脆弱压力测试',
    challengePoints: [
      '假设完全相反会怎样？',
      '信念越强越需要警惕确认偏误',
      '加仓条件是否是在沉船上往里跳？'
    ],
    outputTarget: 'memory'
  },

  qualityGate: {
    reviewer: { personaId: 'taleb', specialty: 'risk-review' },
    tester: null,
    parallel: false,
    riskThresholds: {
      maxPositionSize: 0.02,      // 单仓 ≤ 2%
      maxTotalExposure: 0.10,     // 总敞口 ≤ 10%
      minConvexity: 3,            // 凸性 ≥ 3:1
      requireTailHedge: true
    },
    maxRetries: 2
  },

  execution: {
    executor: 'jones',
    executorSpecialty: 'execution',
    supportsParallel: false
  },

  acceptance: {
    verifier: { personaId: 'soros', specialty: 'planning' },
    focusAreas: ['假设是否仍成立', '信念强度变化', '风险回报比']
  }
};

// =====================================================================
// Video 场景流程
// =====================================================================

const videoFlow = {
  scenario: 'video',

  triageRules: {
    trivial: [
      '调整单段 prompt 的参数或措辞',
      '修改单个分镜细节'
    ],
    small: [
      '修改已有脚本/分镜',
      '局部调整一致性锚点'
    ],
    complex: [
      '新视频项目（需要完整流程）',
      '涉及风格方向变更'
    ]
  },

  /**
   * Video 使用 planning 阶段确定整体方案，不走标准 discussion
   */
  discussion: {
    defaultActors: [
      { personaId: 'jia', specialty: 'discussion' },
      { personaId: 'shi', specialty: 'discussion' }
    ],
    outputTarget: 'memory'
  },

  planning: {
    actors: [
      { personaId: 'jia', specialty: 'planning', role: 'lead' }
    ],
    lead: 'jia',
    minPlanners: 1,
    outputTarget: 'plan'
  },

  /**
   * Video EXECUTION: 严格串行的三阶段
   *
   * Stage A: scripting (史铁生) → jia review
   * Stage B: storyboarding (徐克) → jia review
   * Stage C: prompt-assembly (顾长卫)
   */
  execution: {
    strictSerial: true,
    stages: [
      {
        name: 'scripting',
        actor: { personaId: 'shi', specialty: 'scripting' },
        reviewAfter: { personaId: 'jia', specialty: 'review' },
        description: '基于方案写分段脚本'
      },
      {
        name: 'storyboarding',
        actor: { personaId: 'tsui', specialty: 'storyboarding' },
        reviewAfter: { personaId: 'jia', specialty: 'review' },
        description: '基于脚本设计分镜'
      },
      {
        name: 'prompt-assembly',
        actor: { personaId: 'gu', specialty: 'prompt-assembly' },
        reviewAfter: null,
        description: '组装最终 AI 视频 prompt'
      }
    ],
    supportsParallel: false
  },

  qualityGate: {
    reviewer: { personaId: 'gu', specialty: 'continuity-check' },
    tester: null,
    parallel: false,
    checkAreas: ['锚点完整性', '色调统一', '角色描述一致', '时长合理'],
    maxRetries: 2
  },

  acceptance: {
    verifier: { personaId: 'jia', specialty: 'planning' },
    focusAreas: ['叙事弧线完整', '情绪曲线合理', '视觉一致性', '整体感觉']
  }
};

// =====================================================================
// Flow Registry
// =====================================================================

const FLOWS = new Map([
  ['dev', devFlow],
  ['writing', writingFlow],
  ['trading', tradingFlow],
  ['video', videoFlow]
]);

/**
 * 获取场景流程定义
 * @param {string} scenario — 'dev' | 'writing' | 'trading' | 'video'
 * @returns {ScenarioFlow}
 */
export function getFlow(scenario) {
  const flow = FLOWS.get(scenario);
  if (!flow) {
    throw new Error(`Unknown scenario: ${scenario}. Available: ${[...FLOWS.keys()].join(', ')}`);
  }
  return flow;
}

/**
 * 获取所有已注册场景
 */
export function getAvailableScenarios() {
  return [...FLOWS.keys()];
}

// =====================================================================
// Flow Query Helpers
// =====================================================================

/**
 * 获取 discussion 阶段应创建的 actor 列表
 * @param {ScenarioFlow} flow
 * @param {object} context — { uiInvolved: boolean }
 * @returns {Array<{personaId, specialty}>}
 */
export function getDiscussionActors(flow, context = {}) {
  const actors = flow.discussion.defaultActors || [];
  return actors.filter(a => {
    if (a.condition === 'ui_involved') return context.uiInvolved;
    return true;
  });
}

/**
 * 获取 planning 阶段应创建的 actor 列表
 */
export function getPlanningActors(flow) {
  return flow.planning.actors || [];
}

/**
 * 获取 planning lead persona ID
 */
export function getPlanningLead(flow) {
  return flow.planning.lead;
}

/**
 * 获取 quality gate 配置
 */
export function getQualityGateConfig(flow) {
  return flow.qualityGate;
}

/**
 * 获取 acceptance verifier
 */
export function getAcceptanceVerifier(flow) {
  return flow.acceptance.verifier;
}

/**
 * 判断某个步骤是否需要经过 quality gate
 *
 * @param {ScenarioFlow} flow
 * @param {string} specialty — 该步骤 actor 的 specialty
 * @returns {boolean}
 */
export function needsQualityGate(flow, specialty) {
  const qg = flow.qualityGate;
  if (specialty === 'coding') {
    return qg.codingRequiresReview !== false || qg.codingRequiresTesting !== false;
  }
  if (specialty === 'writing') {
    return !!qg.reviewer;
  }
  if (specialty === 'design') {
    return qg.designRequiresReview === true;
  }
  // 其他 specialty（execution, prompt-assembly 等）
  return false;
}

/**
 * Trading 特有：获取对抗性审查配置
 */
export function getAdversarialReviewConfig(flow) {
  return flow.adversarialReview || null;
}

/**
 * Video 特有：获取严格串行 stages
 */
export function getExecutionStages(flow) {
  if (flow.execution?.strictSerial) {
    return flow.execution.stages || [];
  }
  return null;
}
