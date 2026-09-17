import { randomUUID } from 'node:crypto';

/**
 * Run synchronous database work atomically, including inside a caller-owned
 * transaction. SAVEPOINT works without DatabaseSync.isTransaction (Node 22.5).
 * Releasing an outermost savepoint commits; nested releases never commit the
 * caller's transaction. Unlike BEGIN IMMEDIATE, the write lock is acquired on
 * the first write, so callbacks must not rely on holding it before then.
 */
export function withTransaction(db, fn) {
  const savepoint = `wc_${randomUUID().replaceAll('-', '')}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch {}
    throw error;
  }
}
