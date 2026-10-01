import { bytes, digest, fail, identifier, object, page, text } from './contracts.js';

// Trusted versioned read-only methods, not the Agent's full registry. No shell/filesystem/VP side effects.
const entries = [
  { id: 'Think', version: 1, domain: 'cognition', description: 'Intrinsic deliberate reflection, reorganization, association and reconsideration.', keywords: '思考 整理 反思 think reflection', useWhen: 'Think with the evidence already present, or rest when nothing warrants further work.', avoidWhen: 'Do not invent evidence or call a tool merely to appear thoughtful.', instructions: 'Revisit supplied experiences and current judgments; separate report from hypothesis, propose new concepts or associations, test a counterexample, and record the explicit finding with uncertainty. It is fine to rest. This is a method, not another model call or external action.', args: {} },
  { id: 'Recall', version: 1, domain: 'memory', description: 'Recall a bounded page of your own long-term messages or concepts.', keywords: '回忆 记忆 召回 历史 查找 搜索 memory recall history search', useWhen: 'Missing prior words, experiences or concepts could change your present understanding.', avoidWhen: 'Current evidence is sufficient; a similar memory cannot grant permission or establish truth.', instructions: 'args: {kind:"messages"|"concepts",query?:string,cursor?:string|null,limit?:1..5}. SQLite uses local hybrid keyword/semantic recall when available; inspect retrieval mode, coverage and degradation. Legacy storage may use literal matching. Results are not exhaustive or authorization. Preserve nextCursor for the same query; local ranking cursors expire after 5 minutes or restart.', args: { kind: 'messages|concepts', query: 'optional memory search text', cursor: 'optional opaque cursor', limit: '1..5' } },
  { id: 'Skill.reconsider', version: 1, domain: 'method', description: 'Read-only method for revising a previous judgment.', keywords: '反思 复核 反例 修正 重新审视 reconsider revise counterexample', useWhen: 'A prior judgment meets conflicting evidence or may have overlooked an alternative.', avoidWhen: 'Do not force a revision or treat a hypothetical counterexample as observed evidence.', instructions: 'Identify one prior claim, list a concrete counterexample or missing evidence, and decide whether to retain, qualify or revise it. Mark what remains unresolved. Do not present the counterexample as an observed event without evidence.', args: {} },
  { id: 'Skill.associate', version: 1, domain: 'method', description: 'Read-only method for new conceptual associations.', keywords: '联想 关联 遐想 想象 associate association imagine dream', useWhen: 'Explore a possible relation between experiences or concepts and preserve it as a question or hypothesis.', avoidWhen: 'Do not equate similarity or co-occurrence with causation or verified experience.', instructions: 'Compare two recalled concepts or experiences. Propose a typed relation and a new question or hypothetical scenario. Co-occurrence is not causation; imagination is not an experience. Keep useful disagreement instead of forcing agreement.', args: {} },
];
const manifests = entries.map(entry => {
  const contract = { ...entry, access: 'read-only', dependencies: [] };
  return { ...contract, revision: digest(contract) };
});
const byId = new Map(manifests.map(manifest => [manifest.id, manifest]));
const foundationIds = new Set(['Think', 'Recall']);
export const CAPABILITY_LIMITS = Object.freeze({ familiar: 2, familiarMaxAgeMs: 30 * 24 * 60 * 60 * 1000, activeBytes: 8192, searchContractBytes: 4096 });
export const CAPABILITY_MAP = Object.freeze({
  domains: ['cognition', 'memory', 'method'], total: entries.length,
  discover: { id: 'catalog.search', args: '{query?:string,cursor?:string|null,limit?:1..5}', description: 'Browse/search summaries with budgeted complete contracts. Returned contracts are prepared for the next call; omitted contracts require catalog.view. All entries remain reachable by pagination.' },
  inspect: { id: 'catalog.view', args: '{id:string}', description: 'Load a known ID directly, or a contract omitted by search. No search is required first.' },
  intrinsic: 'Think is always available as a cognitive activity; no tool call is required.',
});
export const catalogRevision = digest(manifests);
const copy = value => structuredClone(value);
const available = (manifest, layer, reason, experience) => ({ ...copy(manifest), availability: { layer, reason, ...(experience ? { experience } : {}) } });
export const foundationCapabilities = () => manifests.filter(m => foundationIds.has(m.id)).map(m => available(m, 'foundation', 'general-cognitive-ability'));

/** A bounded procedural familiarity projection, never a stored contract or authorization.
 * Only execution observations for this Person arrive from the fenced repository snapshot.
 * Trigger kind is a coarse preference, not a semantic classifier or a compulsory workflow. */
function familiarCapabilities(experience, triggerKind, now) {
  const candidates = [];
  for (const item of Array.isArray(experience) ? experience.slice(0, 16) : []) {
    const manifest = byId.get(item?.id);
    if (!manifest || foundationIds.has(item.id) || item.version !== manifest.version || item.revision !== manifest.revision) continue;
    const observations = (Array.isArray(item.observations) ? item.observations.slice(0, 8) : [])
      .filter(o => ['succeeded', 'failed'].includes(o?.outcome) && ['send', 'think', 'dream'].includes(o.triggerKind) && Number.isFinite(Date.parse(o.usedAt)))
      .sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt));
    const latest = observations[0], age = now - Date.parse(latest?.usedAt);
    if (!latest || latest.outcome !== 'succeeded' || age < 0 || age > CAPABILITY_LIMITS.familiarMaxAgeMs) continue;
    const matching = observations.filter(o => o.triggerKind === triggerKind && now - Date.parse(o.usedAt) >= 0 && now - Date.parse(o.usedAt) <= CAPABILITY_LIMITS.familiarMaxAgeMs);
    candidates.push({ manifest, latest, matching: matching.length, experience: {
      lastUsedAt: latest.usedAt, lastOutcome: latest.outcome,
      observedSuccesses: observations.filter(o => o.outcome === 'succeeded').length,
      observedFailures: observations.filter(o => o.outcome === 'failed').length,
      sameTriggerObservations: matching.length, usefulness: 'not-evaluated',
    } });
  }
  return candidates.sort((a, b) => b.matching - a.matching || Date.parse(b.latest.usedAt) - Date.parse(a.latest.usedAt) || a.manifest.id.localeCompare(b.manifest.id, 'en'))
    .slice(0, CAPABILITY_LIMITS.familiar).map(c => available(c.manifest, 'familiar', c.matching ? 'used-in-same-trigger-kind' : 'recently-used', c.experience));
}

export class PersonCapabilities {
  constructor(repository, ownerId, { experience = [], triggerKind = 'think', now = Date.now() } = {}) {
    this.repository = repository; this.ownerId = ownerId;
    this.prepared = new Map([...foundationCapabilities(), ...familiarCapabilities(experience, triggerKind, now)].map(m => [m.id, m]));
    this.active = new Map(this.prepared);
  }
  context() { return copy([...this.prepared.values()]); }
  /** Freeze execution eligibility to the complete contracts actually rendered in this call. */
  activate(rendered) {
    this.active = new Map();
    for (const item of rendered) {
      const current = byId.get(item.id);
      if (current && current.revision === item.revision && this.prepared.has(item.id)) this.active.set(item.id, current);
    }
  }
  executionManifest(id) {
    const manifest = this.active.get(id), current = byId.get(id);
    if (!manifest || manifest.revision !== current?.revision) return null;
    return { id: current.id, version: current.version, revision: current.revision };
  }
  prepare(manifest) {
    // A bounded working set. Explicitly requested contracts precede older optional ones.
    const item = available(manifest, foundationIds.has(manifest.id) ? 'foundation' : 'discovered', 'explicitly-requested');
    const next = [item, ...this.prepared.values()].filter((m, i, all) => all.findIndex(n => n.id === m.id) === i);
    const kept = next.filter(m => foundationIds.has(m.id));
    for (const candidate of next.filter(m => !foundationIds.has(m.id))) {
      if (bytes([...kept, candidate]) <= CAPABILITY_LIMITS.activeBytes) kept.push(candidate);
    }
    this.prepared = new Map(kept.map(m => [m.id, m]));
    // Runtime replaces this with its rendered manifest before every cognitive dispatch.
    this.activate(kept);
  }
  async execute({ id, args }, { signal } = {}) {
    signal?.throwIfAborted();
    if (id === 'catalog.search') {
      object(args, ['query', 'cursor', 'limit'], []);
      const query = text(args.query ?? '', 200, true).toLowerCase().trim();
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      if (args.cursor != null) identifier(args.cursor);
      const terms = query.split(/\s+/u).filter(Boolean);
      const matches = manifests.filter(e => terms.every(term => `${e.id} ${e.domain} ${e.description} ${e.keywords} ${e.useWhen}`.toLowerCase().includes(term))).sort((a, b) => a.id.localeCompare(b.id, 'en'));
      const start = args.cursor == null ? 0 : matches.findIndex(e => e.id === args.cursor) + 1;
      if (args.cursor != null && start === 0) fail('INVALID_REQUEST');
      const contracts = [], omittedContracts = [];
      const items = matches.slice(start, start + limit).map(manifest => {
        if (bytes([...contracts, manifest]) <= CAPABILITY_LIMITS.searchContractBytes) { contracts.push(copy(manifest)); this.prepare(manifest); }
        else omittedContracts.push({ id: manifest.id, reason: 'contract-budget', inspect: 'catalog.view' });
        const { instructions, args: schema, dependencies, keywords, ...summary } = manifest;
        return summary;
      });
      return { items, contracts, omittedContracts, nextCursor: start + limit < matches.length ? items.at(-1).id : null, catalogRevision };
    }
    if (id === 'catalog.view') {
      object(args, ['id']); identifier(args.id);
      const entry = byId.get(args.id);
      if (!entry) fail('UNSUPPORTED');
      this.prepare(entry);
      return { ...copy(entry), catalogRevision };
    }
    const entry = byId.get(id);
    if (!entry || !this.executionManifest(id)) fail('UNSUPPORTED');
    if (id === 'Recall') {
      object(args, ['kind', 'query', 'cursor', 'limit'], ['kind']);
      if (!['messages', 'concepts'].includes(args.kind)) fail('INVALID_REQUEST');
      text(args.query ?? '', 200, true);
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      const localCursor = typeof args.cursor === 'string' && /^lm:[a-f0-9]{32}:\d{1,6}$/.test(args.cursor);
      const cursor = args.kind === 'messages' && !localCursor ? page({ cursor: args.cursor, limit }).cursor : args.cursor;
      if (cursor != null && (localCursor || args.kind === 'concepts')) identifier(cursor);
      const result = await this.repository.recall(this.ownerId, { ...args, cursor, limit }, { signal });
      signal?.throwIfAborted();
      if (bytes(result) > 60000) fail('CONTEXT_LIMIT');
      return { ...result, kind: args.kind, version: entry.version };
    }
    object(args, []);
    return { id, version: entry.version, instructions: entry.instructions, access: 'method-only' };
  }
}
