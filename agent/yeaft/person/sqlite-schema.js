// Identifiers below are static application schema, never request-controlled SQL.
export const TABLES = Object.freeze({
  persons: { keys: [], columns: [] },
  states: { keys: [], columns: ['version'] },
  episodes: { keys: ['id'], columns: ['clientMessageId', 'inputWatermark', 'status', 'callFinalizeUntil'] },
  attachments: { keys: ['id'], columns: [] },
  messages: { keys: ['id'], columns: ['seq', 'revision', 'text'] },
  concepts: { keys: ['id'], columns: ['revision', 'updatedAt', 'statement'] },
  concept_revisions: { keys: ['id', 'revision'], columns: [] },
  state_commits: { keys: ['version'], columns: ['id'] },
  traces: { keys: ['id'], columns: ['seq'] },
  created_capabilities: { keys: ['id'], columns: ['version'] },
  created_capability_revisions: { keys: ['id', 'version'], columns: [] },
});

export const SCHEMA = `
-- Additive migration: old schemaVersion/user_version=1 readers remain compatible.
-- Output bytes have exactly one authority, this instance SQLite database.
CREATE TABLE IF NOT EXISTS outputs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, episodeId TEXT NOT NULL, callId TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 10485760),
  record TEXT NOT NULL CHECK(json_valid(record)), data BLOB,
  UNIQUE(namespace, ownerId, personId, id),
  UNIQUE(namespace, ownerId, personId, episodeId, callId),
  FOREIGN KEY(namespace, ownerId, personId, episodeId) REFERENCES episodes(namespace, ownerId, personId, id),
  CHECK((json_extract(record, '$.kind') = 'file' AND data IS NOT NULL AND length(data) = size)
    OR (json_extract(record, '$.kind') = 'link' AND data IS NULL AND size = 0))
) STRICT;
CREATE INDEX IF NOT EXISTS outputs_recent ON outputs(namespace, ownerId, personId, seq DESC);

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
CREATE TABLE IF NOT EXISTS attachments (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
  PRIMARY KEY(namespace, ownerId, personId, id),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
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
CREATE INDEX IF NOT EXISTS traces_turn_metadata ON traces(namespace, ownerId, personId,
  json_extract(record, '$.episodeId'), seq);
CREATE INDEX IF NOT EXISTS traces_call_output ON traces(namespace, ownerId, personId,
  json_extract(record, '$.episodeId'), json_extract(record, '$.callId'))
  WHERE json_extract(record, '$.kind') = 'call_output';
CREATE TABLE IF NOT EXISTS created_capabilities (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 32),
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace, ownerId, personId, id),
  FOREIGN KEY(namespace, ownerId, personId) REFERENCES persons(namespace, ownerId, personId)
) STRICT;
CREATE TABLE IF NOT EXISTS created_capability_revisions (
  namespace TEXT NOT NULL, ownerId TEXT NOT NULL, personId TEXT NOT NULL,
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 32),
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(namespace, ownerId, personId, id, version),
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
