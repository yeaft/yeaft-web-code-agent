export function formatRouteForwardToolLine(input, truncate = (value) => value) {
  const to = input && typeof input.to === 'string' && input.to ? input.to : '?';
  const target = to === 'all' ? '@all' : `@${to}`;
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (text) return `Route ${target}: ${truncate(text, 70)}`;
  return `Route ${target}`;
}
