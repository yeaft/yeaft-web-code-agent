// Identifiers below are static application schema, never request-controlled SQL.
export const TABLES = Object.freeze({
  persons: { keys: [], columns: [] },
  states: { keys: [], columns: ['version'] },
  episodes: { keys: ['id'], columns: ['clientMessageId', 'inputWatermark', 'status', 'callFinalizeUntil'] },
  messages: { keys: ['id'], columns: ['seq', 'revision', 'text'] },
  concepts: { keys: ['id'], columns: ['revision', 'updatedAt', 'statement'] },
  concept_revisions: { keys: ['id', 'revision'], columns: [] },
  state_commits: { keys: ['version'], columns: ['id'] },
  traces: { keys: ['id'], columns: ['seq'] },
});

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS persons (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace, ownerId, personId)
) STRICT;
CREATE TABLE IF NOT EXISTS states (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  version INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
  PRIMARY KEY(namespace, ownerId, personId),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE TABLE IF NOT EXISTS episodes (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, clientMessageId TEXT NOT NULL, inputWatermark INTEGER NOT NULL,
  status TEXT NOT NULL, callFinalizeUntil INTEGER,
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace, ownerId, personId, id),
  UNIQUE(namespace, ownerId, personId, clientMessageId),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE INDEX IF NOT EXISTS episodes_watermark ON episodes(namespace, ownerId, personId, inputWatermark DESC);
CREATE INDEX IF NOT EXISTS episodes_drain ON episodes(namespace, ownerId, personId, status, callFinalizeUntil)
  WHERE json_type(record, '$.openCall') IS NOT NULL;
CREATE TABLE IF NOT EXISTS messages (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, seq INTEGER NOT NULL, revision INTEGER NOT NULL, text TEXT NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace, ownerId, personId, id),
  UNIQUE(namespace, ownerId, personId, seq),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_revision ON messages(namespace, ownerId, personId, id, revision);
CREATE TABLE IF NOT EXISTS concepts (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, revision INTEGER NOT NULL, updatedAt INTEGER NOT NULL, statement TEXT NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace, ownerId, personId, id),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS concepts_revision ON concepts(namespace, ownerId, personId, id, revision);
CREATE INDEX IF NOT EXISTS concepts_recent ON concepts(namespace, ownerId, personId, updatedAt DESC, id);
CREATE TABLE IF NOT EXISTS concept_revisions (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
  PRIMARY KEY(namespace, ownerId, personId, id, revision),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE TABLE IF NOT EXISTS state_commits (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  version INTEGER NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
  PRIMARY KEY(namespace, ownerId, personId, version),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE TABLE IF NOT EXISTS traces (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, seq INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
  PRIMARY KEY(namespace, ownerId, personId, id), UNIQUE(namespace, ownerId, personId, seq),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
-- This journal is authority data, not a disposable search index. A committed seq is
-- never reused, including after reopening; gaps between owners are intentional.
CREATE TABLE IF NOT EXISTS memory_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('messages', 'concepts')), id TEXT NOT NULL,
  revision INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
  UNIQUE(namespace, ownerId, personId, kind, id, revision),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE INDEX IF NOT EXISTS memory_changes_scope ON memory_changes(namespace, ownerId, personId, seq);
`;
