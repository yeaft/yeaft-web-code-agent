// Pure model helpers for the Yeaft Debug > Dream accordion view.

function parseListValue(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
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
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

export function parseDreamMemorySegments(memoryText) {
  const text = String(memoryText || '').trim();
  if (!text) return [];

  const segments = [];
  const re = /(?:^|\n)---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*?)(?=\n---\s*\n|$)/g;
  for (const match of text.matchAll(re)) {
    const rawMeta = match[1].trim();
    const content = match[2].trim();
    const meta = parseFrontmatter(rawMeta);
    segments.push({
      id: meta.id || `segment-${segments.length + 1}`,
      scope: meta.scope || '',
      kind: meta.kind || 'memory',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      sourceMessages: Array.isArray(meta.sourceMessages) ? meta.sourceMessages : [],
      createdAt: meta.createdAt || '',
      updatedAt: meta.updatedAt || '',
      content,
      preview: previewText(content, 180),
    });
  }

  if (segments.length) return segments;
  return [{
    id: 'memory-1',
    scope: '',
    kind: 'raw',
    tags: [],
    sourceMessages: [],
    createdAt: '',
    updatedAt: '',
    content: text,
    preview: previewText(text, 180),
  }];
}

export function previewText(value, limit = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}...`;
}

function titleFromSummary(summaryText) {
  const text = String(summaryText || '').trim();
  if (!text) return '';
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  return firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sessionIdFromScope(scope, snapshot) {
  return snapshot?.sessionId || String(scope || '').replace(/^sessions\//, '');
}

function readableTitleForScope(scope, snapshot, sessionTitles) {
  const sessionId = sessionIdFromScope(scope, snapshot);
  const title = normalizeTitle(
    sessionTitles?.[scope]
      || sessionTitles?.[sessionId]
      || snapshot?.sessionTitle
      || snapshot?.title
      || snapshot?.name
      || titleFromSummary(snapshot?.summaryText)
  );
  return title || sessionId || scope;
}

export function filterDreamDebugItems(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => {
    const haystack = [
      item.title,
      item.scope,
      item.sessionId,
      item.status,
      item.summaryPreview,
      item.snapshot?.summaryText,
    ].map((part) => String(part || '').toLowerCase()).join('\n');
    return haystack.includes(q);
  });
}

export function selectDreamDebugItem(items, activeKey) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  return list.find((item) => item.key === activeKey) || list[0];
}

export function buildDreamDebugItems({ latest = {}, snapshots = {}, promptLoads = {}, events = [], sessionTitles = {} } = {}) {
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
    const sessionId = sessionIdFromScope(scope, snapshot);
    const title = readableTitleForScope(scope, snapshot, sessionTitles);
    const summaryPreview = previewText(snapshot?.summaryText || snapshot?.memoryText || lastEvent?.detail || '', 180);
    return {
      key: scope,
      title,
      scope,
      sessionId,
      status: latestRun?.status || (snapshot?.hasOutput ? 'completed' : 'never-ran'),
      lastAt,
      latestRun,
      snapshot,
      promptLoad,
      events: scopeEvents,
      segmentCount: segments.length,
      segments,
      summaryPreview,
      subtitle: summaryPreview,
      hasRequestResponse: scopeEvents.some((evt) => evt?.request || evt?.response || evt?.systemPrompt || evt?.rawRequest || evt?.rawResponse),
    };
  }).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}
