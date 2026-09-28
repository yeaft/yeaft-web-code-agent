import { pathToFileURL } from 'node:url';
import { MongoPersonRepository } from '../../../../agent/yeaft/person/repository.js';

// Isolated child process used only by the replica-set integration suite.
const driver = process.env.PERSON_TEST_MONGO_DRIVER ? pathToFileURL(process.env.PERSON_TEST_MONGO_DRIVER).href : 'mongodb';
const { MongoClient } = await import(driver);
const repository = new MongoPersonRepository({ uri: process.env.PERSON_TEST_MONGO_URI, dbName: process.env.PERSON_TEST_DB,
  namespace: 'processes', MongoClient, leaseMs: 10000 });
try {
  await repository.open('alice');
  process.send({ ready: true });
  await new Promise(resolve => process.once('message', resolve));
  const result = await repository.admit('alice', { kind: 'send', text: 'cross-process message', clientMessageId: 'same-input',
    workerId: `process-${process.pid}`, budget: { calls: 1, timeoutMs: 1000 } });
  process.send({ episodeId: result.episodeId, duplicate: result.duplicate });
} catch (error) {
  process.send({ error: error.code || 'TEST_PROCESS_FAILED' });
} finally {
  await repository.close();
  process.disconnect();
}
