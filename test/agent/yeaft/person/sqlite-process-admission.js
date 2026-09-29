import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

// Runs only against the integration suite's temporary directory.
const repository = new SqlitePersonRepository({ yeaftDir: process.env.PERSON_SQLITE_TEST_DIR, namespace: 'processes', leaseMs: 10000 });
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
