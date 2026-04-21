/**
 * user-memory.test.js — task-334h R6 §Δ29 user-memory skeleton.
 *
 * Locks the wire shape that task-334l must honour when it replaces the
 * placeholder with real ingestion.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleUnifyUserMemoryWrite,
  handleUnifyUserMemoryRemove,
  setUserMemorySender,
} from '../../../agent/unify/user-memory.js';

describe('handleUnifyUserMemoryWrite', () => {
  it('acks `deferred` + pending:true for a valid text payload', () => {
    const sent = [];
    handleUnifyUserMemoryWrite({ text: 'remember: ship friday', requestId: 'r1' }, (e) => sent.push(e));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'user_memory_updated',
      reason: 'deferred',
      pending: true,
      requestId: 'r1',
    });
  });

  it('acks `noop` + pending:false for an empty text', () => {
    const sent = [];
    handleUnifyUserMemoryWrite({ text: '' }, (e) => sent.push(e));
    expect(sent[0]).toEqual({
      type: 'user_memory_updated',
      reason: 'noop',
      pending: false,
    });
  });

  it('no-ops silently when no sender configured and none provided', () => {
    setUserMemorySender(null);
    expect(() => handleUnifyUserMemoryWrite({ text: 'x' })).not.toThrow();
  });

  it('uses the module-level sender when installed via setUserMemorySender', () => {
    const sink = vi.fn();
    setUserMemorySender(sink);
    handleUnifyUserMemoryWrite({ text: 'x' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].type).toBe('user_memory_updated');
    setUserMemorySender(null);
  });

  it('never throws on a misbehaving sender', () => {
    const boom = () => { throw new Error('socket'); };
    expect(() => handleUnifyUserMemoryWrite({ text: 'hi' }, boom)).not.toThrow();
  });
});

describe('handleUnifyUserMemoryRemove', () => {
  it('emits user_memory_removed with entryId passthrough', () => {
    const sent = [];
    handleUnifyUserMemoryRemove({ entryId: 'e1', requestId: 'r2' }, (e) => sent.push(e));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'user_memory_removed',
      entryId: 'e1',
      pending: true,
      requestId: 'r2',
    });
  });

  it('tolerates missing entryId (null in payload)', () => {
    const sent = [];
    handleUnifyUserMemoryRemove({}, (e) => sent.push(e));
    expect(sent[0]).toMatchObject({ type: 'user_memory_removed', entryId: null });
  });

  it('never throws on a misbehaving sender', () => {
    const boom = () => { throw new Error('socket'); };
    expect(() => handleUnifyUserMemoryRemove({ entryId: 'e1' }, boom)).not.toThrow();
  });
});
