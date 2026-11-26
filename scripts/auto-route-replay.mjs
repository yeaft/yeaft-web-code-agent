#!/usr/bin/env node
/**
 * auto-route-replay.mjs — Point-in-time historical replay benchmark for
 * Sessionless Session auto-routing (`decideSessionAutoRoute`).
 *
 * The source instance is opened strictly read-only. The script rebuilds an
 * isolated replay root under `--out` and, for every evaluation point (a real
 * user message, a real AskUser answer, or a scripted scenario), advances the
 * replay Session manifest and `discovery.db` to exactly the rows that existed
 * before that moment (zero future leakage), reconstructs the running Sessions and
 * pending AskUser prompts at that instant, then calls the production router.
 *
 * LLM calls are separated from the deterministic replay so it stays faithful
 * yet parallel:
 *   1. replay pass: every Decision prompt is answered from `<out>/llm-cache.jsonl`
 *      (keyed by model + prompts); uncached prompts are recorded;
 *   2. call pass: recorded prompts go to the real decision model in parallel;
 *   3. scoring pass: the replay runs again from the cache, so the production
 *      validation/post-processing path decides every route.
 * `--workers N` shards the replay across processes (each rebuilds its own
 * point-in-time index); answers whose recorded latency exceeds
 * `--llm-timeout-ms` are scored as the production timeout fallback.
 *
 * Usage:
 *   node scripts/auto-route-replay.mjs --source ~/.yeaft/instances/C1 --out <dir>
 *     [--since 2026-10-27] [--until 2026-11-26T02:40Z]   evaluation window (freeze live data)
 *     [--model Provider/model] [--effort high]           override the decision model/effort
 *     [--workers 6] [--concurrency 8]                    replay shards / parallel LLM calls
 *     [--scenarios <file.json>] [--only history|scenarios]
 *     [--no-fast-path] [--no-llm] [--keep-prompts] [--salt s1] [--label run] [--refresh-source]
 *
 * A scenario file is `{ "scenarios": [{ id, category, at, text, running?, replaceRunning?,
 * expect: { action?, sessionId?, anyOf?, answeredRequestId?, sceneId?, workDir? } }] }`;
 * `running` entries may add `liveMessages` and `pendingQuestions` to a Session.
 *
 * Everything under `--out` (source projection, cache, reports) contains private
 * transcript text: keep it local and never commit it.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentHistoryScan } from '../agent/yeaft/conversation/search.js';
import { isVisibleConversationRow } from '../agent/yeaft/conversation/internal-control.js';
import { resolveDecisionModel } from '../agent/yeaft/decision/index.js';
import { decideSessionAutoRoute } from '../agent/yeaft/session-discovery/auto-route.js';
import { extractIndexableTurnMessages } from '../agent/yeaft/session-discovery/indexer.js';
import { WORKSPACE_FOLDERS_FILE, WORKSPACE_FOLDERS_VERSION } from '../agent/yeaft/workspace-folders.js';
import {
  applyDailyIndexUpdates, openDiscoveryStore, readSourceFence,
} from '../agent/yeaft/session-discovery/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_REFRESH_MIN_TURNS = 2;
const NO_SIGNAL_RE = /^(?:hi|hello|hey|test|ping|你好|在吗|测试)[!！。.?？~\s]*$/iu;

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv) {
  const args = { concurrency: 6, llm: true, llmTimeoutMs: 12_000, only: 'all' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--source') args.source = next();
    else if (key === '--out') args.out = next();
    else if (key === '--since') args.since = Date.parse(next());
    else if (key === '--until') args.until = Date.parse(next());
    else if (key === '--model') args.model = next();
    else if (key === '--concurrency') args.concurrency = Math.max(1, Number(next()) || 6);
    else if (key === '--no-llm') args.llm = false;
    else if (key === '--scenarios') args.scenarios = next();
    else if (key === '--only') args.only = next();
    else if (key === '--llm-timeout-ms') args.llmTimeoutMs = Math.max(1000, Number(next()) || 12_000);
    else if (key === '--label') args.label = next();
    else if (key === '--workers') args.workers = Math.max(1, Number(next()) || 1);
    else if (key === '--shard') args.shard = next();
    else if (key === '--refresh-source') args.refreshSource = true;
    else if (key === '--no-fast-path') args.fastPath = false;
    else if (key === '--keep-prompts') args.keepPrompts = true;
    else if (key === '--effort') args.effort = next();
    else if (key === '--salt') args.salt = next();
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

const expandHome = p => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// ─────────────────────── Source instance (read-only) ───────────────────────

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function plainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n');
}

function rowTime(row) {
  const raw = row?.ts ?? row?.time;
  if (typeof raw === 'number') return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Keep only the fields the indexer / router projections read. */
function projectVisibleRow(row, time) {
  const text = plainText(row.content);
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    sessionId: row.sessionId,
    time: row.time,
    t: time,
    content: text,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.speakerVpId ? { speakerVpId: row.speakerVpId } : {}),
    ...(row.from ? { from: row.from } : {}),
    ...(row.responseKind ? { responseKind: row.responseKind } : {}),
    ...(row.stopReason ? { stopReason: row.stopReason } : {}),
    ...(row.incomplete ? { incomplete: true } : {}),
    ...(Array.isArray(row.toolCalls) && row.toolCalls.length ? { toolCalls: [{}] } : {}),
    ...(row.attachments?.length || row.images?.length || row.imageAssetIds?.length ? { attachments: [{}] } : {}),
    ...(row.userAuthored !== undefined ? { userAuthored: row.userAuthored } : {}),
    ...(row.relation ? { relation: row.relation } : {}),
    ...(row.userTurnId ? { userTurnId: row.userTurnId } : {}),
    ...(row.origin?.sessionId && row.origin.sessionId !== row.sessionId ? { inheritedFrom: row.origin.sessionId } : {}),
  };
}

function parseAskUserCall(call) {
  const input = call?.input || call?.arguments || {};
  const parsedInput = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return {}; } })() : input;
  if (Array.isArray(parsedInput?.questions) && parsedInput.questions.length) {
    const first = parsedInput.questions[0] || {};
    return {
      question: String(first.question || ''),
      options: Array.isArray(first.options) ? first.options.map(o => (typeof o === 'string' ? o : o?.label || '')).filter(Boolean) : [],
    };
  }
  return {
    question: String(parsedInput?.question || ''),
    options: Array.isArray(parsedInput?.options) ? parsedInput.options.map(o => (typeof o === 'string' ? o : o?.label || '')).filter(Boolean) : [],
  };
}

function parseAskUserAnswer(row) {
  let payload = null;
  try { payload = JSON.parse(plainText(row.content)); } catch { return ''; }
  const answers = payload?.answers;
  if (!answers || typeof answers !== 'object') return '';
  return Object.values(answers).map(v => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))).filter(Boolean).join('\n').trim();
}

export function loadSourceInstance(sourceDir) {
  const manifest = readJson(join(sourceDir, 'sessions-manifest.json'));
  if (!manifest || !Array.isArray(manifest.sessions)) throw new Error(`No sessions-manifest.json under ${sourceDir}`);
  const sessions = [];
  for (const entry of manifest.sessions) {
    const id = entry?.id;
    if (typeof id !== 'string') continue;
    const dir = join(sourceDir, 'sessions', id);
    const meta = readJson(join(dir, 'session.json'));
    if (!meta || meta.id !== id || meta.task) continue;
    const config = readJson(join(dir, 'config.json')) || {};
    const lineageRaw = existsSync(join(dir, 'conversation', 'lineage.json'))
      ? readFileSync(join(dir, 'conversation', 'lineage.json'), 'utf8')
      : '';
    const segDir = join(dir, 'conversation', 'segments');
    const files = existsSync(segDir)
      ? readdirSync(segDir).filter(f => /^\d+\.jsonl$/u.test(f)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
      : [];
    const visible = [];
    const turns = new Map();
    const askCalls = new Map();
    const askUsers = [];
    let legacyTurnKey = null;
    let legacyCounter = 0;
    for (const file of files) {
      const raw = readFileSync(join(segDir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let row;
        // Tool rows dominate transcript bytes; only their timing matters unless
        // they settle a pending AskUser call, so avoid a full JSON parse.
        if (line.startsWith('{"role":"tool"')) {
          const callId = /"toolCallId":"([^"]+)"/u.exec(line)?.[1];
          if (!callId || !askCalls.has(callId)) {
            row = {
              role: 'tool',
              sessionId: /"sessionId":"([^"]+)"/u.exec(line)?.[1],
              time: /"time":"([^"]+)"/u.exec(line)?.[1],
              userTurnId: /"userTurnId":"([^"]+)"/u.exec(line)?.[1],
            };
          }
        }
        if (!row) {
          try { row = JSON.parse(line); } catch { continue; }
        }
        if (row?.sessionId !== id) continue;
        const t = rowTime(row);
        if (!Number.isFinite(t)) continue;
        const isVisibleUser = row.role === 'user' && isVisibleConversationRow(row);
        // Turn intervals (for "running at t" reconstruction) use every row.
        let turnKey = typeof row.userTurnId === 'string' && row.userTurnId ? `u:${row.userTurnId}` : null;
        if (!turnKey) {
          if (isVisibleUser && row.relation !== 'supplement') legacyTurnKey = `legacy:${legacyCounter += 1}`;
          turnKey = legacyTurnKey;
        }
        if (turnKey) {
          const turn = turns.get(turnKey) || { start: Infinity, end: -Infinity };
          if (isVisibleUser) turn.start = Math.min(turn.start, t);
          turn.end = Math.max(turn.end, t);
          turns.set(turnKey, turn);
        }
        if (row.role === 'assistant' && Array.isArray(row.toolCalls)) {
          for (const call of row.toolCalls) {
            if (!/^askuser$/iu.test(String(call?.name || call?.function?.name || ''))) continue;
            const parsed = parseAskUserCall(call);
            if (call?.id && parsed.question) askCalls.set(call.id, { requestId: call.id, ...parsed, callTime: t });
          }
        }
        if (row.role === 'tool' && row.toolCallId && askCalls.has(row.toolCallId)) {
          const call = askCalls.get(row.toolCallId);
          askCalls.delete(row.toolCallId);
          askUsers.push({ ...call, resultTime: t, answer: parseAskUserAnswer(row), inherited: Boolean(row.origin?.sessionId && row.origin.sessionId !== id) });
        }
        if ((row.role === 'user' || row.role === 'assistant') && isVisibleConversationRow(row)) {
          visible.push(projectVisibleRow(row, t));
        }
      }
    }
    visible.sort((a, b) => a.seq - b.seq);
    const turnIntervals = [...turns.values()].filter(x => Number.isFinite(x.start) && x.end > x.start)
      .sort((a, b) => a.start - b.start);
    sessions.push({
      id,
      meta,
      sceneId: config.sceneId || '',
      lineageRaw,
      createdAtMs: Date.parse(meta.createdAt || '') || 0,
      rows: visible,
      times: visible.map(r => r.t),
      turnIntervals,
      askUsers,
      hasInherited: visible.some(r => r.inheritedFrom),
    });
  }
  return sessions;
}

// ─────────────────────────── Replay root ───────────────────────────

class ReplayWorld {
  constructor(rootDir, sessions, sourceDir) {
    this.root = rootDir;
    this.sessions = sessions;
    this.byId = new Map(sessions.map(s => [s.id, s]));
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(join(rootDir, 'sessions'), { recursive: true });
    // Reuse the source folder snapshot; never let the replay scan the local disk.
    const folders = join(sourceDir, WORKSPACE_FOLDERS_FILE);
    if (existsSync(folders)) copyFileSync(folders, join(rootDir, WORKSPACE_FOLDERS_FILE));
    else writeFileSync(join(rootDir, WORKSPACE_FOLDERS_FILE), JSON.stringify({ version: WORKSPACE_FOLDERS_VERSION, scannedAt: 0, roots: [], folders: [] }));
    this.existing = new Set();
    this.cursor = new Map();
    this.indexState = new Map();
    this.writeManifest();
    this.db = openDiscoveryStore(rootDir);
    this.read = createAgentHistoryScan(rootDir, {}).read;
  }

  close() { try { this.db?.close(); } catch { /* ignore */ } }

  writeManifest() {
    const sessions = [...this.existing].map(id => {
      const s = this.byId.get(id);
      return {
        id,
        name: s.meta.name || id,
        path: join(this.root, 'sessions', id),
        createdAt: s.meta.createdAt,
        workDir: s.meta.workDir || '',
        workspaceKey: s.meta.workspaceKey || '',
      };
    });
    writeFileSync(join(this.root, 'sessions-manifest.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), sessions }, null, 1));
  }

  materialize(s) {
    const dir = join(this.root, 'sessions', s.id);
    mkdirSync(join(dir, 'conversation', 'segments'), { recursive: true });
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ ...s.meta, metadataUpdatedAt: s.meta.createdAt }, null, 1));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(s.sceneId ? { sceneId: s.sceneId } : {}, null, 1));
    writeFileSync(join(dir, 'conversation', 'lineage.json'), s.lineageRaw || JSON.stringify({ version: 1, streamId: `replay-${s.id}` }));
    this.existing.add(s.id);
  }

  /** Advance manifest + discovery index to every row strictly before `t`. */
  advanceTo(t) {
    let manifestChanged = false;
    for (const s of this.sessions) {
      if (!this.existing.has(s.id) && s.createdAtMs && s.createdAtMs < t) {
        this.materialize(s);
        manifestChanged = true;
      }
    }
    if (manifestChanged) this.writeManifest();
    const upserts = [];
    const removed = [];
    for (const id of this.existing) {
      const s = this.byId.get(id);
      const prev = this.cursor.get(id) || 0;
      let next = prev;
      while (next < s.times.length && s.times[next] < t) next += 1;
      if (next === prev) continue;
      this.cursor.set(id, next);
      const prefix = s.rows.slice(0, next);
      const extracted = extractIndexableTurnMessages(prefix, id, t);
      const existing = this.indexState.get(id);
      if (extracted.visibleTurnCount < LIVE_REFRESH_MIN_TURNS || extracted.activeAt <= 0) {
        if (existing) { removed.push(id); this.indexState.delete(id); }
        continue;
      }
      const fence = readSourceFence(this.root, id, this.read);
      let mode = 'replace';
      let pruneFromSeq = null;
      let messages = extracted.messages;
      if (existing && existing.lastUserSeq !== null) {
        mode = 'append';
        pruneFromSeq = existing.lastUserSeq + 1;
        messages = extracted.messages.filter(m => m.seq >= pruneFromSeq);
      }
      const lastUser = [...extracted.messages].reverse().find(m => m.role === 'user');
      this.indexState.set(id, { lastUserSeq: lastUser ? lastUser.seq : null });
      upserts.push({
        mode,
        pruneFromSeq,
        sessionId: id,
        title: s.meta.name || id,
        workDir: s.meta.workDir || '',
        activeAt: extracted.activeAt,
        deletionGeneration: fence.key,
        freshAt: t,
        transcriptSignature: '',
        lastSeq: extracted.lastSeq,
        messageCount: extracted.visibleTurnCount,
        messages,
        candidates: [],
      });
    }
    if (upserts.length || removed.length) {
      applyDailyIndexUpdates(this.db, { upserts, removedSessionIds: removed, automatic: [], now: t, root: null, force: true, markIndexed: true });
    }
  }

  lastActivityBefore(id, t) {
    const s = this.byId.get(id);
    let last = 0;
    for (let i = 0; i < s.times.length && s.times[i] < t; i += 1) last = s.times[i];
    return last;
  }

  recentVisible(id, t, limit = 6, maxChars = 600) {
    const s = this.byId.get(id);
    const out = [];
    for (let i = s.rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const row = s.rows[i];
      if (row.t >= t) continue;
      const text = String(row.content || '').trim();
      if (!text) continue;
      out.push({ role: row.role, text: text.slice(0, maxChars), createdAt: row.t });
    }
    return out.reverse();
  }

  isRunning(id, t) {
    const s = this.byId.get(id);
    return s.turnIntervals.some(turn => turn.start < t && turn.end > t);
  }

  pendingAskUsers(id, t) {
    const s = this.byId.get(id);
    // The answer is persisted at `resultTime`, so the prompt is still pending at that instant.
    return s.askUsers.filter(a => a.callTime < t && a.resultTime >= t);
  }

  /** Live-collector equivalent (`collectLiveRunningSessionsForAutoRoute`) at `t`. */
  runningSessionsAt(t) {
    const out = [];
    for (const id of this.existing) {
      const pending = this.pendingAskUsers(id, t);
      if (!this.isRunning(id, t) && pending.length === 0) continue;
      const s = this.byId.get(id);
      out.push({
        sessionId: id,
        title: s.meta.name || id,
        sceneId: s.sceneId,
        workDir: s.meta.workDir || '',
        state: pending.length ? 'waiting_input' : 'running',
        ...(pending.length ? { pendingQuestions: pending.map(p => ({ requestId: p.requestId, question: p.question, options: p.options })) } : {}),
        recentMessages: this.recentVisible(id, t),
      });
    }
    return out;
  }
}

// ─────────────────────────── Evaluation points ───────────────────────────

function idleBucket(idleMin) {
  if (idleMin < 120) return 'continue-recent';
  if (idleMin < 24 * 60) return 'continue-idle';
  if (idleMin < 5 * 24 * 60) return 'continue-old';
  return 'beyond-window';
}

export function buildHistoryPoints(sessions, { since = -Infinity, until = Infinity } = {}) {
  const byKey = new Map();
  for (const s of sessions) {
    const ownUsers = s.rows.filter(r => r.role === 'user' && !r.inheritedFrom && r.t >= s.createdAtMs);
    ownUsers.forEach((row, idx) => {
      const key = `${row.t}|${row.content}`;
      const entry = byKey.get(key) || { t: row.t, text: row.content, owners: [], firstIn: [], supplement: false, hasAttachment: false };
      entry.owners.push(s.id);
      if (idx === 0) entry.firstIn.push(s.id);
      if (row.relation === 'supplement') entry.supplement = true;
      if (row.attachments) entry.hasAttachment = true;
      byKey.set(key, entry);
    });
  }
  const points = [];
  for (const entry of byKey.values()) {
    if (entry.t < since || entry.t >= until) continue;
    const text = String(entry.text || '').trim() || (entry.hasAttachment ? '(attached files)' : '');
    if (!text) continue;
    const truthId = entry.owners[0];
    const truth = sessions.find(s => s.id === truthId);
    const isFirst = entry.firstIn.includes(truthId);
    points.push({
      id: `msg:${truthId}:${entry.t}`,
      kind: 'history',
      t: entry.t,
      text,
      truthSessionIds: entry.owners,
      expect: isFirst && !truth.hasInherited ? 'create' : 'continue',
      copyBranch: isFirst && truth.hasInherited,
      supplement: entry.supplement,
    });
  }
  for (const s of sessions) {
    for (const ask of s.askUsers) {
      if (ask.inherited || !ask.answer || ask.resultTime < since || ask.resultTime >= until) continue;
      points.push({
        id: `ask:${s.id}:${ask.requestId}`,
        kind: 'askuser',
        t: ask.resultTime,
        text: ask.answer,
        truthSessionIds: [s.id],
        expect: 'continue',
        answeredRequestId: ask.requestId,
        optionAnswer: ask.options.some(o => o.trim() === ask.answer.trim()),
      });
    }
  }
  return points.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

export function loadScenarioPoints(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.scenarios;
  return list.map((sc, i) => {
    // `expect.anyOf` lists every acceptable outcome ("create" or Session ids).
    const anyOf = Array.isArray(sc.expect?.anyOf) ? sc.expect.anyOf : null;
    const ids = anyOf ? anyOf.filter(x => x !== 'create') : (sc.expect?.sessionId ? [].concat(sc.expect.sessionId) : []);
    const acceptCreate = anyOf ? anyOf.includes('create') : false;
    return { sc, i, ids, acceptCreate };
  }).map(({ sc, i, ids, acceptCreate }) => ({
    id: `scenario:${sc.id || i}`,
    kind: 'scenario',
    t: Date.parse(sc.at),
    text: sc.text,
    truthSessionIds: ids,
    acceptCreate,
    expect: sc.expect?.action || (ids.length ? 'continue' : 'create'),
    answeredRequestId: sc.expect?.answeredRequestId || null,
    expectSceneId: sc.expect?.sceneId || null,
    expectWorkDir: sc.expect?.workDir ?? null,
    category: sc.category || 'scenario',
    running: sc.running || null,
    replaceRunning: sc.replaceRunning === true,
    note: sc.note || '',
  })).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

// ─────────────────────────── LLM cache / adapters ───────────────────────────

function promptKey({ model, system, messages, maxTokens, effort = null }) {
  const user = (messages || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  return createHash('sha256').update(JSON.stringify(effort ? [model, system, user, maxTokens, effort] : [model, system, user, maxTokens])).digest('hex');
}

class LlmCache {
  constructor(file) {
    this.file = file;
    this.reload();
  }
  reload() {
    this.map = new Map();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const row = JSON.parse(line); this.map.set(row.key, row); } catch { /* ignore */ }
      }
    }
  }
  get(key) { return this.map.get(key) || null; }
  set(row) { this.map.set(row.key, row); appendFileSync(this.file, `${JSON.stringify(row)}\n`); }
}

function createCacheAdapter(cache, pending, { timeoutMs, effort = null, salt = null }) {
  return {
    lastRequest: null,
    lastResponse: null,
    async call(rawRequest) {
      const request = effort ? { ...rawRequest, effort } : rawRequest;
      this.lastRequest = request;
      // A salt draws fresh samples for identical prompts (variance checks).
      const key = salt ? `${promptKey(request)}#${salt}` : promptKey(request);
      const hit = cache.get(key);
      this.lastResponse = hit ? (hit.error ? `error:${hit.error}` : hit.text) : null;
      if (hit) {
        if (hit.error || hit.latencyMs > timeoutMs) return { text: '', usage: null };
        return { text: hit.text, usage: hit.usage || null };
      }
      if (!pending.has(key)) pending.set(key, { key, ...request, signal: undefined });
      return { text: '', usage: null };
    },
  };
}

async function runPendingCalls(pending, cache, { adapter, concurrency, timeoutMs, log }) {
  const queue = [...pending.values()];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const req = queue.shift();
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const started = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(timeoutMs * 3, 30_000));
        try {
          const res = await adapter.call({ model: req.model, system: req.system, messages: req.messages, maxTokens: req.maxTokens, ...(req.effort ? { effort: req.effort, effortSource: 'user' } : {}), signal: ctrl.signal });
          cache.set({ key: req.key, model: req.model, text: String(res?.text || ''), usage: res?.usage || null, latencyMs: Date.now() - started, at: new Date().toISOString() });
          break;
        } catch (err) {
          if (attempt >= 3) {
            cache.set({ key: req.key, model: req.model, text: '', error: String(err?.message || err).slice(0, 200), latencyMs: Date.now() - started, at: new Date().toISOString() });
            break;
          }
          await new Promise(r => setTimeout(r, 500 * attempt + Math.random() * 500));
        } finally {
          clearTimeout(timer);
        }
      }
      done += 1;
      if (done % 25 === 0) log(`  llm ${done}/${pending.size}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ─────────────────────────── Replay pass ───────────────────────────

function twinOf(world, a, b, t) {
  if (!a || !b || a === b) return false;
  const ra = world.recentVisible(a, t, 4, 400).map(m => `${m.role}:${m.text}`).join('\n');
  const rb = world.recentVisible(b, t, 4, 400).map(m => `${m.role}:${m.text}`).join('\n');
  return Boolean(ra) && ra === rb;
}

export async function replayPass({ sessions, sourceDir, outDir, points, adapter, config, collect, rootName = 'replay-root', fastPath = true, keepPrompts = false }) {
  const world = new ReplayWorld(join(outDir, rootName), sessions, sourceDir);
  const results = [];
  try {
    for (const point of points) {
      world.advanceTo(point.t);
      const allowed = [...world.existing];
      let running = world.runningSessionsAt(point.t);
      if (point.kind === 'scenario' && Array.isArray(point.running)) {
        const overrides = point.running.map(r => {
          const s = world.byId.get(r.sessionId);
          return {
            sessionId: r.sessionId,
            title: s?.meta?.name || r.sessionId,
            sceneId: s?.sceneId || '',
            workDir: s?.meta?.workDir || '',
            state: r.pendingQuestions?.length ? 'waiting_input' : 'running',
            ...(r.pendingQuestions?.length ? { pendingQuestions: r.pendingQuestions } : {}),
            recentMessages: [
              ...world.recentVisible(r.sessionId, point.t),
              ...(r.liveMessages || []).map(m => ({ role: m.role, text: m.text })),
            ].slice(-6),
          };
        });
        const overrideIds = new Set(overrides.map(o => o.sessionId));
        running = point.replaceRunning ? overrides : [...running.filter(r => !overrideIds.has(r.sessionId)), ...overrides];
      }
      if (adapter) { adapter.lastRequest = null; adapter.lastResponse = null; }
      const started = performance.now();
      const decision = await decideSessionAutoRoute({
        yeaftDir: world.root,
        agentWorkDir: '',
        text: point.text,
        allowedSessionIds: allowed,
        runningSessions: running,
        fastPath,
        adapter,
        config,
        now: point.t,
      });
      const elapsedMs = performance.now() - started;
      if (!collect) continue;
      const truth = point.truthSessionIds;
      const routedId = decision.action === 'create' ? null : decision.sessionId;
      let correct;
      if (point.expect === 'create') correct = decision.action === 'create';
      else correct = Boolean(routedId && truth.includes(routedId)) || (point.acceptCreate === true && decision.action === 'create');
      const answeredOk = point.answeredRequestId
        ? (decision.answeredQuestion?.requestId === point.answeredRequestId)
        : !decision.answeredQuestion;
      const truthId = truth[0] || null;
      const truthIdleMin = truthId && world.existing.has(truthId)
        ? Math.round((point.t - (world.lastActivityBefore(truthId, point.t) || 0)) / 60_000)
        : null;
      const runningIds = running.map(r => r.sessionId);
      let category = point.category || null;
      if (!category) {
        if (point.kind === 'askuser') category = point.optionAnswer ? 'askuser-option' : 'askuser-freetext';
        else if (point.copyBranch) category = 'copy-branch';
        else if (NO_SIGNAL_RE.test(point.text.trim())) category = 'no-signal';
        else if (point.expect === 'create') category = 'new-session';
        else if (truthId && runningIds.includes(truthId)) category = 'running-supplement';
        else category = idleBucket(truthIdleMin ?? Infinity);
      }
      let llmCandidateIds = null;
      if (adapter?.lastRequest) {
        try {
          const payload = JSON.parse(adapter.lastRequest.messages?.[0]?.content || '{}');
          if (Array.isArray(payload.candidates)) llmCandidateIds = payload.candidates.map(c => c.id);
        } catch { /* non-JSON prompt */ }
      }
      const recentActive = allowed.filter(id => {
        const last = world.lastActivityBefore(id, point.t);
        return last && point.t - last <= 30 * 60_000;
      }).length;
      results.push({
        id: point.id,
        kind: point.kind,
        category,
        at: new Date(point.t).toISOString(),
        text: point.text.slice(0, 300),
        expect: point.expect,
        truth,
        truthTitle: truthId ? (world.byId.get(truthId)?.meta?.name || truthId) : null,
        truthIdleMin,
        decision: {
          action: decision.action,
          sessionId: routedId,
          title: decision.title,
          tier: decision.tier,
          routeSource: decision.routeSource,
          fastPathRule: decision.fastPathRule || null,
          reason: decision.reason,
          confidence: decision.confidence ?? null,
          answeredRequestId: decision.answeredQuestion?.requestId || null,
          sceneId: decision.sceneId || null,
          workDir: decision.workDir || '',
        },
        correct,
        answeredOk,
        twinAcceptable: !correct && routedId && truthId ? twinOf(world, routedId, truthId, point.t) : false,
        sceneOk: point.expectSceneId ? decision.sceneId === point.expectSceneId : null,
        workDirOk: point.expectWorkDir !== null && point.expectWorkDir !== undefined
          ? (decision.workDir || '') === point.expectWorkDir : null,
        runningCount: runningIds.length,
        llmCandidateIds,
        llmRaw: adapter?.lastResponse ? String(adapter.lastResponse).slice(0, 400) : null,
        ...(keepPrompts && adapter?.lastRequest ? { llmPrompt: adapter.lastRequest.messages?.[0]?.content || '' } : {}),
        truthInLlmCandidates: llmCandidateIds && truthId ? llmCandidateIds.includes(truthId) : null,
        recentActive30m: recentActive,
        candidatePool: allowed.length,
        elapsedMs: Math.round(elapsedMs),
        note: point.note || '',
      });
    }
  } finally {
    world.close();
  }
  return results;
}

// ─────────────────────────── Reporting ───────────────────────────

// Reported but excluded from the headline: copied-Session branch points are twins by
// construction, beyond-window targets sit outside the router's 5-day design scope,
// and bare liveness pings ("hi") carry no routable intent.
const HEADLINE_EXCLUDED = new Set(['copy-branch', 'beyond-window', 'no-signal']);

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : null; }

export function summarize(results) {
  const byCat = {};
  for (const r of results) {
    const c = (byCat[r.category] ||= { n: 0, correct: 0, twin: 0, answeredOk: 0 });
    c.n += 1;
    if (r.correct) c.correct += 1;
    if (r.correct || r.twinAcceptable) c.twin += 1;
    if (r.correct && r.answeredOk) c.answeredOk += 1;
  }
  for (const c of Object.values(byCat)) {
    c.accuracy = pct(c.correct, c.n);
    c.accuracyTwinOk = pct(c.twin, c.n);
    c.strict = pct(c.answeredOk, c.n);
  }
  const headline = results.filter(r => !HEADLINE_EXCLUDED.has(r.category));
  const fast = results.filter(r => r.decision.routeSource === 'fast_path');
  const fastByRule = {};
  for (const r of fast) {
    const k = r.decision.fastPathRule || 'unknown';
    const x = (fastByRule[k] ||= { n: 0, correct: 0 });
    x.n += 1;
    if (r.correct) x.correct += 1;
  }
  const continueCases = headline.filter(r => r.expect === 'continue');
  const createCases = headline.filter(r => r.expect === 'create');
  return {
    total: results.length,
    headline: {
      n: headline.length,
      accuracy: pct(headline.filter(r => r.correct).length, headline.length),
      accuracyTwinOk: pct(headline.filter(r => r.correct || r.twinAcceptable).length, headline.length),
      strict: pct(headline.filter(r => r.correct && r.answeredOk).length, headline.length),
      falseCreates: continueCases.filter(r => r.decision.action === 'create').length,
      wrongSession: continueCases.filter(r => r.decision.action !== 'create' && !r.correct).length,
      falseMerges: createCases.filter(r => r.decision.action !== 'create').length,
    },
    byCategory: byCat,
    fastPath: {
      share: pct(fast.length, results.length),
      precision: pct(fast.filter(r => r.correct).length, fast.length),
      byRule: fastByRule,
    },
    routeSources: results.reduce((acc, r) => { acc[r.decision.routeSource || 'none'] = (acc[r.decision.routeSource || 'none'] || 0) + 1; return acc; }, {}),
  };
}

function printSummary(summary, log) {
  const h = summary.headline;
  log(`\nHeadline (${h.n} pts): accuracy ${h.accuracy}% | twin-ok ${h.accuracyTwinOk}% | strict(answeredRequestId) ${h.strict}%`);
  log(`  false creates ${h.falseCreates} | wrong session ${h.wrongSession} | false merges ${h.falseMerges}`);
  log(`Fast path: ${summary.fastPath.share}% of points, precision ${summary.fastPath.precision}%`);
  for (const [rule, x] of Object.entries(summary.fastPath.byRule)) log(`  ${rule}: ${x.correct}/${x.n}`);
  log('By category:');
  for (const [cat, c] of Object.entries(summary.byCategory).sort()) {
    log(`  ${cat.padEnd(20)} n=${String(c.n).padStart(4)}  acc=${c.accuracy}%  twin-ok=${c.accuracyTwinOk}%  strict=${c.strict}%`);
  }
  log(`Route sources: ${JSON.stringify(summary.routeSources)}`);
}

// ─────────────────────────── Main ───────────────────────────

function sourceSignature(sourceDir) {
  const manifest = readJson(join(sourceDir, 'sessions-manifest.json'));
  const parts = [];
  for (const entry of manifest?.sessions || []) {
    const segDir = join(sourceDir, 'sessions', String(entry?.id || ''), 'conversation', 'segments');
    if (!existsSync(segDir)) continue;
    for (const file of readdirSync(segDir).sort()) {
      try { const st = statSync(join(segDir, file)); parts.push(`${entry.id}/${file}:${st.size}:${Math.floor(st.mtimeMs)}`); } catch { /* ignore */ }
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Load (or reuse) the read-only source projection shared by every worker. */
function loadProjection(sourceDir, outDir, log, { refresh = false } = {}) {
  const file = join(outDir, 'source-projection.json');
  const cached = existsSync(file) ? readJson(file) : null;
  // Live instances keep appending; reuse the frozen projection unless asked to refresh.
  if (!refresh && Array.isArray(cached?.sessions)) return cached.sessions;
  const signature = sourceSignature(sourceDir);
  log(`Loading source instance ${sourceDir} (read-only)…`);
  const sessions = loadSourceInstance(sourceDir);
  writeFileSync(file, JSON.stringify({ signature, sessions }));
  return sessions;
}

function spawnShards(args, workers, label, log) {
  const script = fileURLToPath(import.meta.url);
  const baseArgs = process.argv.slice(2).filter((arg, i, all) => !(arg === '--workers' || all[i - 1] === '--workers'));
  return Promise.all(Array.from({ length: workers }, (_, shard) => new Promise((resolveShard, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', script, ...baseArgs, '--shard', `${shard}/${workers}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => (code === 0 ? resolveShard() : reject(new Error(`shard ${shard} failed (${code}): ${stderr.slice(-2000)}`))));
  }))).then(() => {
    const results = [];
    const pendingRows = [];
    for (let shard = 0; shard < workers; shard += 1) {
      const resFile = join(args.outDir, `${label}.shard-${shard}.jsonl`);
      const penFile = join(args.outDir, `${label}.pending-${shard}.jsonl`);
      for (const line of readFileSync(resFile, 'utf8').split('\n')) if (line) results.push(JSON.parse(line));
      if (existsSync(penFile)) for (const line of readFileSync(penFile, 'utf8').split('\n')) if (line) pendingRows.push(JSON.parse(line));
      rmSync(resFile, { force: true });
      rmSync(penFile, { force: true });
    }
    log(`  ${workers} shards finished`);
    return { results: results.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), pendingRows };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source || !args.out) {
    console.log('Usage: node scripts/auto-route-replay.mjs --source <yeaftDir> --out <dir> [--since ISO] [--until ISO] [--model M] [--concurrency N] [--workers N] [--no-llm] [--scenarios file] [--only history|scenarios] [--label name]');
    process.exit(args.help ? 0 : 1);
  }
  const sourceDir = resolve(expandHome(args.source));
  const outDir = resolve(expandHome(args.out));
  args.outDir = outDir;
  if (outDir.startsWith(sourceDir)) throw new Error('--out must be outside the source instance');
  mkdirSync(outDir, { recursive: true });
  const log = args.shard ? () => {} : msg => console.log(msg);
  const label = args.label || 'run';

  const sessions = loadProjection(sourceDir, outDir, log, { refresh: args.refreshSource === true && !args.shard });
  log(`  ${sessions.length} non-task Sessions, ${sessions.reduce((a, s) => a + s.rows.length, 0)} visible rows`);

  let points = [];
  if (args.only !== 'scenarios') points.push(...buildHistoryPoints(sessions, { since: args.since ?? -Infinity, until: args.until ?? Infinity }));
  if (args.scenarios && args.only !== 'history') points.push(...loadScenarioPoints(resolve(args.scenarios)));
  points = points.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  const sourceConfig = readJson(join(sourceDir, 'config.json')) || {};
  const config = { ...sourceConfig, providers: undefined, decisionModel: args.model || resolveDecisionModel(sourceConfig) };
  const cache = new LlmCache(join(outDir, 'llm-cache.jsonl'));
  const pending = new Map();
  const cacheAdapter = args.llm ? createCacheAdapter(cache, pending, { timeoutMs: args.llmTimeoutMs, effort: args.effort || null, salt: args.salt || null }) : null;

  if (args.shard) {
    // Worker: replay a deterministic slice against the cache only; the parent calls the LLM.
    const [index, total] = args.shard.split('/').map(Number);
    const slice = points.filter((_, i) => i % total === index);
    const shardResults = await replayPass({ sessions, sourceDir, outDir, points: slice, adapter: cacheAdapter, config, collect: true, rootName: `replay-root-${index}`, fastPath: args.fastPath !== false, keepPrompts: args.keepPrompts === true });
    writeFileSync(join(outDir, `${label}.shard-${index}.jsonl`), shardResults.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(outDir, `${label}.pending-${index}.jsonl`), [...pending.values()].map(p => JSON.stringify(p)).join('\n') + (pending.size ? '\n' : ''));
    return;
  }
  log(`  ${points.length} evaluation points (decision model ${config.decisionModel})`);

  const workers = Math.max(1, args.workers || 1);
  const runReplay = async () => {
    if (workers > 1) {
      const { results: merged, pendingRows } = await spawnShards(args, workers, label, log);
      for (const row of pendingRows) pending.set(row.key, row);
      return merged;
    }
    return replayPass({ sessions, sourceDir, outDir, points, adapter: cacheAdapter, config, collect: true, fastPath: args.fastPath !== false, keepPrompts: args.keepPrompts === true });
  };

  log('Replay pass…');
  let results = await runReplay();
  if (args.llm && pending.size) {
    log(`  ${pending.size} uncached Decision prompts; calling decision model…`);
    const { createLLMAdapter } = await import('../agent/yeaft/llm/adapter.js');
    const realAdapter = await createLLMAdapter({ providers: sourceConfig.providers, llmRetry: sourceConfig.llmRetry });
    await runPendingCalls(pending, cache, { adapter: realAdapter, concurrency: args.concurrency, timeoutMs: args.llmTimeoutMs, log });
    pending.clear();
    cache.reload();
    log('Scoring replay pass (cached LLM answers)…');
    results = await runReplay();
    if (pending.size) log(`  warning: ${pending.size} prompts still uncached (scored as fallback)`);
  }

  const summary = summarize(results);
  writeFileSync(join(outDir, `${label}-points.jsonl`), results.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(outDir, `${label}-report.json`), JSON.stringify({ generatedAt: new Date().toISOString(), model: config.decisionModel, summary }, null, 2));
  printSummary(summary, log);
  const latencies = results.map(r => r.elapsedMs).sort((a, b) => a - b);
  log(`Local routing latency (excl. LLM): p50 ${latencies[Math.floor(latencies.length * 0.5)] ?? 0} ms, p95 ${latencies[Math.floor(latencies.length * 0.95)] ?? 0} ms`);
  log(`Reports: ${join(outDir, `${label}-report.json`)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
