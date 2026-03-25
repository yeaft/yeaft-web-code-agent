/**
 * Conductor — Specialty 注册中心
 * 管理所有 specialty 定义，提供查询接口
 */
import { commonSpecialties } from './common.js';
import { writingSpecialties } from './writing.js';
import { tradingSpecialties } from './trading.js';
import { videoSpecialties } from './video.js';

/** 全部 specialty 合并（通用 + 各场景特有） */
const allSpecialties = {
  ...commonSpecialties,
  ...writingSpecialties,
  ...tradingSpecialties,
  ...videoSpecialties
};

/** 场景 → 可用 specialty ID 列表 */
const scenarioSpecialties = {
  dev: ['planning', 'discussion', 'coding', 'review', 'testing', 'design'],
  writing: ['planning', 'discussion', 'writing', 'pacing', 'editing'],
  trading: ['planning', 'discussion', 'macro-analysis', 'technical-analysis', 'risk-review', 'execution'],
  video: ['planning', 'discussion', 'scripting', 'storyboarding', 'prompt-assembly', 'continuity-check']
};

/** 发散型 specialty 集合 */
const divergentSpecialties = new Set(
  Object.values(allSpecialties)
    .filter(s => s.thinkingMode === 'divergent')
    .map(s => s.id)
);

/**
 * 获取单个 specialty 定义
 * @param {string} specialtyId
 * @returns {object|null}
 */
export function getSpecialty(specialtyId) {
  return allSpecialties[specialtyId] || null;
}

/**
 * 获取指定场景可用的全部 specialty
 * @param {string} scenario
 * @returns {object[]}
 */
export function getSpecialtiesByScenario(scenario) {
  const ids = scenarioSpecialties[scenario] || [];
  return ids.map(id => allSpecialties[id]).filter(Boolean);
}

/**
 * 判断 specialty 是发散型还是收敛型
 * @param {string} specialtyId
 * @returns {'divergent'|'convergent'}
 */
export function getThinkingMode(specialtyId) {
  return divergentSpecialties.has(specialtyId) ? 'divergent' : 'convergent';
}

/**
 * 判断是否为发散型 specialty
 * @param {string} specialtyId
 * @returns {boolean}
 */
export function isDivergent(specialtyId) {
  return divergentSpecialties.has(specialtyId);
}

/**
 * 获取 specialty 的个性化行为描述
 * @param {string} specialtyId
 * @param {object} persona
 * @returns {string}
 */
export function getPersonalizedBehavior(specialtyId, persona) {
  const specialty = allSpecialties[specialtyId];
  if (!specialty) return '';
  return specialty.getPersonalizedBehavior(persona);
}

/**
 * 获取 specialty 的输出格式说明
 * @param {string} specialtyId
 * @returns {string}
 */
export function getOutputFormat(specialtyId) {
  const specialty = allSpecialties[specialtyId];
  if (!specialty) return '';
  return specialty.getOutputFormat();
}

/**
 * 获取 specialty 的工具使用规则（格式化为 CLAUDE.md 文本）
 * @param {string} specialtyId
 * @returns {string}
 */
export function formatToolRules(specialtyId) {
  const specialty = allSpecialties[specialtyId];
  if (!specialty) return '';

  const { toolRules } = specialty;
  const lines = [];

  if (toolRules.readonly?.length > 0) {
    lines.push(`只读：${toolRules.readonly.join('、')}`);
  }
  if (toolRules.writable?.length > 0) {
    lines.push(`可写：${toolRules.writable.join('、')}`);
  }
  if (toolRules.forbidden?.length > 0) {
    lines.push(`禁止：${toolRules.forbidden.join('、')}`);
  }

  return lines.join('\n');
}

/**
 * 验证 persona 是否支持指定 specialty
 * @param {object} persona
 * @param {string} specialtyId
 * @returns {boolean}
 */
export function personaSupportsSpecialty(persona, specialtyId) {
  return persona.specialties.includes(specialtyId);
}

export {
  allSpecialties,
  scenarioSpecialties,
  commonSpecialties,
  writingSpecialties,
  tradingSpecialties,
  videoSpecialties
};
