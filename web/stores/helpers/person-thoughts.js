const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && Boolean(value.trim());
const list = value => Array.isArray(value) ? value : [];
const triggerKinds = new Map([['send', 'input'], ['think', 'think'], ['dream', 'dream']]);
const epistemics = new Set(['reported', 'hypothesis', 'imagined', 'uncertain']);
const terminalKinds = new Set(['committed', 'cancelled', 'failed', 'interrupted', 'budget_exhausted']);

function parse(text) {
  if (typeof text !== 'string') return { parsed: false, value: null };
  try { return { parsed: true, value: JSON.parse(text) }; }
  catch { return { parsed: false, value: null }; }
}

function addText(sections, label, text) {
  if (hasText(text)) sections.push({ label, text });
}

function addTrigger(sections, trigger) {
  const kind = isRecord(trigger) && triggerKinds.get(trigger.kind);
  if (!kind) return;
  if (hasText(trigger.text)) addText(sections, kind, trigger.text);
  else if (kind !== 'input') sections.push({ label: kind });
}

function addMessages(sections, messages) {
  for (const message of list(messages)) {
    if (!isRecord(message)) continue;
    // Only Person conversation roles, never system/developer/provider messages.
    const label = message.role === 'user' ? 'user_message' : message.role === 'assistant' ? 'person_message' : null;
    if (label) addText(sections, label, message.text);
  }
}

function addConcepts(sections, concepts) {
  for (const concept of list(concepts)) {
    if (!isRecord(concept) || !hasText(concept.statement)) continue;
    // Reported means attributed input, not an independently verified fact.
    // Invalid/missing labels must never turn a statement into a factual claim.
    const epistemic = epistemics.has(concept.epistemicState) ? concept.epistemicState : 'uncertain';
    sections.push({ label: `concept_${epistemic}`, text: concept.statement });
  }
}

function addState(sections, state) {
  if (!isRecord(state)) return;
  addText(sections, 'state_summary', state.summary);
  addText(sections, 'appraisal', state.appraisal);
}

function addDecision(sections, decision) {
  if (!isRecord(decision)) return;
  addText(sections, 'decision_summary', decision.summary);
  addText(sections, 'self_check', decision.selfCheck);
  const items = list(decision.uncertainties).filter(hasText);
  if (items.length) sections.push({ label: 'uncertainties', items });
}

function activitySections(value) {
  const sections = [];
  if (isRecord(value?.activity)) addText(sections, 'activity_summary', value.activity.summary);
  addDecision(sections, value?.decision);
  return sections;
}

function proposalSections(value) {
  if (!isRecord(value)) return [];
  const sections = activitySections(value);
  addConcepts(sections, value.concepts);
  addState(sections, value.state);
  addText(sections, 'reply', value.reply);
  if (isRecord(value.next)) addText(sections, 'next_reason', value.next.reason);
  return sections;
}

function recallSections(result) {
  const sections = [];
  if (isRecord(result)) {
    if (result.kind === 'messages') addMessages(sections, result.items);
    if (result.kind === 'concepts') addConcepts(sections, result.items);
  }
  return sections;
}

const scriptId = id => hasText(id) && id.startsWith('Script.') && hasText(id.slice(7));
const scriptFailures = new Map([
  ['SCRIPT_TEST_FAILED', 'script_test_failed'],
  ['SCRIPT_EXECUTION', 'script_execution_failed'],
  ['SCRIPT_TIMEOUT', 'script_timeout'],
  ['SCRIPT_OUTPUT', 'script_output_invalid'],
  ['SCRIPT_VERSION', 'script_version_unavailable'],
  ['SCRIPT_BUSY', 'script_busy'],
]);

function addCapabilityText(sections, label, text, limit = 160) {
  if (hasText(text)) addText(sections, label, text.length > limit ? `${text.slice(0, limit)}…` : text);
}

function addCapabilityVersion(sections, version) {
  if (Number.isSafeInteger(version) && version > 0) addText(sections, 'capability_version', String(version));
}

// An outcome record is not an adopted thought. Only project public contract
// metadata; never arguments, code, test cases, diagnostics, or echoed output.
function capabilityProjection(id, result, failed = false, code = result?.code) {
  if (id !== 'Capability.create' && !scriptId(id)) return null;
  const sections = [];
  if (failed || result?.ok === false) {
    addCapabilityText(sections, 'capability_name', id);
    sections.push({ label: scriptFailures.get(code) || 'capability_failure_unknown' });
    return { kind: 'capability_failed', sections };
  }
  if (!isRecord(result) || result.ok !== true) return null;
  if (id === 'Capability.create') {
    if (result.published !== true || !isRecord(result.contract) || !scriptId(result.contract.id)) return null;
    sections.push({ label: 'capability_published' });
    addCapabilityText(sections, 'capability_name', result.contract.id);
    addCapabilityText(sections, 'capability_description', result.contract.description, 600);
    addCapabilityVersion(sections, result.contract.version);
    const passed = result.evidence?.testsPassed;
    if (Number.isSafeInteger(passed) && passed >= 0) addText(sections, 'capability_tests_passed', String(passed));
    sections.push({ label: 'capability_tests_limit' });
    return { kind: 'capability_created', sections };
  }
  sections.push({ label: 'script_succeeded' });
  addCapabilityText(sections, 'capability_name', id);
  addCapabilityVersion(sections, result.version);
  return { kind: 'script_executed', sections };
}

function contextSections(trace) {
  const message = list(trace.request?.messages)[0];
  if (!isRecord(message) || message.role !== 'user') return [];
  const { value } = parse(message.content);
  if (!isRecord(value)) return [];
  const sections = [];
  addTrigger(sections, value.trigger);
  addState(sections, value.state);
  addMessages(sections, value.messages);
  addConcepts(sections, value.concepts);
  // Continuation inputs must be self-contained even when the preceding call is
  // on an unloaded page. A previous proposal is explicitly NOT adopted state.
  sections.push(...proposalSections(value.previousProposal).map(section => ({ ...section, scope: 'previous_candidate' })));
  const capabilityId = value.previousProposal?.next?.capability?.id;
  if (capabilityId === 'Recall') {
    sections.push(...recallSections(value.capabilityResult).map(section => ({ ...section, scope: 'recalled' })));
  } else {
    const projection = capabilityProjection(capabilityId, value.capabilityResult);
    if (projection) sections.push(...projection.sections.map(section => ({ ...section, scope: 'capability_recorded' })));
  }
  return sections;
}

// A rendering shape check, not the runtime's provenance/revision validator. Even a
// complete-looking proposal is only a candidate without a matching commit trace.
function completeShape(value) {
  return isRecord(value) && Number.isSafeInteger(value.baseStateVersion)
    && isRecord(value.activity) && hasText(value.activity.summary)
    && isRecord(value.decision) && hasText(value.decision.summary) && hasText(value.decision.selfCheck)
    && Array.isArray(value.decision.uncertainties) && Array.isArray(value.concepts)
    && isRecord(value.state) && hasText(value.state.summary) && typeof value.state.appraisal === 'string'
    && (value.reply === null || typeof value.reply === 'string')
    && (value.next === null || (isRecord(value.next) && hasText(value.next.reason)));
}

function outputProjection(trace) {
  const output = isRecord(trace.output) ? trace.output : {};
  const { parsed, value } = parse(output.text);
  const sections = proposalSections(value);
  const partial = trace.kind === 'call_failed' || output.complete === false || output.accepted === false
    || (sections.length > 0 && !completeShape(value));
  const incomplete = partial || !sections.length;
  if (incomplete) {
    // A cancelled call often retains a JSON prefix. Parse failure must not bypass
    // the field allowlist and expose sourceRefs/model/other technical metadata.
    // Conservatively keep bracketed/quoted/fenced output in the debug page; only
    // clearly unstructured public prose can fall back to verbatim text here.
    const structured = !parsed && typeof output.text === 'string' && /[{}[\]]|```|^\s*"/.test(output.text);
    const label = !hasText(output.text) ? 'unavailable' : structured ? 'structured_unavailable' : partial ? 'incomplete' : 'unstructured';
    sections.unshift(!parsed && !structured && hasText(output.text) ? { label, text: output.text } : { label });
  }
  return { sections, incomplete };
}

const callKey = trace => hasText(trace.callId) ? JSON.stringify([trace.episodeId, trace.callId]) : null;
const timestamp = value => {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

/**
 * Project already owner/Agent-scoped Person traces into a content-first thought journal.
 * Pure and non-mutating; no persistence, provider calls, translation or HTML rendering.
 * Sequence is the repository's chronological order (timestamps break ties/fill gaps).
 * Pagination is intentionally not inferred: only an exact episode + call commit marks
 * a proposal committed. Earlier calls remain candidates even in a committed episode.
 *
 * Sections contain only public cognition fields and narrow capability outcome metadata,
 * never request/system/catalog/manifest, code, arguments, tests, raw script output,
 * provider reasoning, usage, provenance IDs or arbitrary serialized objects. Consumers
 * MUST render text/items with text interpolation, not v-html or an HTML/Markdown parser.
 * Kinds, statuses and section labels are suffixes under `person.thought.`.
 *
 * @param {unknown} traces A possibly partial, unordered array of repository trace records.
 * @returns {Array<{id: string, episodeId: string, callId?: string, createdAt: string|null,
 *   kind: string, status: 'candidate'|'committed'|'rejected'|'incomplete'|'recorded',
 *   sections: Array<{label: string, scope?: string, text?: string, items?: string[]}>}>}
 */
export function projectPersonThoughts(traces) {
  const seen = new Set();
  const records = list(traces).filter(trace => {
    if (!isRecord(trace) || !hasText(trace.id) || !hasText(trace.episodeId)) return false;
    const key = JSON.stringify([trace.episodeId, trace.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    if (Number.isSafeInteger(a.seq) && Number.isSafeInteger(b.seq) && a.seq !== b.seq) return a.seq - b.seq;
    return (timestamp(a.createdAt) ?? 0) - (timestamp(b.createdAt) ?? 0);
  });

  // A complete page is not required: terminal evidence may arrive before its output.
  const outcomes = new Map();
  const outputs = new Map();
  for (const trace of records) {
    const key = callKey(trace);
    if (key && ['committed', 'proposal_rejected', 'call_failed'].includes(trace.kind)) {
      const outcome = outcomes.get(key) || new Set();
      outcome.add(trace.kind); outcomes.set(key, outcome);
    }
    if (['call_output', 'call_failed'].includes(trace.kind)) {
      const projection = outputProjection(trace);
      // This map deduplicates only rendered content, not the presence of raw output.
      if (key) outputs.set(key, [...(outputs.get(key) || []), ...projection.sections]);
    }
  }
  const statusFor = (trace, incomplete = false) => {
    const outcome = outcomes.get(callKey(trace));
    if (outcome?.has('proposal_rejected')) return 'rejected';
    if (incomplete || outcome?.has('call_failed')) return 'incomplete';
    if (outcome?.has('committed')) return 'committed';
    return 'candidate';
  };
  const withoutOutput = (trace, sections) => {
    const rendered = outputs.get(callKey(trace)) || [];
    return sections.filter(section => !rendered.some(other => JSON.stringify(other) === JSON.stringify(section)));
  };
  const entries = [];
  const add = (trace, kind, status, sections = []) => {
    const time = timestamp(trace.createdAt);
    entries.push({ id: trace.id, episodeId: trace.episodeId,
      ...(hasText(trace.callId) ? { callId: trace.callId } : {}),
      createdAt: time === null ? null : new Date(time).toISOString(), kind, status, sections });
  };
  for (const trace of records) {
    if (trace.kind === 'accepted') {
      const kind = isRecord(trace.trigger) && triggerKinds.get(trace.trigger.kind);
      if (!kind) continue;
      const sections = [];
      addText(sections, kind, trace.trigger.text);
      add(trace, kind, 'recorded', sections);
    } else if (trace.kind === 'call_started') {
      const sections = contextSections(trace);
      if (sections.length) add(trace, 'context', 'recorded', sections);
    } else if (trace.kind === 'call_output' || trace.kind === 'call_failed') {
      const { sections, incomplete } = outputProjection(trace);
      add(trace, 'thought', statusFor(trace, incomplete), sections);
    } else if (trace.kind === 'activity') {
      const sections = withoutOutput(trace, activitySections(trace));
      if (sections.length) add(trace, 'activity', statusFor(trace), sections);
    } else if (trace.kind === 'capability_result' || trace.kind === 'capability_failed') {
      if (trace.kind === 'capability_result' && trace.capability?.id === 'Recall') {
        const sections = recallSections(trace.result);
        if (sections.length) add(trace, 'memory', 'recorded', sections);
      } else {
        const failed = trace.kind === 'capability_failed';
        const projection = capabilityProjection(failed ? trace.capabilityId : trace.capability?.id, trace.result, failed, trace.code ?? trace.result?.code);
        if (projection) add(trace, projection.kind, 'recorded', projection.sections);
      }
    } else if (trace.kind === 'proposal_rejected') {
      // With the output on another page, rejection must still be visible.
      if (!outputs.has(callKey(trace))) add(trace, 'rejected', 'rejected');
    } else if (terminalKinds.has(trace.kind)) {
      const sections = [];
      if (trace.kind === 'committed') addDecision(sections, trace.decision);
      add(trace, trace.kind, trace.kind === 'committed' ? 'committed' : 'recorded', withoutOutput(trace, sections));
    }
  }
  return entries;
}
