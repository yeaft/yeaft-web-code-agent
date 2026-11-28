import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let db;
export const PRIVATE_EXCERPT_VERSION = 5;
export function resolveCosmicWebDbPath(env = process.env) {
  if (env.COSMIC_WEB_DB_PATH) return env.COSMIC_WEB_DB_PATH;
  if (env.SERVER_DATA_DIR) return join(env.SERVER_DATA_DIR, 'cosmic-web.db');
  if (env.TEST_DB_PATH) return env.TEST_DB_PATH === ':memory:' ? ':memory:' : `${env.TEST_DB_PATH}.cosmic-web.db`;
  return join(env.TEST_DB_DIR || fileURLToPath(new URL('../../data/', import.meta.url)), 'cosmic-web.db');
}

export function openCosmicWebDb(customPath = resolveCosmicWebDbPath()) {
  if (db) {
    if (arguments.length && customPath !== dbPath) throw new Error('Cosmic Web database is already open');
    return db;
  }
  if (customPath !== ':memory:') mkdirSync(dirname(customPath), { recursive: true });
  const conn = new DatabaseSync(customPath);
  try {
    conn.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS cw_sources (
        id TEXT PRIMARY KEY, owner_user_id TEXT CHECK(owner_user_id <> ''),
        scope TEXT GENERATED ALWAYS AS (coalesce(owner_user_id, '')) STORED,
        domain_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, last_attempt_at INTEGER, last_success_at INTEGER, last_error TEXT,
        UNIQUE(id, scope)
      );
      CREATE INDEX IF NOT EXISTS cw_sources_owner ON cw_sources(owner_user_id, enabled);
      CREATE TABLE IF NOT EXISTS cw_clusters (
        id TEXT PRIMARY KEY, owner_user_id TEXT CHECK(owner_user_id <> ''),
        scope TEXT GENERATED ALWAYS AS (coalesce(owner_user_id, '')) STORED,
        headline TEXT NOT NULL, summary_excerpt TEXT NOT NULL, keywords_json TEXT NOT NULL,
        published_at INTEGER NOT NULL, excerpt_version INTEGER NOT NULL DEFAULT 0, UNIQUE(id, scope)
      );
      CREATE INDEX IF NOT EXISTS cw_clusters_recent ON cw_clusters(owner_user_id, published_at);
      CREATE TABLE IF NOT EXISTS cw_items (
        id TEXT PRIMARY KEY, owner_user_id TEXT CHECK(owner_user_id <> ''),
        scope TEXT GENERATED ALWAYS AS (coalesce(owner_user_id, '')) STORED,
        cluster_id TEXT NOT NULL, source_id TEXT NOT NULL, domain_id TEXT NOT NULL,
        url TEXT NOT NULL, title TEXT NOT NULL, summary_excerpt TEXT NOT NULL,
        published_at INTEGER NOT NULL, has_hot_metric INTEGER NOT NULL, media_json TEXT NOT NULL DEFAULT '[]', source_name_override TEXT,
        excerpt_version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_id, url),
        FOREIGN KEY(cluster_id, scope) REFERENCES cw_clusters(id, scope) ON DELETE CASCADE,
        FOREIGN KEY(source_id, scope) REFERENCES cw_sources(id, scope) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS cw_items_cluster ON cw_items(cluster_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS cw_items_scope_url ON cw_items(scope, url);
      CREATE TABLE IF NOT EXISTS cw_user_prefs (
        user_id TEXT PRIMARY KEY, prefs_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cw_user_cluster_state (
        user_id TEXT NOT NULL, cluster_id TEXT NOT NULL REFERENCES cw_clusters(id) ON DELETE CASCADE,
        unread INTEGER NOT NULL, bookmarked INTEGER NOT NULL, muted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, cluster_id)
      );
      CREATE INDEX IF NOT EXISTS cw_bookmarked ON cw_user_cluster_state(cluster_id) WHERE bookmarked = 1;
      CREATE TABLE IF NOT EXISTS cw_article_cache (
        item_id TEXT PRIMARY KEY REFERENCES cw_items(id) ON DELETE CASCADE,
        value_json TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cw_enrichment_cache (
        cluster_id TEXT PRIMARY KEY REFERENCES cw_clusters(id) ON DELETE CASCADE,
        value_json TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cw_ai_cache (
        user_id TEXT NOT NULL, cache_key TEXT NOT NULL, value_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, cache_key)
      );
    `);
    conn.exec('BEGIN IMMEDIATE');
    const clusterColumns = new Set(conn.prepare('PRAGMA table_info(cw_clusters)').all().map(column => column.name));
    if (!clusterColumns.has('excerpt_version')) {
      conn.exec('ALTER TABLE cw_clusters ADD COLUMN excerpt_version INTEGER NOT NULL DEFAULT 0');
    }
    const itemColumns = new Set(conn.prepare('PRAGMA table_info(cw_items)').all().map(column => column.name));
    if (!itemColumns.has('media_json')) {
      conn.exec("ALTER TABLE cw_items ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!itemColumns.has('source_name_override')) conn.exec('ALTER TABLE cw_items ADD COLUMN source_name_override TEXT');
    if (!itemColumns.has('excerpt_version')) {
      conn.exec('ALTER TABLE cw_items ADD COLUMN excerpt_version INTEGER NOT NULL DEFAULT 0');
    }
    conn.exec('COMMIT');
  } catch (err) { conn.close(); throw err; }
  db = conn;
  dbPath = customPath;
  return db;
}
let dbPath;
export function getCosmicWebDb() { return db ?? openCosmicWebDb(); }
export function closeCosmicWebDb() { db?.close(); db = undefined; dbPath = undefined; }
export function resetCosmicWebDbForTest(customPath = ':memory:') { closeCosmicWebDb(); return openCosmicWebDb(customPath); }

const sql = text => getCosmicWebDb().prepare(text);
const parse = row => row ? JSON.parse(row.value_json) : null;
const visible = '(owner_user_id IS NULL OR owner_user_id = ?)';
export function cosmicWebTransaction(fn) {
  const conn = getCosmicWebDb();
  conn.exec('BEGIN IMMEDIATE');
  try { const result = fn(); conn.exec('COMMIT'); return result; }
  catch (err) { conn.exec('ROLLBACK'); throw err; }
}

export function purgeUserCosmicWebData(userId) {
  if (!userId) throw new Error('Expected Cosmic Web user');
  return cosmicWebTransaction(() => {
    for (const table of ['cw_user_prefs', 'cw_user_cluster_state', 'cw_ai_cache']) {
      sql(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    }
    // Article cache is scoped by item, not user; private entries cascade from cw_items.
    for (const table of ['cw_items', 'cw_clusters', 'cw_sources']) {
      sql(`DELETE FROM ${table} WHERE owner_user_id=?`).run(userId);
    }
  });
}

export function upsertSource(source) {
  sql(`INSERT INTO cw_sources(id, owner_user_id, domain_id, name, url, kind) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=1
    WHERE cw_sources.scope=excluded.scope AND cw_sources.url=excluded.url AND cw_sources.domain_id=excluded.domain_id`)
    .run(source.id, source.ownerUserId ?? null, source.domainId, source.name, source.url, source.kind);
}
export function listSources(ownerUserId = null) {
  return sql('SELECT * FROM cw_sources WHERE owner_user_id IS ? AND enabled=1 ORDER BY id').all(ownerUserId);
}
export function listActivePrivateSources() {
  return sql('SELECT * FROM cw_sources WHERE owner_user_id IS NOT NULL AND enabled=1 ORDER BY id').all();
}
export function getSource(id, ownerUserId = null) {
  return sql('SELECT * FROM cw_sources WHERE id=? AND owner_user_id IS ? AND enabled=1').get(id, ownerUserId);
}
export function deactivateSources(userId) {
  if (!userId) throw new Error('Expected source owner');
  sql('UPDATE cw_sources SET enabled=0 WHERE owner_user_id=?').run(userId);
}
export function activateRadarSource(source) {
  sql("UPDATE cw_sources SET enabled=1, name=? WHERE id=? AND owner_user_id=? AND kind='radar'")
    .run(source.name, source.id, source.ownerUserId);
}
export function disableRadarSource(id, userId) {
  sql("UPDATE cw_sources SET enabled=0 WHERE id=? AND owner_user_id=? AND kind='radar'").run(id, userId);
}
export function recordSourceRefresh(id, ownerUserId, now, error = null) {
  sql(`UPDATE cw_sources SET last_attempt_at=?, last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
    last_error=? WHERE id=? AND owner_user_id IS ? AND enabled=1`).run(now, error, now, error, id, ownerUserId);
}

export function listRecentClusters(ownerUserId, since) {
  return sql('SELECT * FROM cw_clusters WHERE owner_user_id IS ? AND published_at>=? ORDER BY published_at DESC, id').all(ownerUserId, since);
}
export function findItemBySourceUrl(sourceId, ownerUserId, url) {
  return sql('SELECT * FROM cw_items WHERE source_id=? AND owner_user_id IS ? AND url=?').get(sourceId, ownerUserId, url);
}
export function findRecentClusterByUrl(ownerUserId, url, since, until) {
  return sql(`SELECT c.* FROM cw_clusters c JOIN cw_items i ON i.cluster_id=c.id
    WHERE i.scope=coalesce(?, '') AND i.url=? AND c.published_at BETWEEN ? AND ? ORDER BY c.published_at DESC, c.id LIMIT 1`)
    .get(ownerUserId, url, since, until);
}
export function upsertCluster(cluster) {
  const excerptVersion = Number.isInteger(cluster.excerptVersion) ? cluster.excerptVersion : 0;
  sql(`INSERT INTO cw_clusters(id, owner_user_id, headline, summary_excerpt, keywords_json, published_at, excerpt_version) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET published_at=max(cw_clusters.published_at, excluded.published_at),
      summary_excerpt=CASE
        WHEN excluded.excerpt_version > cw_clusters.excerpt_version THEN excluded.summary_excerpt
        WHEN excluded.excerpt_version = cw_clusters.excerpt_version AND cw_clusters.summary_excerpt='' THEN excluded.summary_excerpt
        ELSE cw_clusters.summary_excerpt
      END,
      excerpt_version=max(cw_clusters.excerpt_version, excluded.excerpt_version)
    WHERE cw_clusters.scope=excluded.scope`)
    .run(cluster.id, cluster.ownerUserId ?? null, cluster.headline, cluster.summaryExcerpt, JSON.stringify(cluster.keywords), cluster.publishedAt, excerptVersion);
}
export function insertItem(item) {
  const excerptVersion = Number.isInteger(item.excerptVersion) ? item.excerptVersion : 0;
  return sql(`INSERT INTO cw_items(id, owner_user_id, cluster_id, source_id, domain_id, url, title, summary_excerpt, published_at, has_hot_metric, media_json, source_name_override, excerpt_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, url) DO NOTHING`)
    .run(item.id, item.ownerUserId ?? null, item.clusterId, item.sourceId, item.domainId, item.url, item.title,
      item.summaryExcerpt, item.publishedAt, Number(!!item.hasHotMetric), JSON.stringify((item.media ?? []).slice(0, 3)), item.sourceName || null, excerptVersion).changes;
}
export function upgradePrivateExcerpt(itemId, clusterId, ownerUserId, summaryExcerpt, excerptVersion) {
  if (!ownerUserId || !itemId || !clusterId || !Number.isInteger(excerptVersion)) return 0;
  const changes = sql('UPDATE cw_items SET summary_excerpt=?, excerpt_version=? WHERE id=? AND owner_user_id=? AND excerpt_version<?')
    .run(summaryExcerpt, excerptVersion, itemId, ownerUserId, excerptVersion).changes;
  sql('UPDATE cw_clusters SET summary_excerpt=?, excerpt_version=? WHERE id=? AND owner_user_id=? AND excerpt_version<?')
    .run(summaryExcerpt, excerptVersion, clusterId, ownerUserId, excerptVersion);
  return changes;
}
export function backfillItemMedia(sourceId, ownerUserId, url, media) {
  if (!Array.isArray(media) || !media.length) return 0;
  return sql("UPDATE cw_items SET media_json=? WHERE source_id=? AND owner_user_id IS ? AND url=? AND media_json='[]'")
    .run(JSON.stringify(media.slice(0, 3)), sourceId, ownerUserId ?? null, url).changes;
}
export function listSourcesForUserDomain(userId, domainId) {
  if (!userId || !domainId) return [];
  return sql('SELECT * FROM cw_sources WHERE owner_user_id=? AND domain_id=? ORDER BY id').all(userId, domainId);
}
export function listPersistedUserDomainIds(userId) {
  if (!userId) return [];
  return sql(`SELECT domain_id FROM cw_sources WHERE owner_user_id=?
    UNION SELECT domain_id FROM cw_items WHERE owner_user_id=?`)
    .all(userId, userId)
    .map(row => row.domain_id)
    .filter(Boolean);
}
export function remapUserSource({ userId, oldSourceId, newSourceId, newDomainId }) {
  if (!userId || !oldSourceId || !newSourceId || !newDomainId) return;
  if (oldSourceId === newSourceId) {
    sql('UPDATE cw_sources SET domain_id=? WHERE owner_user_id=? AND id=?').run(newDomainId, userId, oldSourceId);
    sql('UPDATE cw_items SET domain_id=? WHERE owner_user_id=? AND source_id=?').run(newDomainId, userId, oldSourceId);
    return;
  }
  const row = sql('SELECT * FROM cw_sources WHERE id=? AND owner_user_id=?').get(oldSourceId, userId);
  if (!row) return;
  sql(`INSERT INTO cw_sources(id, owner_user_id, domain_id, name, url, kind, enabled, last_attempt_at, last_success_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET domain_id=excluded.domain_id, name=excluded.name`)
    .run(newSourceId, userId, newDomainId, row.name, row.url, row.kind, row.enabled, row.last_attempt_at, row.last_success_at, row.last_error);
  // Defensive dedupe: drop overlapping (source_id, url) rows on old source before repointing so UNIQUE never throws.
  sql(`DELETE FROM cw_items WHERE owner_user_id=? AND source_id=?
    AND url IN (SELECT url FROM cw_items WHERE owner_user_id=? AND source_id=?)`)
    .run(userId, oldSourceId, userId, newSourceId);
  sql('UPDATE cw_items SET source_id=?, domain_id=? WHERE owner_user_id=? AND source_id=?').run(newSourceId, newDomainId, userId, oldSourceId);
  sql('DELETE FROM cw_sources WHERE id=? AND owner_user_id=?').run(oldSourceId, userId);
}
export function migrateCustomDomainId(userId, oldId, newId) {
  if (!userId || !oldId || !newId || oldId === newId) return;
  sql('UPDATE cw_sources SET domain_id=? WHERE owner_user_id=? AND domain_id=?').run(newId, userId, oldId);
  sql('UPDATE cw_items SET domain_id=? WHERE owner_user_id=? AND domain_id=?').run(newId, userId, oldId);
}
export function listVisibleClusters(userId, clusterId) {
  return clusterId === undefined ? sql(`SELECT * FROM cw_clusters WHERE ${visible}`).all(userId) :
    sql(`SELECT * FROM cw_clusters WHERE id=? AND ${visible}`).all(clusterId, userId);
}
export function listVisibleItems(userId, clusterIds) {
  if (!clusterIds.length) return [];
  return sql(`SELECT i.*, coalesce(i.source_name_override, s.name) AS source_name, s.kind AS source_kind FROM cw_items i JOIN cw_sources s ON s.id=i.source_id
    WHERE (i.owner_user_id IS NULL OR i.owner_user_id=?) AND i.cluster_id IN (SELECT value FROM json_each(?))
    ORDER BY i.published_at DESC, i.id`).all(userId, JSON.stringify(clusterIds));
}

export function loadUserPrefs(userId) {
  return parse(sql('SELECT prefs_json AS value_json FROM cw_user_prefs WHERE user_id=?').get(userId));
}
export function saveUserPrefs(userId, prefs, now = Date.now()) {
  sql(`INSERT INTO cw_user_prefs VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    prefs_json=excluded.prefs_json, updated_at=excluded.updated_at`).run(userId, JSON.stringify(prefs), now);
}
export function listUserClusterStates(userId) {
  return new Map(sql('SELECT cluster_id, unread, bookmarked, muted FROM cw_user_cluster_state WHERE user_id=?').all(userId)
    .map(r => [r.cluster_id, { unread: !!r.unread, bookmarked: !!r.bookmarked, muted: !!r.muted }]));
}
export function saveUserClusterState(userId, clusterId, patch, now = Date.now()) {
  const unread = patch.unread == null ? null : Number(patch.unread);
  const bookmarked = patch.bookmarked == null ? null : Number(patch.bookmarked);
  const muted = patch.muted == null ? null : Number(patch.muted);
  sql(`INSERT INTO cw_user_cluster_state(user_id, cluster_id, unread, bookmarked, muted, updated_at)
    SELECT ?, id, coalesce(?, 1), coalesce(?, 0), coalesce(?, 0), ? FROM cw_clusters WHERE id=? AND ${visible}
    ON CONFLICT(user_id, cluster_id) DO UPDATE SET unread=coalesce(?, unread), bookmarked=coalesce(?, bookmarked), muted=coalesce(?, muted), updated_at=excluded.updated_at`)
    .run(userId, unread, bookmarked, muted, now, clusterId, userId, unread, bookmarked, muted);
  const row = sql('SELECT unread, bookmarked, muted FROM cw_user_cluster_state WHERE user_id=? AND cluster_id=?').get(userId, clusterId);
  return row ? { unread: !!row.unread, bookmarked: !!row.bookmarked, muted: !!row.muted } : null;
}

export function getArticleCache(userId, itemId, now = Date.now()) {
  return parse(sql(`SELECT a.value_json FROM cw_article_cache a JOIN cw_items i ON i.id=a.item_id
    WHERE a.item_id=? AND a.expires_at>? AND (i.owner_user_id IS NULL OR i.owner_user_id=?)`).get(itemId, now, userId));
}
export function setArticleCache(userId, itemId, value, expiresAt) {
  sql(`INSERT INTO cw_article_cache SELECT id, ?, ? FROM cw_items WHERE id=? AND ${visible}
    ON CONFLICT(item_id) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at`)
    .run(JSON.stringify(value), expiresAt, itemId, userId);
}
export function getAiCache(userId, key, now = Date.now()) {
  return parse(sql('SELECT value_json FROM cw_ai_cache WHERE user_id=? AND cache_key=? AND expires_at>?').get(userId, key, now));
}
export function setAiCache(userId, key, value, expiresAt) {
  sql(`INSERT INTO cw_ai_cache VALUES (?, ?, ?, ?) ON CONFLICT(user_id, cache_key) DO UPDATE SET
    value_json=excluded.value_json, expires_at=excluded.expires_at`).run(userId, key, JSON.stringify(value), expiresAt);
}

// Call after resolving the visible cluster. Private cluster IDs never share cache entries.
export function getEnrichmentCache(clusterId, now = Date.now()) {
  return parse(sql('SELECT value_json FROM cw_enrichment_cache WHERE cluster_id=? AND expires_at>?').get(clusterId, now));
}
export function setEnrichmentCache(clusterId, value, expiresAt = Date.now() + 2 * 60 * 60_000) {
  sql(`INSERT INTO cw_enrichment_cache SELECT id, ?, ? FROM cw_clusters WHERE id=?
    ON CONFLICT(cluster_id) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at`)
    .run(JSON.stringify(value), expiresAt, clusterId);
}

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export function pruneCosmicWebDb(now = Date.now()) {
  return cosmicWebTransaction(() => {
    const cutoff = now - RETENTION_MS;
    const held = 'SELECT 1 FROM cw_user_cluster_state b WHERE b.cluster_id=cw_items.cluster_id AND b.bookmarked=1';
    const items = sql(`DELETE FROM cw_items WHERE published_at<? AND NOT EXISTS (${held})`).run(cutoff).changes;
    const clusters = sql(`DELETE FROM cw_clusters WHERE published_at<? AND NOT EXISTS
      (SELECT 1 FROM cw_items i WHERE i.cluster_id=cw_clusters.id) AND NOT EXISTS
      (SELECT 1 FROM cw_user_cluster_state b WHERE b.cluster_id=cw_clusters.id AND b.bookmarked=1)`).run(cutoff).changes;
    const articles = sql('DELETE FROM cw_article_cache WHERE expires_at<=?').run(now).changes;
    const enrichment = sql('DELETE FROM cw_enrichment_cache WHERE expires_at<=?').run(now).changes;
    const ai = sql('DELETE FROM cw_ai_cache WHERE expires_at<=?').run(now).changes;
    sql('DELETE FROM cw_sources WHERE enabled=0 AND NOT EXISTS (SELECT 1 FROM cw_items i WHERE i.source_id=cw_sources.id)').run();
    return { items, clusters, articles, ai, enrichment };
  });
}
