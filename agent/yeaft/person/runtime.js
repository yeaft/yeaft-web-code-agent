import { randomUUID } from 'node:crypto';
import { CAPABILITY_MAP, CAPABILITY_LIMITS, foundationCapabilities, PersonCapabilities, catalogRevision as capabilityCatalogRevision } from './capabilities.js';
import { abortable, collectOutput } from './provider.js';
import { bytes, fail, LIMITS, PersonError, PROPOSAL_INSTRUCTIONS, reportedLineage, safeError, validateProposal, validateSelection } from './contracts.js';

const messageRef = m => `message:${m.id}:${m.revision}`;
const conceptRef = c => `concept:${c.id}:${c.revision}`;

/** Assemble bounded request copies. Omitting a record never deletes or truncates its durable original. */
export function assembleContext({ snapshot, episode, provider, selection, previous, capabilityResult, remainingCalls, dependencyRefs = [], activeCapabilities = foundationCapabilities() }) {
  const model = validateSelection(selection, provider.catalog);
  // UTF-8 bytes is a conservative text-token bound; reserve explicit envelope/output overhead.
  const contextCap = Math.min(LIMITS.contextBytes, model.contextWindow - model.maxOutput - 1024);
  const system = `${snapshot.person.soul}\n\n${PROPOSAL_INSTRUCTIONS}`;
  const triggerRef = `trigger:${episode.id}`;
  const context = {
    person: { id: snapshot.person.id, name: snapshot.person.name, soulRevision: snapshot.person.soulRevision },
    state: snapshot.state, trigger: { kind: episode.kind, text: episode.text, ref: triggerRef },
    models: provider.catalog, modelCatalogRevision: provider.catalogRevision,
    capabilities: { ...CAPABILITY_MAP, active: [] }, capabilityCatalogRevision,
    budget: { remainingCalls, maxOutputBytes: LIMITS.outputBytes },
    previousProposal: previous ?? null, capabilityResult: capabilityResult ?? null,
    messages: [], concepts: [], sourceRefs: [triggerRef], inheritedSourceRefs: dependencyRefs,
    contextNotice: 'This is bounded short-term context, not all memory. Omitted records remain in long-term storage. Recall pages are scoped to this Person. A previous proposal is not committed state. Inherited source refs were read by an earlier call of this episode, not necessarily rendered here; recall again to check their content.',
  };
  const sourceRefs = new Set([triggerRef, ...dependencyRefs]);
  const renderedRefs = new Set([triggerRef]);
  const conceptMap = new Map();
  const sources = new Map([[triggerRef, { kind: 'trigger', reportedSourceRefs:
    ['send', 'think'].includes(episode.kind) && episode.text?.trim() ? [triggerRef] : [] }]]);
  const seenMessage = m => sources.set(messageRef(m), { kind: 'message', role: m.role, reportedSourceRefs: m.role === 'user' ? [messageRef(m)] : [] });
  const seenConcept = c => {
    conceptMap.set(c.id, c);
    sources.set(conceptRef(c), { kind: 'concept', epistemicState: c.epistemicState,
      reportedSourceRefs: c.epistemicState === 'reported' ? c.reportedSourceRefs ?? [] : [] });
  };
  const omitted = [];
  // A selected recall result is a full bounded page. Never silently shorten it after recording tool success.
  if (capabilityResult?.kind === 'messages') for (const m of capabilityResult.items) { sourceRefs.add(messageRef(m)); renderedRefs.add(messageRef(m)); seenMessage(m); }
  if (capabilityResult?.kind === 'concepts') for (const c of capabilityResult.items) { sourceRefs.add(conceptRef(c)); renderedRefs.add(conceptRef(c)); seenConcept(c); }
  context.sourceRefs = [...sourceRefs];
  const fits = () => bytes(system) + bytes(context) <= contextCap;
  if (!fits()) fail('CONTEXT_LIMIT');
  const omittedCapabilities = [];
  for (const contract of activeCapabilities) {
    context.capabilities.active.push(contract);
    if (bytes(context.capabilities.active) > CAPABILITY_LIMITS.activeBytes || !fits()) {
      context.capabilities.active.pop();
      if (contract.availability.layer === 'foundation') fail('CONTEXT_LIMIT');
      omittedCapabilities.push({ id: contract.id, reason: 'context-budget', inspect: 'catalog.view' });
    }
  }
  const add = (field, item, ref) => {
    if (renderedRefs.has(ref)) return;
    const inherited = sourceRefs.has(ref);
    context[field].push(item); if (!inherited) context.sourceRefs.push(ref);
    if (!fits()) { context[field].pop(); if (!inherited) context.sourceRefs.pop(); omitted.push({ ref, reason: 'context-budget' }); }
    else { sourceRefs.add(ref); renderedRefs.add(ref); if (field === 'concepts') seenConcept(item); else seenMessage(item); }
  };
  for (const m of [...snapshot.messages].reverse()) add('messages', m, messageRef(m));
  context.messages.reverse();
  for (const c of snapshot.concepts) add('concepts', c, conceptRef(c));
  return {
    activeCapabilities: context.capabilities.active, system, messages: [{ role: 'user', content: JSON.stringify(context) }], sourceRefs, concepts: conceptMap, sources,
    manifest: { stateVersion: snapshot.state.version, sourceRefs: [...sourceRefs], renderedSourceRefs: [...renderedRefs], inputDependencyRefs: [...sourceRefs], omitted,
      boundedRecentWindow: { messages: 12, recentConcepts: 12, focusedConcepts: 12 },
      contextBytes: bytes(system) + bytes(context), contextBudgetBytes: contextCap, outputTokensReserved: model.maxOutput,
      modelCatalogRevision: provider.catalogRevision, capabilityCatalogRevision,
      activeCapabilities: context.capabilities.active.map(({ id, version, revision, availability }) => ({ id, version, revision, ...availability })), omittedCapabilities }, maxTokens: model.maxOutput,
  };
}

export class PersonRuntime {
  constructor({ repository, getProvider, budget }) {
    this.repository = repository; this.getProvider = getProvider; this.budget = budget;
    this.running = new Map(); this.workerId = randomUUID(); this.closed = false;
  }
  start(episode) {
    if (this.closed) return;
    const controller = new AbortController();
    const job = { controller, episode, promise: null };
    this.running.set(episode.id, job);
    // Admission resolves independently of provider latency. No model work occurs without an explicit admission.
    job.promise = Promise.resolve().then(() => this.run(episode, controller)).catch(() => {}).finally(() => this.running.delete(episode.id));
  }
  cancel(episodeId, code = 'CANCELLED') { this.running.get(episodeId)?.controller.abort(new PersonError(code)); }
  async run(episode, controller) {
    const { signal } = controller;
    const timeout = setTimeout(() => controller.abort(new PersonError('TIMEOUT')), episode.budget.timeoutMs);
    timeout.unref?.();
    let heartbeatRunning = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatRunning || signal.aborted) return;
      heartbeatRunning = true;
      try { await this.repository.heartbeat(episode); }
      catch (error) { controller.abort(safeError(error)); }
      finally { heartbeatRunning = false; }
    }, Math.max(100, Math.floor(this.repository.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      const provider = await abortable(this.getProvider(), signal);
      const snapshot = await abortable(this.repository.context(episode), signal);
      let selection = { ...provider.defaultSelection, reason: 'configured-default', origin: 'bootstrap' };
      if (snapshot.state.lastSelection) {
        try { validateSelection(snapshot.state.lastSelection, provider.catalog); selection = { ...snapshot.state.lastSelection, reason: 'last-accepted-choice', origin: 'persisted' }; }
        catch { await this.repository.append(episode, 'selection_rejected', { requested: snapshot.state.lastSelection, code: 'MODEL_SELECTION', fallback: 'configured-default' }); }
      }
      const capabilities = new PersonCapabilities(this.repository, episode.ownerId, { experience: snapshot.capabilityExperience, triggerKind: episode.kind });
      let previous = null, capabilityResult = null, dependencyRefs = [];
      // Validation retains actual reads across calls, independently of the bounded rendered request.
      // Candidate proposals never enter this read-set or establish new provenance.
      const readConcepts = new Map(), readSources = new Map();
      for (let index = 0; index < episode.budget.calls; index++) {
        signal.throwIfAborted();
        const callId = randomUUID();
        const context = assembleContext({ snapshot, episode, provider, selection, previous, capabilityResult, dependencyRefs, remainingCalls: episode.budget.calls - index, activeCapabilities: capabilities.context() });
        capabilities.activate(context.activeCapabilities);
        dependencyRefs = context.manifest.inputDependencyRefs;
        for (const [id, concept] of context.concepts) readConcepts.set(id, concept);
        for (const [ref, source] of context.sources) readSources.set(ref, source);
        await this.repository.heartbeat(episode); // Revalidate distributed ownership before each dispatch.
        const requested = { model: selection.model, effort: selection.effort };
        const effective = { model: selection.model, effort: null, effortObserved: false };
        await this.repository.startCall(episode, {
          callId, callIndex: index, requested, effective, selectionOrigin: selection.origin, reason: selection.reason,
          manifest: context.manifest, request: { system: context.system, messages: context.messages, maxTokens: context.maxTokens, tools: [] },
          capability: previous?.next?.capability ?? null,
        });
        let output;
        try {
          signal.throwIfAborted();
          output = await collectOutput(provider.adapter, {
            model: selection.model, effort: selection.effort ?? undefined, effortSource: 'auto',
            system: context.system, messages: context.messages, maxTokens: context.maxTokens, signal,
          }, decision => { effective.effort = decision.effective; effective.effortObserved = true; effective.wireMode = decision.wireMode; });
        } catch (error) {
          const safe = safeError(error, 'PROVIDER_FAILED');
          await this.repository.finalizeCall(episode, { callId, effective, code: safe.code, output: error.partialOutput }).catch(() => {});
          throw safe;
        }
        // A narrow once-only finalizer can retain consumed output after cancellation, never state.
        // Complete public output remains durable even if proposal validation subsequently rejects it.
        if (!await this.repository.finalizeCall(episode, { callId, effective, output })) fail('STALE');
        signal.throwIfAborted();
        let proposal;
        try {
          try { proposal = JSON.parse(output.text); } catch { fail('INVALID_PROPOSAL'); }
          validateProposal(proposal, { stateVersion: episode.baseStateVersion, sourceRefs: context.sourceRefs, concepts: readConcepts, sources: readSources, catalog: provider.catalog, dream: episode.kind === 'dream' });
        } catch (error) {
          const safe = safeError(error, 'INVALID_PROPOSAL');
          await this.repository.append(episode, 'proposal_rejected', { callId, code: safe.code });
          throw safe;
        }
        await this.repository.append(episode, 'activity', { callId, activity: proposal.activity, decision: proposal.decision, disposition: proposal.next ? 'candidate' : 'proposed-commit' });
        if (!proposal.next) {
          signal.throwIfAborted();
          await this.repository.commit(episode, proposal, selection, callId, new Map(proposal.concepts.map(c => [c.id, c.epistemicState === 'reported' ? reportedLineage(c, readSources) : []])));
          return;
        }
        if (index + 1 >= episode.budget.calls) {
          await this.repository.finish(episode, 'budget_exhausted', 'CALL_BUDGET');
          return;
        }
        previous = proposal;
        selection = { model: proposal.next.model, effort: proposal.next.effort, reason: proposal.next.reason, origin: 'person' };
        capabilityResult = null;
        if (proposal.next.capability) {
          const invocation = proposal.next.capability;
          const manifest = capabilities.executionManifest(invocation.id);
          const execution = manifest ? { capabilityManifest: manifest } : {};
          await this.repository.append(episode, 'capability_started', { callId, capability: invocation, ...execution, access: 'read-only' });
          try {
            signal.throwIfAborted();
            capabilityResult = await abortable(capabilities.execute(invocation, { signal }), signal);
            await this.repository.append(episode, 'capability_result', { callId, capability: invocation, ...execution, result: capabilityResult });
          } catch (error) {
            const safe = safeError(error, 'UNSUPPORTED');
            await this.repository.append(episode, 'capability_failed', { callId, capabilityId: invocation.id, ...execution, code: safe.code }).catch(() => {});
            throw safe;
          }
        }
      }
    } catch (error) {
      const safe = safeError(signal.aborted ? signal.reason : error, 'PROVIDER_FAILED');
      const status = safe.code === 'CANCELLED' ? 'cancelled' : safe.code === 'INTERRUPTED' || safe.code === 'STALE' ? 'interrupted' : 'failed';
      // On authority failure no alternate memory store is used. Expired leases become durable interrupted records on next access.
      await this.repository.finish(episode, status, safe.code).catch(() => {});
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat);
      if (!signal.aborted) controller.abort(new PersonError('INTERRUPTED'));
    }
  }
  async close() {
    this.closed = true;
    const jobs = [...this.running.values()];
    for (const job of jobs) job.controller.abort(new PersonError('INTERRUPTED'));
    await Promise.all(jobs.map(job => job.promise));
  }
}
