import { runDecision } from '../decision/runner.js';
import { boundedText } from '../decision/prompts/shared.js';
import { DAY_MS } from '../session-discovery/store.js';
import { knowledgeExtractScenario, knowledgeMergeScenario, screenKnowledgeText } from './prompts.js';

const LEASE_MS = 10 * 60_000;
const MAX_BATCH_BYTES = 24 * 1024;
const MAX_CANDIDATES_PER_MERGE = 6;
const RETRYABLE_OUTPUT = new Set(['invalid_json', 'invalid_decision', 'timeout', 'knowledge_sources_changed']);

function* chunkMessages(messages) {
  let current = [], size = 0;
  for (const row of messages) {
    // Screen before clipping so that recognizable secrets spanning lines are removed together.
    const text = screenKnowledgeText(row.text);
    const clipped = text.length <= 4_000 ? text : `${boundedText(text, 2_400)}\n[… omitted …]\n${text.slice(-1_600).toWellFormed()}`;
    const entry = { seq: row.seq, role: row.role, createdAt: row.createdAt, text: clipped };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (current.length && size + bytes > MAX_BATCH_BYTES) {
      yield current;
      current = [];
      size = 0;
    }
    current.push(entry);
    size += bytes;
  }
  if (current.length) yield current;
}

function workspaceScope(workDir) {
  const clean = typeof workDir === 'string' ? workDir.trim().replace(/\\/gu, '/').replace(/\/+$/u, '') : '';
  if (!clean) return '';
  return `workspace:${process.platform === 'win32' ? clean.toLowerCase() : clean}`;
}

function modelItem({ id, title, body, tags, scope, dimension }) {
  return { id, title, body, tags, dimension, scope: scope === 'agent' ? 'agent' : 'workspace' };
}

/** One job with two prompts; all database writes and transcript I/O are worker RPCs. */
export async function runDailySharedKnowledge({ slot, cutoff = Date.now(), clock = Date.now, openSource, openModel, signal }) {
  signal?.throwIfAborted();
  const worker = await openSource(signal);
  const rpc = (op, ...args) => worker.request(op, ...args);
  let lease, complete = false;
  const failures = new Set();
  const stats = { sessions: 0, messages: 0, notes: 0, modelCalls: 0 };
  const result = status => ({ status, ...stats, failedSessions: failures.size });
  try {
    const claim = await rpc('claim', { slot, now: clock(), bootstrapSince: cutoff - (5 * DAY_MS), leaseMs: LEASE_MS });
    if (claim.status !== 'claimed') return result(claim.status);
    ({ lease } = claim);
    let model = null;
    const heartbeat = async () => {
      signal?.throwIfAborted();
      if (!await rpc('renew', lease, clock() + LEASE_MS)) throw new Error('knowledge_lease_lost');
    };
    const decide = async (scenario, input) => {
      await heartbeat();
      model ||= await openModel(signal);
      stats.modelCalls += 1;
      const { result, meta } = await runDecision({ scenario, input, adapter: model.adapter, config: model.config,
        model: model.config?.primaryModel || model.config?.model, signal });
      signal?.throwIfAborted();
      if (meta.usedFallback) {
        const code = meta.fallbackReason?.startsWith('decision_error:') ? 'provider_error' : meta.fallbackReason;
        throw Object.assign(new Error('knowledge_model_failed'), { code });
      }
      return result;
    };

    let pending = [], candidateCount = 0;
    const commit = async units => {
      await heartbeat();
      const groups = new Map();
      for (const candidate of units.flatMap(unit => unit.candidates)) {
        const key = JSON.stringify([candidate.scope, candidate.dimension]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(candidate);
      }
      const actions = [];
      for (const group of groups.values()) {
        const candidates = group.map((item, i) => ({ ...item, id: `c${i + 1}` }));
        const existing = await rpc('predecessors', candidates);
        const decisions = await decide(knowledgeMergeScenario, {
          candidates: candidates.map(modelItem), existing: existing.map(modelItem),
        });
        const scope = candidates[0].scope;
        // The merge prompt sees all these sources. Keep all of them as
        // dependencies even on add/supersede: the model may copy older text.
        const sources = [...candidates, ...existing].flatMap(item => item.sources);
        actions.push(...decisions.map(decision => ({ ...decision, item: { ...decision.item, scope }, sources })));
      }
      const marks = new Map(units.map(unit => [unit.mark.sessionId, unit.mark]));
      signal?.throwIfAborted();
      if (!await rpc('commit', { lease, actions, watermarks: [...marks.values()], now: clock() })) {
        throw Object.assign(new Error('knowledge_sources_changed'), { code: 'knowledge_sources_changed' });
      }
      stats.notes += actions.length;
      stats.messages += units.reduce((n, unit) => n + unit.messageCount, 0);
    };
    const commitOrIsolate = async units => {
      const eligible = units.filter(unit => !failures.has(unit.mark.sessionId));
      if (!eligible.length) return;
      try {
        await commit(eligible);
      } catch (error) {
        signal?.throwIfAborted();
        if (!RETRYABLE_OUTPUT.has(error?.code)) throw error;
        if (eligible.length > 1) {
          const mid = Math.floor(eligible.length / 2);
          await commitOrIsolate(eligible.slice(0, mid));
          await commitOrIsolate(eligible.slice(mid));
        } else {
          failures.add(eligible[0].mark.sessionId);
        }
      }
    };
    const flush = async () => {
      if (!pending.length) return;
      const units = pending;
      pending = [];
      candidateCount = 0;
      await commitOrIsolate(units);
    };

    for (const sessionId of await rpc('list')) {
      await heartbeat();
      let input, watermark;
      try {
        watermark = await rpc('watermark', sessionId);
        input = await rpc('read', sessionId, { watermark, bootstrapSince: claim.bootstrapSince, cutoff });
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.code !== 'knowledge_source_incomplete') throw error;
        failures.add(sessionId);
        continue;
      }
      if (!input) continue;
      const mark = lastSeq => ({ sessionId, identity: input.identity, generation: input.generation, lastSeq });
      if (!input.messages.length) {
        if ((watermark || input.lastSeq >= 0) && (input.generation !== watermark?.generation || input.lastSeq !== watermark?.lastSeq)) {
          pending.push({ mark: mark(input.lastSeq), candidates: [], messageCount: 0 });
          if (pending.length >= 16) await flush();
        }
        continue;
      }
      stats.sessions += 1;
      const scope = workspaceScope(input.workDir);
      const messages = new Map(input.messages.map(row => [row.seq, row]));
      for (const chunk of chunkMessages(input.messages)) {
        if (failures.has(sessionId)) break;
        let items;
        try {
          items = await decide(knowledgeExtractScenario, { hasWorkspace: Boolean(scope), messages: chunk });
        } catch (error) {
          // Checkpoint earlier work, then leave this chunk for retry. A
          // provider-wide error backs off; a bad output doesn't starve others.
          signal?.throwIfAborted();
          await flush();
          if (!RETRYABLE_OUTPUT.has(error?.code)) throw error;
          failures.add(sessionId);
          break;
        }
        if (candidateCount + items.length > MAX_CANDIDATES_PER_MERGE) await flush();
        if (failures.has(sessionId)) break;
        const candidates = items.map(({ evidenceSeqs, ...item }) => ({ ...item, scope: item.scope === 'workspace' ? scope : 'agent',
          sources: evidenceSeqs.map(seq => ({ sessionId, seq, messageId: messages.get(seq).messageId, generation: input.generation,
            firstInputSeq: chunk[0].seq, lastInputSeq: chunk.at(-1).seq })) }));
        const lastSeq = chunk.at(-1).seq === input.messages.at(-1).seq ? input.lastSeq : chunk.at(-1).seq;
        pending.push({ mark: mark(lastSeq), candidates, messageCount: chunk.length });
        candidateCount += candidates.length;
        if (candidateCount >= MAX_CANDIDATES_PER_MERGE || pending.length >= 16) await flush();
      }
    }
    await flush();
    signal?.throwIfAborted();
    complete = failures.size === 0;
    return result(!complete ? 'partial' : stats.notes ? 'ok' : 'empty');
  } finally {
    try {
      // Critical writes are behind the lease. A crash/cancellation before
      // release is recovered by expiry, without committing any new cursor.
      if (lease && !signal?.aborted) await rpc('release', lease, complete ? slot : null);
    } finally {
      await worker.close();
    }
  }
}
