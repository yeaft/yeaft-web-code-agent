/** Allowlisted activity projection for conversation UI. Never retain prompts,
 * proposals, arguments, outputs, diagnostics or model-generated descriptions.
 * These records describe observed execution, not an inferred plan or progress %.
 */
const TERMINAL = { committed: 'completed', completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted', budget_exhausted: 'budgetExhausted' };
const KINDS = new Set(['accepted', 'call_started', 'call_output', 'call_failed', 'capability_started', 'capability_result', 'capability_failed', ...Object.keys(TERMINAL)]);
const key = name => `person.activity.${name}`;
const timestamp = value => {
  const ms = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

function capability(id) {
  const known = {
    Recall: ['recall', 'recalling'],
    Think: ['methodRead', 'readingMethod'],
    'catalog.search': ['skillSearch', 'searchingSkills'],
    'catalog.view': ['skillRead', 'readingSkill'],
    'Skill.reconsider': ['methodRead', 'readingMethod'],
    'Skill.associate': ['methodRead', 'readingMethod'],
    'Capability.create': ['capabilityCreate', 'validatingCapability'],
  };
  if (Object.hasOwn(known, id)) return { label: key(known[id][0]), phase: key(known[id][1]), params: {} };
  if (typeof id === 'string' && /^Script\.[a-z][a-z0-9-]{0,47}$/.test(id)) {
    return { label: key('script'), phase: key('runningScript'), params: { name: id } };
  }
  return { label: key('capability'), phase: key('usingCapability'), params: {} };
}

export function personActivityRecords(traces) {
  return (Array.isArray(traces) ? traces : []).filter(t => t && typeof t.episodeId === 'string' && KINDS.has(t.kind))
    .map(t => ({
      id: t.id, episodeId: t.episodeId, callId: typeof t.callId === 'string' ? t.callId : null,
      seq: Number.isSafeInteger(t.seq) ? t.seq : 0, kind: t.kind, at: timestamp(t.createdAt),
      ...(t.kind === 'accepted' ? { trigger: ['send', 'think', 'dream'].includes(t.trigger?.kind) ? t.trigger.kind : null } : {}),
      ...(t.kind.startsWith('capability_') ? { ...capability(t.capability?.id ?? t.capabilityId), failed: t.kind === 'capability_failed' || t.result?.ok === false } : {}),
    })).sort((a, b) => a.seq - b.seq).slice(-50);
}

/** Input belongs to one controller owner/Agent generation. Only latest-tail
 * activityRecords are consumed: paged diagnostic history is not live progress.
 */
export function projectPersonActivity(state, gate = '') {
  const pending = state.commandPending;
  // An unconfirmed new admission is not the previously completed episode.
  const uncertain = !!state.retryCommand && !state.busy;
  const episodeId = pending || uncertain ? null : state.episodeId || state.latestEpisode?.id || state.activityEpisodeId;
  const records = pending || uncertain ? [] : (state.activityRecords || []).filter(t => t.episodeId === episodeId);
  const accepted = records.find(t => t.kind === 'accepted');
  const terminal = records.findLast(t => TERMINAL[t.kind]);
  const episode = state.latestEpisode?.id === episodeId ? state.latestEpisode : null;
  const outcome = TERMINAL[episode?.status] || TERMINAL[terminal?.kind];
  const active = !outcome && (state.busy || pending);
  const visible = !['disabled', 'unsupported', 'noAgent'].includes(gate) && !!(active || outcome || records.length || state.retryCommand);
  const rows = [];
  const calls = new Map();
  let phase = key(accepted?.trigger === 'dream' ? 'dreaming' : accepted?.trigger === 'think' ? 'thinking' : 'preparing');
  let params = {};
  for (const record of records) {
    const model = record.kind.startsWith('call_');
    if (!model && !record.kind.startsWith('capability_')) continue;
    // A capability belongs to the model call which requested it, not the next
    // call. Keep their lifecycles separate even though callId is shared.
    const identity = `${model ? 'model' : 'capability'}:${record.callId || record.id}`;
    let row = calls.get(identity);
    if (!row) {
      row = { id: identity, label: model ? key('model') : record.label, params: model ? {} : record.params,
        status: 'running', durationMs: null, start: null };
      calls.set(identity, row); rows.push(row);
    }
    if (record.kind.endsWith('_started')) {
      row.start = record.at;
      if (!model) { phase = record.phase; params = record.params; }
      else { phase = key(accepted?.trigger === 'dream' ? 'dreaming' : accepted?.trigger === 'think' ? 'thinking' : 'preparing'); params = {}; }
    } else {
      row.status = record.kind === 'call_failed' || record.failed ? 'failed' : 'completed';
      row.durationMs = row.start != null && record.at != null && record.at >= row.start ? record.at - row.start : null;
      phase = key(model && record.kind === 'call_output' ? 'processingResponse' : 'preparing'); params = {};
    }
  }
  // Missing end records (e.g. the bounded tail or cancellation) never imply
  // success. An authoritative episode terminal fences all spinners.
  for (const row of rows) {
    if (row.status === 'running' && (outcome || !active)) row.status = ['cancelled', 'interrupted'].includes(outcome) ? outcome : 'unknown';
    if (row.status === 'running' && (gate || state.activityStale || state.progressStale)) row.status = 'unknown';
    delete row.start;
  }
  let label = phase;
  if (outcome) label = key(outcome);
  else if (pending) label = key('confirming');
  else if (state.cancelPending) label = key('stopping');
  else if (state.retryCommand && !state.busy) label = key('uncertain');
  else if (!active || state.activityStale || state.progressStale) label = key('stale');
  if (gate === 'disconnected' || gate === 'offline') label = key('disconnected');
  if (label !== phase) params = {};
  return {
    visible, loading: visible && active && !gate && !state.activityStale && !state.progressStale,
    label, params, episodeId, rows: rows.slice(-30),
    startedAt: accepted?.at ?? null, endedAt: timestamp(episode?.endedAt) ?? terminal?.at ?? null,
    limited: rows.length > 30 || (!!records.length && !accepted),
  };
}
