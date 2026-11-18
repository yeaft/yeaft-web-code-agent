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

const GEMINI_NATIVE_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const hasNativeGeminiLevels = model => model?.effortProtocol === 'gemini'
  && (model.geminiThinkingMode === 'level' || (!model.geminiThinkingMode
    && model.effortOptions?.some(effort => ['minimal', 'low', 'high'].includes(effort))));

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

export function getSelectableModelEfforts(options, model = null) {
  // Native capabilities and saved values remain available to the transport.
  // Menus start at Medium and only offer High if X-High is unavailable.
  const values = normalizeEffortList(options).filter(effort => !Array.isArray(model?.effortMenuOptions) || model.effortMenuOptions.includes(effort));
  return values.filter(effort => Object.hasOwn(EFFORT_RANK, effort)
    || (effort === 'high' && hasNativeGeminiLevels(model) && !values.includes('xhigh')));
}

export function getDefaultModelEffort(options, model = null) {
  const values = getSelectableModelEfforts(options, model);
  if (!values.length) return '';
  if (values.includes('xhigh')) return 'xhigh';
  if (model?.effortProtocol === 'gemini' && values.includes(model.defaultEffort)) return model.defaultEffort;
  if (values.length === 1) return values[0];
  if (values.includes('ultra') && values.includes('max')) return 'max';
  return values[values.length - 2];
}

export function normalizeModelEffort(effort, model = null) {
  if (hasNativeGeminiLevels(model) && GEMINI_NATIVE_LEVELS.includes(effort)) return effort;
  if (effort === 'minimal' || effort === 'low') return 'medium';
  if (effort === 'high') return 'xhigh';
  return Object.hasOwn(EFFORT_RANK, effort) ? effort : '';
}

export function resolveSessionModelEffort(session, fallbackEffort = '', model = null) {
  const configured = session?.config?.modelEffort;
  const raw = typeof configured === 'string' && configured.trim() ? configured : fallbackEffort;
  if (typeof raw !== 'string') return '';
  const effort = normalizeModelEffort(raw.trim(), model);
  if (!hasNativeGeminiLevels(model) || model.effortOptions.includes(effort)) return effort;
  if (['max', 'ultra', 'xhigh'].includes(effort)) return model.effortOptions.at(-1);
  return model.effortOptions.filter(level => GEMINI_NATIVE_LEVELS.indexOf(level) <= GEMINI_NATIVE_LEVELS.indexOf(effort)).at(-1) || '';
}

export function buildModelSelectionRows(models) {
  const rows = [];
  for (const model of Array.isArray(models) ? models : []) {
    const modelRef = modelOptionRef(model);
    if (!modelRef) continue;
    const label = model.label || model.id || modelRef;
    const efforts = getSelectableModelEfforts(model?.effortOptions, model);
    rows.push({
      model,
      modelRef,
      label,
      efforts,
      defaultEffort: getDefaultModelEffort(efforts, model) || null,
    });
  }
  return rows;
}
