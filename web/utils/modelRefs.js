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

/** Resolve a qualified ref first; never borrow another provider's effort policy. */
export function findCatalogModel(models, ref) {
  if (!Array.isArray(models) || !ref) return null;
  const exact = models.filter(model => modelOptionRef(model) === ref);
  const matches = exact.length ? exact : models.filter(model => model.id === ref);
  return matches.length === 1 ? matches[0] : null;
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

const isChat = model => model?.protocol === 'openai-chat-completions';
const isChatCarbon = model => isChat(model) && model.id?.toLowerCase().split('/').at(-1) === 'gemini-4-carbon';

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
  // Keep the native levels distinct; don't expose legacy Low/Minimal as new choices.
  const values = normalizeEffortList(options).filter(effort => !Array.isArray(model?.effortMenuOptions) || model.effortMenuOptions.includes(effort));
  if (hasNativeGeminiLevels(model)) return values.filter(effort => ['medium', 'high', 'xhigh'].includes(effort));
  if (isChatCarbon(model)) return values.filter(effort => effort === 'medium' || effort === 'high');
  return values.filter(effort => Object.hasOwn(EFFORT_RANK, effort) || (isChat(model) && effort === 'high'));
}

export function getDefaultModelEffort(options, model = null) {
  const values = getSelectableModelEfforts(options, model);
  if (!values.length) return '';
  if (hasNativeGeminiLevels(model) && values.includes(model.defaultEffort)) return model.defaultEffort;
  if (isChatCarbon(model) && values.includes('high')) return 'high';
  if (values.includes('xhigh')) return 'xhigh';
  if (model?.effortProtocol === 'gemini' && values.includes(model.defaultEffort)) return model.defaultEffort;
  if (values.length === 1) return values[0];
  if (values.includes('ultra') && values.includes('max')) return 'max';
  return values[values.length - 2];
}

export function normalizeModelEffort(effort, model = null) {
  if (hasNativeGeminiLevels(model) && GEMINI_NATIVE_LEVELS.includes(effort)) return effort;
  if (effort === 'minimal' || effort === 'low') return 'medium';
  if (isChatCarbon(model) && ['xhigh', 'max', 'ultra'].includes(effort)) {
    return ['high', 'medium'].find(value => model.effortOptions?.includes(value)) || '';
  }
  if (effort === 'high') return isChat(model) ? 'high' : 'xhigh';
  return Object.hasOwn(EFFORT_RANK, effort) ? effort : '';
}

function configuredSessionEffort(session, fallbackEffort) {
  const configured = session?.config?.modelEffort;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return typeof fallbackEffort === 'string' ? fallbackEffort.trim() : '';
}

export function resolveSessionModelEffort(session, fallbackEffort = '', model = null) {
  const effort = normalizeModelEffort(configuredSessionEffort(session, fallbackEffort), model);
  if (!hasNativeGeminiLevels(model) || model.effortOptions.includes(effort)) return effort;
  if (['max', 'ultra', 'xhigh'].includes(effort)) return model.effortOptions.at(-1);
  return model.effortOptions.filter(level => GEMINI_NATIVE_LEVELS.indexOf(level) <= GEMINI_NATIVE_LEVELS.indexOf(effort)).at(-1) || '';
}

/** Display the actual saved/native selection, never an unapplied menu default. */
export function getSessionEffortDisplay(session, fallbackEffort, model) {
  const options = getSelectableModelEfforts(model?.effortOptions, model);
  if (!options.length) return '';
  const resolved = resolveSessionModelEffort(session, fallbackEffort, model);
  if (model?.effortProtocol === 'gemini' && configuredSessionEffort(session, fallbackEffort)) {
    return model.effortOptions?.includes(resolved) ? resolved : 'unavailable';
  }
  return options.includes(resolved) ? resolved : getDefaultModelEffort(options, model);
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
