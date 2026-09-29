import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { CHUNK_SIZE, CHUNK_OVERLAP, MODEL_FINGERPRINT, VECTOR_DIMENSION } from './local-memory-embedding.js';

const { yeaftDir, namespace, embedding = {}, embeddingModule, maxVectorChunks, maxEmbedChunksPerRecall, candidateLimit } = workerData;
const fingerprint = embeddingModule ? `${MODEL_FINGERPRINT}:injected:${embeddingModule}:${embedding.fingerprint ?? 'test'}` : MODEL_FINGERPRINT;
let db;
let embedder;
let embeddingId = 0;
const embeddingRequests = new Map();
function hostEmbedding(texts, type) {
  return new Promise((resolve, reject) => {
    const id = ++embeddingId;
    embeddingRequests.set(id, { resolve, reject });
    parentPort.postMessage({ embeddingRequest: { id, texts, type } });
  });
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function tokens(text) {
  return [...segmenter.segment(text.normalize('NFKC').toLowerCase())].filter(s => s.isWordLike).map(s => s.segment);
}
function chunks(text) {
  const points = Array.from(text);
  const result = [];
  for (let start = 0; start < points.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    result.push(points.slice(start, start + CHUNK_SIZE).join(''));
    if (start + CHUNK_SIZE >= points.length) break;
  }
  return result;
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function open() {
  if (db) return;
  mkdirSync(path.join(yeaftDir, 'person'), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path.join(yeaftDir, 'person', 'recall.db'));
  try {
    // Some supported early Node 22 builds omit FTS5. Keep authority usable and
    // report an explicit literal-only fallback; never start a model on this path.
    db.exec('CREATE VIRTUAL TABLE temp.person_fts_probe USING fts5(terms); DROP TABLE temp.person_fts_probe;');
  } catch (error) {
    db.close(); db = null;
    if (/no such module: fts5/i.test(error.message)) error.code = 'FTS_UNAVAILABLE';
    throw error;
  }
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS spaces(namespace TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS checkpoints(namespace TEXT NOT NULL, owner TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(namespace,owner));
    CREATE TABLE IF NOT EXISTS chunks(
      rowid INTEGER PRIMARY KEY, namespace TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
      id TEXT NOT NULL, revision INTEGER NOT NULL, part INTEGER NOT NULL, seq INTEGER NOT NULL,
      text TEXT NOT NULL, terms TEXT NOT NULL, vector BLOB,
      UNIQUE(namespace,owner,kind,id,part));
    CREATE INDEX IF NOT EXISTS recall_scope ON chunks(namespace,owner,kind,seq DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(terms, content='chunks', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
      INSERT INTO chunk_fts(rowid,terms) VALUES (new.rowid,new.terms); END;
    CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
      INSERT INTO chunk_fts(chunk_fts,rowid,terms) VALUES ('delete',old.rowid,old.terms); END;`);
}
function ensureSpace() {
  transaction(() => {
    const previous = db.prepare('SELECT fingerprint FROM spaces WHERE namespace=?').get(namespace);
    if (!previous || previous.fingerprint !== fingerprint) {
      db.prepare('DELETE FROM chunks WHERE namespace=?').run(namespace);
      db.prepare('DELETE FROM checkpoints WHERE namespace=?').run(namespace);
      db.prepare('INSERT OR REPLACE INTO spaces VALUES (?,?)').run(namespace, fingerprint);
    }
  });
}
function checkpoint(owner) {
  return db.prepare('SELECT seq FROM checkpoints WHERE namespace=? AND owner=?').get(namespace, owner)?.seq ?? 0;
}
function assertSpace() {
  if (db.prepare('SELECT fingerprint FROM spaces WHERE namespace=?').get(namespace)?.fingerprint !== fingerprint) throw new Error('space_changed');
}
function apply(owner, items, lastSeq) {
  return transaction(() => {
    assertSpace();
    const before = checkpoint(owner);
    const remove = db.prepare('DELETE FROM chunks WHERE namespace=? AND owner=? AND kind=? AND id=?');
    const insert = db.prepare('INSERT INTO chunks(namespace,owner,kind,id,revision,part,seq,text,terms) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const item of items) {
      if (item.seq <= before) continue;
      if (!['messages', 'concepts'].includes(item.kind) || !Number.isSafeInteger(item.seq) || !Number.isSafeInteger(item.revision) || typeof item.id !== 'string') throw new Error('invalid_journal');
      remove.run(namespace, owner, item.kind, item.id);
      if (item.record) {
        const text = item.kind === 'messages' ? item.record.text : item.record.statement;
        if (typeof text !== 'string') throw new Error('invalid_record');
        for (const [part, chunk] of chunks(text).entries()) insert.run(namespace, owner, item.kind, item.id, item.revision, part, item.seq, chunk, tokens(chunk).join(' '));
      }
    }
    if (!Number.isSafeInteger(lastSeq) || lastSeq < before || items.some(item => item.seq > lastSeq)) throw new Error('invalid_checkpoint');
    db.prepare('INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(namespace,owner) DO UPDATE SET seq=excluded.seq').run(namespace, owner, lastSeq);
    return { checkpoint: lastSeq };
  });
}
function vector(value) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== VECTOR_DIMENSION || !Array.from(value).every(Number.isFinite)) throw new Error('invalid_embedding');
  const norm = Math.sqrt(Array.from(value).reduce((sum, n) => sum + n * n, 0));
  if (!norm) throw new Error('invalid_embedding');
  return Float32Array.from(value, n => n / norm);
}
function encode(v) {
  const blob = Buffer.alloc(VECTOR_DIMENSION * 4);
  v.forEach((n, i) => blob.writeFloatLE(n, i * 4));
  return blob;
}
async function embed(texts, type) {
  // Trusted deterministic fixtures run in this thread. Production inference runs
  // in its disposable host process to avoid ONNX addon thread reload failures.
  if (embeddingModule && !embedder) {
    const module = await import(embeddingModule);
    embedder = module.createEmbedding({ ...embedding, yeaftDir });
  }
  const results = embedder ? await embedder.embed(texts, type) : await hostEmbedding(texts, type);
  if (!Array.isArray(results) || results.length !== texts.length) throw new Error('invalid_embedding');
  return results.map(vector);
}
async function search(owner, kind, query) {
  const reasons = [];
  // Read space identity and vectors in one transaction, including when multiple
  // local controllers use the same DB. Never accept vectors from an ABA space switch.
  const { totalChunks, eligible } = transaction(() => {
    assertSpace();
    const totalChunks = db.prepare('SELECT count(*) AS n FROM chunks WHERE namespace=? AND owner=? AND kind=?').get(namespace, owner, kind).n;
    // Exact cosine is deliberately bounded to the newest N chunks. FTS covers all indexed text.
    const eligible = db.prepare('SELECT rowid,id,revision,seq,text,vector FROM chunks WHERE namespace=? AND owner=? AND kind=? ORDER BY seq DESC,id,part LIMIT ?').all(namespace, owner, kind, maxVectorChunks);
    return { totalChunks, eligible };
  });
  let queryVector;
  if (embedding.enabled !== false) {
    try {
      queryVector = (await embed([query], 'query'))[0];
      const pending = eligible.filter(row => !row.vector).slice(0, maxEmbedChunksPerRecall);
      for (let start = 0; start < pending.length; start += 8) {
        const batch = pending.slice(start, start + 8);
        const values = await embed(batch.map(row => row.text), 'passage');
        transaction(() => {
          assertSpace();
          const update = db.prepare('UPDATE chunks SET vector=? WHERE rowid=? AND namespace=? AND owner=? AND kind=? AND id=? AND revision=? AND seq=?');
          batch.forEach((row, i) => {
            row.vector = encode(values[i]);
            update.run(row.vector, row.rowid, namespace, owner, kind, row.id, row.revision, row.seq);
          });
        });
      }
    } catch {
      queryVector = null;
      reasons.push('embedding_unavailable');
      // The controller replaces this process after delivering keyword results:
      // ONNX itself can cache a rejected native-session initialization promise.
    }
  } else reasons.push('semantic_disabled');
  assertSpace();
  const terms = [...new Set(tokens(query))].slice(0, 32).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
  // Group before limiting parents: many matching chunks must not crowd out a
  // shorter record. MATERIALIZED keeps FTS5 bm25 in its supported row context.
  const keyword = terms ? db.prepare(`WITH matches AS MATERIALIZED (
    SELECT c.id,c.revision,bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks c ON c.rowid=chunk_fts.rowid
    WHERE chunk_fts MATCH ? AND c.namespace=? AND c.owner=? AND c.kind=?)
    SELECT id,revision,min(rank) AS rank FROM matches GROUP BY id,revision ORDER BY rank,id LIMIT ?`).all(terms, namespace, owner, kind, candidateLimit) : [];
  let vectorScannedChunks = 0;
  const semantic = [];
  if (queryVector) for (const row of eligible) {
    if (!row.vector || row.vector.length !== VECTOR_DIMENSION * 4) continue;
    const bytes = Buffer.from(row.vector);
    let cosine = 0;
    for (let i = 0; i < VECTOR_DIMENSION; i++) cosine += queryVector[i] * bytes.readFloatLE(i * 4);
    vectorScannedChunks++;
    if (Number.isFinite(cosine)) semantic.push({ id: row.id, revision: row.revision, cosine });
  }
  semantic.sort((a, b) => b.cosine - a.cosine || a.id.localeCompare(b.id));
  const ranks = new Map();
  // Deduplicate each channel BEFORE RRF: a verbose record does not receive more votes.
  for (const channel of [keyword, semantic]) {
    const seen = new Set();
    for (const ref of channel) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const current = ranks.get(ref.id) ?? { id: ref.id, revision: ref.revision, score: 0 };
      current.score += 1 / (60 + seen.size);
      ranks.set(ref.id, current);
      if (seen.size >= candidateLimit) break;
    }
  }
  const refs = [...ranks.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, candidateLimit).map(({ id, revision }) => ({ id, revision }));
  const semanticUsed = Boolean(queryVector && vectorScannedChunks);
  if (queryVector && vectorScannedChunks < totalChunks) reasons.push('semantic_coverage_limited');
  return { refs, resetWorker: reasons.includes('embedding_unavailable'), retrieval: {
    mode: semanticUsed ? 'hybrid' : 'keyword', semantic: semanticUsed, degraded: reasons.some(r => r !== 'semantic_disabled'), reasons,
    fingerprint, ranking: 'rrf-60', bounded: true, candidateLimit,
    coverage: { totalChunks, vectorEligibleChunks: eligible.length, vectorScannedChunks, maxVectorChunks, maxEmbedChunksPerRecall },
  } };
}
async function dispatch({ op, owner, ...args }) {
  if (op === 'close') { await embedder?.close?.(); db?.close(); db = null; return null; }
  if (typeof owner !== 'string' || !owner.length) throw new Error('invalid_owner');
  open();
  if (op === 'checkpoint') { ensureSpace(); return checkpoint(owner); }
  assertSpace();
  if (op === 'apply') return apply(owner, args.items, args.lastSeq);
  if (op === 'search') return search(owner, args.kind, args.query);
  throw new Error('invalid_operation');
}
// The controller issues one RPC at a time; serialize defensively inside the worker too.
let chain = Promise.resolve();
parentPort.on('message', message => {
  // Results must bypass the serialized RPC chain, whose search is awaiting them.
  if (message.embeddingResult) {
    const { id, value, error } = message.embeddingResult;
    const pending = embeddingRequests.get(id);
    embeddingRequests.delete(id);
    if (error) pending?.reject(new Error('embedding_unavailable'));
    else pending?.resolve(value);
    return;
  }
  chain = chain.then(async () => {
    try {
      const value = await dispatch(message);
      if (message.op === 'close') { parentPort.postMessage({ closed: true }); return; }
      parentPort.postMessage({ id: message.id, value });
    } catch (error) { parentPort.postMessage({ id: message.id, error: { code: error.code || 'INDEX_FAILURE' } }); }
  });
});
