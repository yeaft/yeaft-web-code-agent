import { parentPort, workerData } from 'node:worker_threads';
import { runDailySessionIndex } from './indexer.js';

parentPort.postMessage(runDailySessionIndex(workerData.root));
