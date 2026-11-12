import { describe, expect, it, vi } from 'vitest';
import { createVpStatusBroker } from '../../../agent/yeaft/vp-status-broker.js';

function fixture() {
  let time = 1000;
  const send = vi.fn();
  const broker = createVpStatusBroker({ send, now: () => ++time });
  const owner = { sessionId: 's', vpId: 'v', threadId: 'failed', turnId: 'failed-turn', state: 'error' };
  return { broker, send, owner };
}

describe('VP error status replay', () => {
  it('keeps failure identity through sibling completion, scoped replay and recovery', () => {
    const { broker, send, owner } = fixture();
    const errorDetail = { message: 'Provider request failed', code: 'request_failed' };
    broker.transition({ ...owner, errorDetail });
    broker.transition({ ...owner, sessionId: 'other', errorDetail: { message: 'Other Session failure' } });
    broker.transition({ ...owner, vpId: 'other-vp', errorDetail: { message: 'Other VP failure' } });
    broker.transition({ ...owner, threadId: 'parallel', turnId: 'parallel-turn', state: 'thinking' });
    let status = broker.snapshot('s').find(row => row.vpId === 'v');
    expect(status).toMatchObject({ state: 'thinking', runningThreadCount: 1 });
    expect(status).not.toHaveProperty('errorDetail');
    expect(status.threads.find(row => row.threadId === 'failed')).toMatchObject({ state: 'error', turnId: 'failed-turn', errorDetail });
    broker.settleIdle({ sessionId: 's', vpId: 'v', threadId: 'parallel' });
    broker.broadcastSnapshot({ sessionId: 's' });
    status = send.mock.lastCall[0].statuses.find(row => row.vpId === 'v');
    expect(send.mock.lastCall[0].statuses).toHaveLength(2);
    expect(status).toMatchObject({ state: 'error', turnId: 'failed-turn', threadId: 'failed', runningThreadCount: 0, errorDetail });
    expect(JSON.stringify(send.mock.lastCall[0])).not.toContain('Other Session failure');
    // Recovering one thread does not clear unrelated failed owners.
    broker.transition({ ...owner, state: 'typing', turnId: 'next-turn' });
    status = broker.snapshot('s').find(row => row.vpId === 'v');
    expect(status).not.toHaveProperty('errorDetail');
    expect(status.threads.every(row => !row.errorDetail)).toBe(true);
    broker.settleIdle(owner);
    expect(broker.snapshot('s').find(row => row.vpId === 'v').state).toBe('idle');
    expect(broker.snapshot('other')[0].errorDetail.message).toBe('Other Session failure');
    // Concurrent failures can share the same millisecond; select the last
    // actual transition rather than Map insertion order, even after idle work.
    const concurrent = createVpStatusBroker({ send: vi.fn(), now: () => 1000 });
    concurrent.transition({ ...owner, errorDetail });
    concurrent.transition({ ...owner, threadId: 'newer-failure', turnId: 'newer-turn', errorDetail: { message: 'Newer error' } });
    concurrent.settleIdle({ sessionId: 's', vpId: 'v', threadId: 'idle-sibling' });
    expect(concurrent.snapshot('s')[0]).toMatchObject({ state: 'error', threadId: 'newer-failure',
      turnId: 'newer-turn', errorDetail: { message: 'Newer error' } });
  });

  it('bounds and allowlists scalar details without retaining raw errors or mutable references', () => {
    const { broker, send, owner } = fixture();
    const errorDetail = {
      message: 'm'.repeat(3000), code: 'c'.repeat(200), reason: 'r'.repeat(200), errorName: 'e'.repeat(200),
      reasonCode: 'x'.repeat(200), provider: 'p'.repeat(200), model: 'y'.repeat(300),
      retryable: false, retryExhausted: true, credentialRefreshable: false, retryAttempts: 2, maxRetries: 3, statusCode: 422,
      stack: 'PRIVATE', cause: { message: 'PRIVATE' }, request: { secret: 'PRIVATE' }, response: 'PRIVATE', raw: 'PRIVATE',
    };
    broker.transition({ ...owner, errorDetail });
    const detail = broker.snapshot('s')[0].errorDetail;
    expect(detail).toEqual({ message: 'm'.repeat(2000), code: 'c'.repeat(128), reason: 'r'.repeat(128),
      errorName: 'e'.repeat(128), reasonCode: 'x'.repeat(128), provider: 'p'.repeat(128), model: 'y'.repeat(256),
      retryable: false, retryExhausted: true, credentialRefreshable: false, retryAttempts: 2, maxRetries: 3, statusCode: 422 });
    expect(JSON.stringify(send.mock.lastCall)).not.toContain('PRIVATE');
    errorDetail.message = 'mutated input';
    detail.message = 'mutated snapshot';
    send.mock.lastCall[0].threads[0].errorDetail.message = 'mutated wire';
    expect(broker.snapshot('s')[0].errorDetail.message).toBe('m'.repeat(2000));
    broker.transition({ ...owner, errorDetail: { message: {}, code: ['PRIVATE'], reason: { raw: 'PRIVATE' },
      retryAttempts: -1, maxRetries: Infinity, retryable: 'yes', statusCode: 999, model: '' } });
    expect(broker.snapshot('s')[0]).not.toHaveProperty('errorDetail');
    expect(broker.snapshot('s')[0].threads[0]).not.toHaveProperty('errorDetail');
  });

  it('deduplicates normalized diagnostics but emits corrected details and never carries an old turn failure forward', () => {
    const { broker, send, owner } = fixture();
    expect(broker.transition(owner)).toBe(true);
    expect(broker.transition({ ...owner, errorDetail: { message: 'Failed', code: 'failure', stack: 'PRIVATE' } })).toBe(true);
    const count = send.mock.calls.length;
    expect(broker.transition({ ...owner, errorDetail: { code: 'failure', message: 'Failed', response: 'DIFFERENT PRIVATE' } })).toBe(false);
    expect(broker.transition(owner)).toBe(false);
    expect(send).toHaveBeenCalledTimes(count);
    expect(broker.transition({ ...owner, errorDetail: { message: 'Corrected failure', code: 'failure' } })).toBe(true);
    expect(broker.transition({ ...owner, messageCount: 5 })).toBe(true);
    expect(broker.snapshot('s')[0].threads[0]).toMatchObject({ messageCount: 5, errorDetail: { message: 'Corrected failure' } });
    expect(broker.transition({ ...owner, turnId: 'new-failed-turn' })).toBe(true);
    expect(broker.snapshot('s')[0]).not.toHaveProperty('errorDetail');
    broker.transition({ ...owner, errorDetail: { message: 'Failed again' } });
    broker.settleIdle(owner);
    expect(broker.snapshot('s')[0].threads[0]).not.toHaveProperty('errorDetail');
    broker.forget(owner);
    expect(broker.snapshot('s')).toEqual([]);
  });
});
