/**
 * Conductor — Persona 注册中心
 * 按场景管理所有 persona，提供查询接口
 */
import { devPersonas } from './dev.js';
import { writingPersonas } from './writing.js';
import { tradingPersonas } from './trading.js';
import { videoPersonas } from './video.js';

/** 所有 persona 按场景分组 */
const personasByScenario = {
  dev: devPersonas,
  writing: writingPersonas,
  trading: tradingPersonas,
  video: videoPersonas
};

/** 全部 persona 扁平列表 */
const allPersonas = [
  ...devPersonas,
  ...writingPersonas,
  ...tradingPersonas,
  ...videoPersonas
];

/** id → persona 索引 */
const personaById = new Map(allPersonas.map(p => [p.id, p]));

/**
 * 获取指定场景的人物池
 * @param {string} scenario - 场景名称 (dev/writing/trading/video)
 * @returns {Array} persona 列表
 */
export function getPersonasByScenario(scenario) {
  return personasByScenario[scenario] || [];
}

/**
 * 通过 ID 获取单个 persona
 * @param {string} id - persona ID
 * @returns {object|null}
 */
export function getPersonaById(id) {
  return personaById.get(id) || null;
}

/**
 * 获取所有支持的场景名称
 * @returns {string[]}
 */
export function getScenarios() {
  return Object.keys(personasByScenario);
}

/**
 * 获取全部 persona（跨场景）
 * @returns {Array}
 */
export function getAllPersonas() {
  return [...allPersonas];
}

/**
 * 获取指定场景的人物池，格式化为 Orchestrator 可读的 JSON 对象
 * @param {string} scenario
 * @returns {Array<{id, name, specialties, tags}>}
 */
export function getPersonaPoolForOrchestrator(scenario) {
  return getPersonasByScenario(scenario).map(p => ({
    id: p.id,
    name: p.name,
    specialties: p.specialties,
    tags: p.tags
  }));
}

export { personasByScenario };
