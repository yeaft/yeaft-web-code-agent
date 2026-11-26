import { parentPort, workerData } from 'node:worker_threads';
import { listDigestSessions, readDigestSource } from './source.js';
import {
  claimKnowledgeJob, commitKnowledgeBatch, createKnowledgeSourceCheck, findKnowledgePredecessors,
  openKnowledgeWriter, readKnowledgeWatermark, releaseKnowledgeJob, renewKnowledgeJob,
} from './store.js';

const { root } = workerData;
let db;
parentPort.on('message', ({ op, args }) => {
  try {
    let data;
    switch (op) {
      case 'list': data = listDigestSessions(root); break;
      case 'read': data = readDigestSource(root, ...args); break;
      case 'claim': data = claimKnowledgeJob(db ||= openKnowledgeWriter(root), ...args); break;
      case 'renew': data = renewKnowledgeJob(db, ...args); break;
      case 'watermark': data = readKnowledgeWatermark(db, ...args); break;
      case 'predecessors': data = findKnowledgePredecessors(db, args[0], createKnowledgeSourceCheck(root)); break;
      case 'commit': data = commitKnowledgeBatch(db, { root, ...args[0] }); break;
      case 'release': data = releaseKnowledgeJob(db, ...args); break;
      case 'close': db?.close(); db = null; break;
      default: throw new Error('Unsupported knowledge worker operation');
    }
    parentPort.postMessage({ data });
  } catch {
    // Errors can contain paths or transcript fragments. Leave the cursor
    // untouched and send only a fixed category to the live Agent.
    parentPort.postMessage({ error: op === 'read' ? 'knowledge_source_incomplete' : 'knowledge_worker_failed' });
  }
});
