import { parentPort, workerData } from 'node:worker_threads';
import { PersonError } from './contracts.js';
import { SqlitePersonStore } from './sqlite-store.js';

// The protocol exposes logical repository operations, never SQL or callbacks.
let store;
try {
  store = new SqlitePersonStore(workerData);
  parentPort.postMessage({ ready: true });
} catch {
  parentPort.postMessage({ startupError: 'STORAGE_UNAVAILABLE' });
  parentPort.close();
}
if (store) parentPort.on('message', ({ id, method, args }) => {
  try {
    if (method === 'close') {
      store.close(); parentPort.postMessage({ id, result: null }); parentPort.close(); return;
    }
    parentPort.postMessage({ id, result: store.execute(method, args) });
  } catch (error) {
    // SQLite errors include filesystem paths, SQL and possibly user data. Never cross
    // the worker boundary with their message/stack; typed application errors are safe.
    parentPort.postMessage({ id, error: error instanceof PersonError ? error.code : 'STORAGE_UNAVAILABLE' });
  }
});
