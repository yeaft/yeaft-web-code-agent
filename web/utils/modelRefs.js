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
