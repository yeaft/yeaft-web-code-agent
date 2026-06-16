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

export function resolveSessionModelEffort(session, fallbackEffort = '') {
  const sessionEffort = session?.config?.modelEffort;
  if (typeof sessionEffort === 'string' && sessionEffort.trim()) return sessionEffort.trim();
  return typeof fallbackEffort === 'string' && fallbackEffort.trim() ? fallbackEffort.trim() : '';
}
