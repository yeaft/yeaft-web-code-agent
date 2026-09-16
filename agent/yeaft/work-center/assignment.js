import { parseModelRef } from '../models.js';
import { normalizeAssignmentPolicy, normalizeModelPolicy } from './workflow.js';

function policyError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

function diagnosticValue(value) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128) || 'none';
}

function assignmentError(message, {
  policy, stageType, candidates = [], excluded = [], fallback = 'not-attempted',
}) {
  const context = [
    `mode=${diagnosticValue(policy.mode)}`,
    `capability=${diagnosticValue(policy.capability || stageType)}`,
    `fallback=${diagnosticValue(fallback)}`,
    `candidates=${candidates.length
      ? candidates.map(vp => diagnosticValue(vp?.id || vp)).sort().join(',')
      : 'none'}`,
    `excluded=${excluded.size ? [...excluded].map(diagnosticValue).sort().join(',') : 'none'}`,
  ].join('; ');
  return policyError(`${message} (${context})`);
}

const CAPABILITY_TERMS = Object.freeze({
  triage: ['triage', 'requirement', 'flow', 'product', 'strategy', 'cross-domain', 'analysis'],
  implement: ['implement', 'engineer', 'developer', 'engineering', 'systems', 'code', 'execution'],
  test: ['test', 'testing', 'quality', 'qa', 'verification', 'reliability'],
  review: ['review', 'reviewer', 'refactor', 'architecture', 'code-smells', 'readability', 'maintainability'],
  deliver: ['deliver', 'release', 'ship', 'git', 'engineering', 'systems', 'execution'],
  research: ['research', 'science', 'analysis', 'evidence', 'investigation'],
  design: ['design', 'architecture', 'architect', 'systems', 'product', 'ux'],
  diagnose: ['diagnose', 'debug', 'root-cause', 'reliability', 'investigation', 'systems'],
  migrate: ['migrate', 'migration', 'database', 'compatibility', 'data', 'systems'],
  document: ['document', 'documentation', 'writer', 'writing', 'communication'],
  operate: ['operate', 'operations', 'release', 'deployment', 'reliability', 'systems'],
  write: ['write', 'writer', 'writing', 'documentation', 'editor', 'communication'],
});

function vpSearchText(vp) {
  return [
    vp.id,
    vp.name,
    vp.nameZh,
    vp.role,
    vp.roleZh,
    vp.area,
    ...(Array.isArray(vp.aliases) ? vp.aliases : []),
    ...(Array.isArray(vp.traits) ? vp.traits : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function capabilityScore(vp, capability) {
  const needle = String(capability || '').trim().toLowerCase();
  if (!needle) return 0;
  const text = vpSearchText(vp);
  const terms = Object.hasOwn(CAPABILITY_TERMS, needle) ? CAPABILITY_TERMS[needle] : [needle];
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += term === needle ? 6 : 2;
  }
  if (String(vp.area || '').toLowerCase() === needle) score += 4;
  return score;
}

function priorVpIdsForSeparation(policy, priorRuns) {
  const separatedTypes = new Set(policy.separateFromStageTypes || []);
  if (separatedTypes.size === 0) return new Set();
  return new Set((priorRuns || [])
    .filter(run => separatedTypes.has(run.actionType) || separatedTypes.has(run.roleSnapshot?.actionType))
    .map(run => run.vpSnapshot?.id)
    .filter(Boolean));
}

export function selectWorkItemVp({ policy: rawPolicy, stageType, vps, priorRuns = [] }) {
  const policy = normalizeAssignmentPolicy(rawPolicy, stageType);
  const all = Array.isArray(vps) ? vps.filter(vp => vp?.id) : [];
  const excluded = priorVpIdsForSeparation(policy, priorRuns);
  if (all.length === 0) {
    throw assignmentError('Work Center has no available VPs', {
      policy, stageType, candidates: [], excluded,
    });
  }
  const byId = new Map(all.map(vp => [vp.id, vp]));

  if (policy.mode === 'fixed') {
    const fixed = byId.get(policy.fixedVpId);
    if (!fixed) {
      throw assignmentError(`Fixed Work Center VP is unavailable: ${diagnosticValue(policy.fixedVpId)}`, {
        policy, stageType, candidates: [policy.fixedVpId], excluded,
      });
    }
    if (excluded.has(fixed.id)) {
      throw assignmentError(`Work Center separation policy excludes VP: ${diagnosticValue(fixed.id)}`, {
        policy, stageType, candidates: [fixed], excluded,
      });
    }
    return { vp: fixed, reason: `fixed:${fixed.id}`, policy };
  }

  const configuredCandidates = ['pool', 'planned'].includes(policy.mode)
    ? policy.candidateVpIds
    : all;
  const pool = ['pool', 'planned'].includes(policy.mode)
    ? policy.candidateVpIds.map(id => byId.get(id)).filter(Boolean)
    : all;
  if (pool.length === 0) {
    throw assignmentError('No configured Work Center VP candidates are available', {
      policy, stageType, candidates: configuredCandidates, excluded,
    });
  }
  const eligible = pool.filter(vp => !excluded.has(vp.id));
  if (eligible.length === 0) {
    throw assignmentError('No Work Center VP satisfies the stage separation policy', {
      policy, stageType, candidates: pool, excluded,
    });
  }
  if (policy.mode === 'planned') {
    return {
      vp: eligible[0],
      reason: `planned:${eligible[0].id}:${policy.assignmentReason || stageType}`,
      policy,
    };
  }

  const ranked = eligible
    .map(vp => ({ vp, score: capabilityScore(vp, policy.capability || stageType) }))
    .sort((left, right) => right.score - left.score || left.vp.id.localeCompare(right.vp.id));
  if (ranked[0].score === 0 && policy.mode === 'auto') {
    const fallback = eligible
      .map(vp => ({ vp, score: capabilityScore(vp, stageType) }))
      .sort((left, right) => right.score - left.score || left.vp.id.localeCompare(right.vp.id));
    if (fallback[0]?.score > 0) {
      return {
        vp: fallback[0].vp,
        reason: `${policy.mode}:${policy.capability || stageType}:fallback=${stageType}:score=${fallback[0].score}`,
        policy,
      };
    }
    return {
      vp: fallback[0].vp,
      reason: `${policy.mode}:${policy.capability || stageType}:fallback=${stageType}:eligible-id:score=0`,
      policy,
    };
  }
  return {
    vp: ranked[0].vp,
    reason: `${policy.mode}:${policy.capability || stageType}:score=${ranked[0].score}`,
    policy,
  };
}

function availableModel(config, ref) {
  const models = Array.isArray(config.availableModels) ? config.availableModels : [];
  if (models.length === 0) return null;
  const parsed = parseModelRef(ref);
  return models.find(model => model.ref === ref)
    || models.find(model => model.id === parsed.modelId
      && (!parsed.providerName || model.provider === parsed.providerName))
    || null;
}

export function resolveWorkItemModel(config, vp, rawPolicy, modelTags = {}) {
  const policy = normalizeModelPolicy(rawPolicy);
  let model;
  let source;
  if (policy.mode === 'specific') {
    model = policy.model;
    source = 'stage-specific';
  } else if (policy.mode === 'tag') {
    model = modelTags[policy.tag] || null;
    source = `tag:${policy.tag}`;
  } else if (policy.mode === 'primary') {
    model = config.primaryModel || config.model || null;
    source = 'agent-primary';
  } else if (policy.mode === 'fast') {
    model = config.fastModel || null;
    source = 'agent-fast';
  } else if (vp.modelHint === 'fast') {
    model = config.fastModel || config.primaryModel || config.model || null;
    source = config.fastModel ? 'vp-fast' : 'vp-fast-primary-fallback';
  } else {
    model = config.primaryModel || config.model || null;
    source = vp.modelHint === 'primary' ? 'vp-primary' : 'agent-default';
  }
  if (!model) throw policyError(`Work Center model policy "${policy.mode}" has no configured model`);
  const available = availableModel(config, model);
  if (Array.isArray(config.availableModels) && config.availableModels.length > 0 && !available) {
    throw policyError(`Configured Work Center model is unavailable: ${model}`);
  }
  if (policy.mode === 'tag' && available?.ref) model = available.ref;
  const effortOptions = Array.isArray(available?.effortOptions) ? available.effortOptions : [];
  const effortOrder = ['medium', 'high', 'xhigh'];
  const requestedIndex = effortOrder.indexOf(policy.effort);
  const effort = !policy.effort || effortOptions.length === 0
    ? null
    : effortOptions.includes(policy.effort)
      ? policy.effort
      : effortOptions
          .map(value => ({ value, distance: Math.abs(effortOrder.indexOf(value) - requestedIndex) }))
          .filter(item => effortOrder.includes(item.value))
          .sort((left, right) => left.distance - right.distance
            || effortOrder.indexOf(right.value) - effortOrder.indexOf(left.value))[0]?.value || null;
  const parsed = parseModelRef(model);
  return {
    model,
    effort,
    provider: available?.provider || parsed.providerName || null,
    source,
    policy,
  };
}
