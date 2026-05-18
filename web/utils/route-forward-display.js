export function formatMentionList(ids, options = {}) {
  const separator = options.separator || ', ';
  const list = Array.isArray(ids) ? ids : [];
  return list.map((id) => `@${id}`).join(separator);
}

export function formatRouteForwardHandoffLabel(hint, t) {
  if (!hint) return '';
  const mentions = formatMentionList(hint.toVpIds);
  const text = typeof hint.text === 'string' ? hint.text.trim() : '';

  try {
    if (typeof t === 'function') {
      if (hint.broadcast) {
        if (text) return t('unify.handoff.broadcastChat', { mentions, text });
        return t('unify.handoff.broadcast', { mentions });
      }
      if (text) return t('unify.handoff.chat', { mentions, text });
      return t('unify.handoff.targets', { mentions });
    }
  } catch (_) {
    // Fall through to plain strings.
  }

  if (hint.broadcast) {
    if (text) return `${mentions}: ${text} (broadcast)`;
    return `Forwarded to ${mentions} (broadcast)`;
  }
  if (text) return `${mentions}: ${text}`;
  return `Forwarded to ${mentions}`;
}

export function formatRouteForwardHandoffReason(hint, t) {
  if (!hint || !hint.reason) return '';
  try {
    if (typeof t === 'function') {
      return t('unify.handoff.reason', { reason: hint.reason });
    }
  } catch (_) {
    // Fall through to plain string.
  }
  return `reason: ${hint.reason}`;
}

export function formatRouteForwardToolLine(input, truncate = (value) => value) {
  const to = input && typeof input.to === 'string' && input.to ? input.to : '?';
  const target = to === 'all' ? '@all' : `@${to}`;
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (text) return `Route ${target}: ${truncate(text, 70)}`;
  return `Route ${target}`;
}
