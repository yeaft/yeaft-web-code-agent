import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A lock-only SQLite file: no tables, writes, WAL, or stale PID reclamation.
// Keep the file in place: replacing it would let contenders lock different inodes.
function tryAcquire(sessionDir, filename, statement) {
  const db = new DatabaseSync(join(sessionDir, filename));
  try {
    db.exec(statement);
  } catch (error) {
    db.close();
    // SQLite reports extended result codes; the low byte is SQLITE_BUSY (5).
    if (error?.code === 'ERR_SQLITE_ERROR' && (error.errcode & 255) === 5) return null;
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    db.close(); // Ends the transaction; process exit also releases the lock.
  };
}

const TURN_FENCE = '.turn-fence.sqlite';

/** Shared admission for a native CLI turn, or null while deletion owns the Session. */
export function tryAcquireSessionTurn(sessionDir) {
  // BEGIN is deferred; the read is required to actually acquire a shared lock.
  return tryAcquire(sessionDir, TURN_FENCE, 'BEGIN; PRAGMA user_version;');
}

/**
 * Exclusive admission for planning and committing a turn deletion, or null while busy.
 * This is cooperative: older processes do not take the lock. Commit the logical
 * deletion online, but do not physically rewrite transcript or coordinator segments
 * unless all writers have been stopped (including older processes).
 */
export function tryAcquireSessionTurnDeletion(sessionDir) {
  return tryAcquire(sessionDir, TURN_FENCE, 'BEGIN EXCLUSIVE;');
}

/** Serialize short coordinator log mutations independently of turn admission. */
export function withCoordinatorLogLock(sessionDir, callback) {
  const release = tryAcquire(sessionDir, '.coordinator-log-lock.sqlite', 'PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE;');
  if (!release) throw new Error('Coordinator log is busy');
  try {
    return callback();
  } finally {
    release();
  }
}
