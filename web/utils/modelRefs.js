export function modelOptionRef(model) {
  if (!model || typeof model !== 'object') return '';
  if (typeof model.ref === 'string' && model.ref) return model.ref;
  if (typeof model.provider === 'string' && model.provider && typeof model.id === 'string' && model.id) {
    return `${model.provider}/${model.id}`;
  }
  return typeof model.id === 'string' ? model.id : '';
}

export function modelOptionMatchesRef(model, ref) {
  if (!model || !ref) return false;
  return model.id === ref || modelOptionRef(model) === ref;
}

export function resolveSessionModelRef(session, fallbackModel = '') {
  const sessionModel = session?.config?.model;
  if (typeof sessionModel === 'string' && sessionModel.trim()) return sessionModel.trim();
  return typeof fallbackModel === 'string' && fallbackModel.trim() ? fallbackModel.trim() : '';
}

const EFFORT_RANK = Object.freeze({
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
});

function normalizeEffortList(options) {
  if (!Array.isArray(options)) return [];
  const values = [];
  for (const value of options) {
    if (typeof value !== 'string') continue;
    const effort = value.trim();
    if (!effort || values.includes(effort)) continue;
    values.push(effort);
  }
  return values;
}

export function getSelectableModelEfforts(options) {
  return normalizeEffortList(options).filter(effort => (EFFORT_RANK[effort] ?? -1) >= EFFORT_RANK.medium);
}

export function getDefaultModelEffort(options) {
  const values = normalizeEffortList(options);
  if (!values.length) return '';
  if (values.length === 1) return values[0];
  return values[values.length - 2];
}

export function resolveSessionModelEffort(session, fallbackEffort = '') {
  const sessionEffort = session?.config?.modelEffort;
  if (typeof sessionEffort === 'string' && sessionEffort.trim()) return sessionEffort.trim();
  return typeof fallbackEffort === 'string' && fallbackEffort.trim() ? fallbackEffort.trim() : '';
}

export function buildModelSelectionRows(models) {
  const rows = [];
  for (const model of Array.isArray(models) ? models : []) {
    const modelRef = modelOptionRef(model);
    if (!modelRef) continue;
    const label = model.label || model.id || modelRef;
    const efforts = getSelectableModelEfforts(model?.effortOptions);
    rows.push({
      model,
      modelRef,
      label,
      efforts,
      defaultEffort: getDefaultModelEffort(efforts) || null,
    });
  }
  return rows;
}
