// Pure model helpers for the Yeaft Debug > Dream master-detail view.

function parseListValue(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseFrontmatter(raw) {
  const meta = {};
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === 'tags' || key === 'sourceMessages') {
      meta[key] = parseListValue(value);
    } else {
      meta[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return meta;
}

export function parseDreamMemorySegments(memoryText) {
  const text = typeof memoryText === 'string' ? memoryText.trim() : '';
  if (!text) return [];
  const segments = [];
  const re = /(?:^|\n)---\s*\n([\s\S]*?)\n---\s*\n/g;
  let match;
  let lastEnd = 0;
  while ((match = re.exec(text))) {
    const bodyStart = re.lastIndex;
    const next = text.slice(bodyStart).search(/\n---\s*\n/);
    const bodyEnd = next >= 0 ? bodyStart + next : text.length;
    const meta = parseFrontmatter(match[1]);
    const body = text.slice(bodyStart, bodyEnd).trim();
    if (body || Object.keys(meta).length > 0) {
      segments.push({
        id: meta.id || `segment-${segments.length + 1}`,
        scope: meta.scope || '',
        kind: meta.kind || 'memory',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        sourceMessages: Array.isArray(meta.sourceMessages) ? meta.sourceMessages : [],
        createdAt: meta.createdAt || '',
        updatedAt: meta.updatedAt || '',
        content: body,
      });
    }
    lastEnd = bodyEnd;
    re.lastIndex = bodyEnd;
  }
  if (segments.length === 0) {
    return [{
      id: 'memory-1',
      scope: '',
      kind: 'memory',
      tags: [],
      sourceMessages: [],
      createdAt: '',
      updatedAt: '',
      content: text,
    }];
  }
  const tail = text.slice(lastEnd).trim();
  if (tail && !tail.startsWith('---')) {
    segments.push({
      id: `segment-${segments.length + 1}`,
      scope: '',
      kind: 'memory',
      tags: [],
      sourceMessages: [],
      createdAt: '',
      updatedAt: '',
      content: tail,
    });
  }
  return segments;
}

export function previewText(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}...`;
}

export function buildDreamDebugItems({ latest = {}, snapshots = {}, promptLoads = {}, events = [] } = {}) {
  const scopes = new Set([
    ...Object.keys(latest || {}),
    ...Object.keys(snapshots || {}),
    ...Object.keys(promptLoads || {}),
  ]);
  for (const evt of Array.isArray(events) ? events : []) {
    if (evt?.scope) scopes.add(evt.scope);
  }
  return Array.from(scopes).map((scope) => {
    const snapshot = snapshots?.[scope] || null;
    const latestRun = latest?.[scope] || null;
    const promptLoad = promptLoads?.[scope] || null;
    const scopeEvents = (Array.isArray(events) ? events : []).filter((evt) => evt?.scope === scope);
    const lastEvent = scopeEvents[scopeEvents.length - 1] || null;
    const lastAt = latestRun?.finishedAt || latestRun?.startedAt || snapshot?.lastDreamAt || lastEvent?.at || snapshot?.loadedAt || '';
    const segments = parseDreamMemorySegments(snapshot?.memoryText || '');
    return {
      key: scope,
      scope,
      sessionId: snapshot?.sessionId || scope.replace(/^sessions\//, ''),
      status: latestRun?.status || (snapshot?.hasOutput ? 'completed' : 'never-ran'),
      lastAt,
      latestRun,
      snapshot,
      promptLoad,
      events: scopeEvents,
      segmentCount: segments.length,
      segments,
      summaryPreview: previewText(snapshot?.summaryText || promptLoad?.summary || ''),
      hasRequestResponse: scopeEvents.some((evt) => evt?.request || evt?.response || evt?.systemPrompt || evt?.rawRequest || evt?.rawResponse),
    };
  }).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}
