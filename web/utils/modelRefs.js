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
  medium: 2,
  xhigh: 4,
  max: 5,
  ultra: 6,
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
  // Older Agent catalogs may still advertise retired tiers; never show them.
  return normalizeEffortList(options).filter(effort => Object.hasOwn(EFFORT_RANK, effort));
}

export function getDefaultModelEffort(options) {
  const values = getSelectableModelEfforts(options);
  if (!values.length) return '';
  if (values.includes('xhigh')) return 'xhigh';
  if (values.length === 1) return values[0];
  if (values.includes('ultra') && values.includes('max')) return 'max';
  return values[values.length - 2];
}

export function normalizeModelEffort(effort) {
  if (effort === 'minimal' || effort === 'low') return 'medium';
  if (effort === 'high') return 'xhigh';
  return Object.hasOwn(EFFORT_RANK, effort) ? effort : '';
}

export function resolveSessionModelEffort(session, fallbackEffort = '') {
  const sessionEffort = session?.config?.modelEffort;
  if (typeof sessionEffort === 'string' && sessionEffort.trim()) return normalizeModelEffort(sessionEffort.trim());
  return typeof fallbackEffort === 'string' ? normalizeModelEffort(fallbackEffort.trim()) : '';
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
