import { describe, expect, it } from 'vitest';
import { QueryProgress } from '../../../agent/yeaft/query-progress.js';
import webFetchTool from '../../../agent/yeaft/tools/web-fetch.js';

function observe(progress, name, output, extra = {}) {
  progress.observe({ call: { id: 'c', name, input: { path: 'rfc' } }, output, readOnly: true, ...extra });
  return progress.finishBatch();
}

describe('query-local progress evidence', () => {
  it('escalates repeated exact results across tool batches, not assistant promises', () => {
    const progress = new QueryProgress();
    expect(observe(progress, 'FileRead', 'same document')).toBeNull();
    const actions = [];
    for (let i = 0; i < 12; i++) {
      progress.observe({ call: { id: `c${i}`, name: 'FileRead', input: { path: 'rfc' } }, output: 'same document', readOnly: true });
      actions.push(progress.finishBatch());
    }
    expect(actions.filter(Boolean)).toEqual(['warning', 'recovering', 'report']);
    expect(progress.snapshot()).toMatchObject({ stage: 'stopped', stagnantBatches: 12, repeatedCalls: 12 });
  });

  it('keeps distinct pages and changed-then-restored results independent', () => {
    const progress = new QueryProgress();
    for (let offset = 0; offset < 40; offset++) {
      progress.observe({ call: { name: 'FileRead', input: { offset } }, output: 'identical lines', readOnly: true });
      expect(progress.finishBatch()).toBeNull();
    }
    expect(observe(progress, 'Status', 'A')).toBeNull();
    expect(observe(progress, 'Status', 'B')).toBeNull();
    expect(observe(progress, 'Status', 'A')).toBeNull();
    expect(progress.snapshot()).toMatchObject({ stage: 'running', stagnantBatches: 0, repeatedCalls: 0 });
  });

  it('keeps arbitrarily long investigations obtaining new evidence running', () => {
    const progress = new QueryProgress();
    for (let i = 0; i < 200; i++) expect(observe(progress, 'FileRead', `page ${i}`)).toBeNull();
    expect(progress.snapshot()).toMatchObject({ stage: 'running', stagnantBatches: 0, toolExecutions: 200 });
    expect(progress.snapshot().lastEvidenceAt).toEqual(expect.any(Number));
  });

  it('does not treat waiting, polling, approval or publication as new evidence or stagnation', () => {
    const progress = new QueryProgress();
    expect(webFetchTool.duplicateCallPolicy({})).toBe('warn');
    expect(webFetchTool.duplicateCallPolicy({ raw: true })).toBe('warn');
    const rawDocument = new QueryProgress();
    for (let i = 0; i < 13; i++) observe(rawDocument, 'WebFetch', 'unchanged schema', {
      policy: webFetchTool.duplicateCallPolicy({ raw: true }),
    });
    expect(rawDocument.snapshot()).toMatchObject({ stage: 'stopped' });
    for (let i = 0; i < 30; i++) {
      expect(observe(progress, 'WaitAgent', 'running')).toBeNull();
      expect(observe(progress, 'ReadTaskLog', 'same tail')).toBeNull();
      expect(observe(progress, 'PresentResponse', `promise ${i}`)).toBeNull();
      expect(observe(progress, 'Poll', 'running', { policy: webFetchTool.duplicateCallPolicy({ raw: true, polling: true }) })).toBeNull();
    }
    expect(progress.snapshot()).toMatchObject({ stage: 'running', stagnantBatches: 0, lastEvidenceAt: null });
  });

  it('stops unchanged failures without replaying possible side effects', () => {
    const progress = new QueryProgress();
    const call = { id: 'write-1', name: 'FileWrite', input: { content: 'RFC' } };
    for (let i = 0; i < 3; i++) {
      progress.observe({ call, output: 'Error: connection timed out', isError: true });
      progress.finishBatch();
    }
    expect(progress.blocked(call)).toMatch(/NOT executed.*side effects may already have happened/s);
    expect(progress.blocked({ ...call, input: { content: 'corrected RFC' } })).toBeNull();
    expect(progress.snapshot()).toMatchObject({ failedCalls: 3, lastEvidenceAt: null });
  });

  it('blocks an uncertain mutation immediately and groups variable permission errors', () => {
    const progress = new QueryProgress();
    const call = { id: 'write', name: 'SendMail', input: { to: 'user' } };
    progress.observe({ call, output: 'Error: connection timeout (request 1)', isError: true });
    expect(progress.blocked(call)).toContain('NOT executed');
    const read = { name: 'RemoteRead', input: {} };
    progress.observe({ call: read, output: 'Error: timeout', isError: true, readOnly: true });
    expect(progress.blocked(read)).toBeNull();
    for (let i = 0; i < 3; i++) {
      progress.observe({ call: read, output: `EACCES request=${i}`, isError: true, readOnly: true });
    }
    expect(progress.blocked(read)).toContain('3 equivalent failures');
    const partial = { name: 'Bash', input: { command: 'change-and-test' } };
    progress.observe({ call: partial, output: JSON.stringify({ error: 'Command exited with code 1.', errorEffect: 'unknown', replaySafe: false }), isError: true });
    expect(progress.blocked(partial)).toContain('NOT executed');
    observe(progress, 'FileWrite', 'created file', { readOnly: false });
    expect(progress.blocked(read)).toBeNull();
    expect(progress.blocked(partial)).toContain('NOT executed');
    progress.resetEvidence();
    expect(progress.blocked(partial)).toContain('NOT executed');
    expect(observe(progress, 'RemoteRead', 'now exists')).toBeNull();
    for (let i = 0; i < 3; i++) {
      progress.observe({ call: read, output: 'EACCES', isError: true, readOnly: true });
    }
    expect(progress.blocked(read)).not.toBeNull();
    const changedThenFailed = { name: 'Bash', input: { command: 'create-file-then-fail' } };
    progress.observe({ call: changedThenFailed, output: JSON.stringify({ error: 'later step failed', errorEffect: 'unknown', replaySafe: false }), isError: true });
    expect(progress.blocked(read)).toBeNull();
    expect(progress.blocked(changedThenFailed)).toContain('NOT executed');
    expect(progress.blocked(partial)).toContain('NOT executed');
  });

  it('revalidates a confirmed nonzero command only after new evidence, without relaxing timeout protection', () => {
    const call = { id: 'test', name: 'Bash', input: { command: 'npm test' } };
    const contract = {
      code: 'bash_exit_nonzero', failureType: 'exit_nonzero', terminationConfirmed: true,
      timedOut: false, exitCode: 1, errorEffect: 'unknown', replaySafe: false,
    };
    const progress = new QueryProgress();
    progress.observe({ call, output: JSON.stringify(contract), isError: true });
    progress.finishBatch();
    expect(progress.blocked(call)).toContain('NOT executed');
    observe(progress, 'FileEdit', 'repaired source', { readOnly: false });
    expect(progress.blocked(call)).toBeNull();
    for (const uncertain of [
      { ...contract, terminationConfirmed: false },
      { ...contract, timedOut: true },
      { ...contract, failureType: 'timeout' },
      { ...contract, code: 'bash_execution_failed' },
    ]) {
      const guarded = new QueryProgress();
      guarded.observe({ call, output: JSON.stringify(uncertain), isError: true });
      guarded.finishBatch();
      observe(guarded, 'FileEdit', 'repaired source', { readOnly: false });
      guarded.resetEvidence();
      expect(guarded.blocked(call)).toContain('NOT executed');
    }
  });

  it('keeps distinct validation and permission errors as blockers, not negative read evidence', () => {
    const progress = new QueryProgress();
    for (let i = 0; i < 12; i++) {
      progress.observe({
        call: { name: 'FileRead', input: { path: `candidate-${i}` } },
        output: i % 2 ? 'EACCES: permission denied'
          : JSON.stringify({ error: 'required property path', code: 'invalid_arguments', errorEffect: 'none' }),
        readOnly: true, isError: true,
      });
      progress.finishBatch();
    }
    expect(progress.snapshot()).toMatchObject({ stage: 'stopped', lastEvidenceAt: null, failedCalls: 12 });
  });

  it('counts reuse and suppression but not execution; mixed new evidence clears recovery', () => {
    const progress = new QueryProgress();
    observe(progress, 'ViewImage', 'image');
    for (let i = 0; i < 8; i++) observe(progress, 'ViewImage', 'image', { executed: false, reused: true });
    expect(progress.snapshot()).toMatchObject({ stage: 'recovering', toolExecutions: 1, reusedCalls: 8 });
    expect(observe(progress, 'FileEdit', 'modified section', { readOnly: false })).toBeNull();
    expect(progress.snapshot()).toMatchObject({ stage: 'running', stagnantBatches: 0,
      toolStats: [
        { name: 'ViewImage', executions: 1, failedCalls: 0, blockedCalls: 0 },
        { name: 'FileEdit', executions: 1, failedCalls: 0, blockedCalls: 0 },
      ] });
    observe(progress, 'Missing', 'PRIVATE error', { executed: false, isError: true });
    observe(progress, 'ViewImage', 'PRIVATE error', { isError: true });
    observe(progress, 'ViewImage', 'PRIVATE error', { executed: false, isError: true });
    observe(progress, 'ViewImage', 'PRIVATE skipped', { executed: false, isError: true, skipped: true });
    observe(progress, 'SkippedOnly', 'PRIVATE skipped', { executed: false, isError: true, skipped: true });
    observe(progress, 'Suppressed', 'PRIVATE prior result', { executed: false });
    const stats = progress.snapshot();
    expect(stats).toMatchObject({ toolExecutions: 3, failedCalls: 3, reusedCalls: 8,
      toolStats: [
        { name: 'ViewImage', executions: 2, failedCalls: 2, blockedCalls: 1 },
        { name: 'FileEdit', executions: 1, failedCalls: 0, blockedCalls: 0 },
        { name: 'Missing', executions: 0, failedCalls: 1, blockedCalls: 1 },
        { name: 'Suppressed', executions: 0, failedCalls: 0, blockedCalls: 0 },
      ] });
    expect(stats.toolStats.reduce((sum, row) => sum + row.failedCalls, 0)).toBe(stats.failedCalls);
    expect(JSON.stringify(stats)).not.toContain('PRIVATE');
    progress.resetEvidence();
    expect(progress.snapshot()).toMatchObject({ toolExecutions: 3, failedCalls: 3, reusedCalls: 8, toolStats: stats.toolStats });
    observe(progress, 'ViewImage', 'new image');
    expect(stats.toolStats[0].executions).toBe(2); // Snapshots do not share mutable rows.
  });

  it('allows fresh edits to invalidate read observations without identical writes keeping a loop alive', () => {
    const progress = new QueryProgress();
    for (let i = 0; i < 30; i++) {
      observe(progress, 'FileEdit', 'ok', { readOnly: false, call: { name: 'FileEdit', input: { content: `revision ${i}` } } });
      expect(observe(progress, 'FileRead', 'same generic document output')).toBeNull();
    }
    expect(progress.snapshot()).toMatchObject({ stage: 'running', stagnantBatches: 0 });
    const actions = [];
    for (let i = 0; i < 12; i++) {
      observe(progress, 'FileEdit', 'ok', { readOnly: false, call: { name: 'FileEdit', input: { content: 'revision 29' } } });
      actions.push(observe(progress, 'FileRead', 'same generic document output'));
    }
    expect(progress.snapshot()).toMatchObject({ stage: 'stopped' });
  });

  it('keeps identities/content out of public counters, resets for new input and bounds observations', () => {
    const progress = new QueryProgress();
    for (let i = 0; i < 1500; i++) observe(progress, 'FileRead', `secret document ${i}`);
    progress.requestStarted();
    const snapshot = progress.snapshot({ sessionId: 's', turnId: 't' });
    expect(snapshot).toMatchObject({ sessionId: 's', turnId: 't', modelRequests: 1 });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|rfc/);
    progress.resetEvidence();
    expect(observe(progress, 'FileRead', 'secret document 1499')).toBeNull();
    expect(progress.snapshot()).toMatchObject({ stage: 'running', stagnantBatches: 0,
      toolExecutions: 1501, toolStats: [{ name: 'FileRead', executions: 1501, failedCalls: 0, blockedCalls: 0 }] });
    expect(progress.snapshot()).not.toHaveProperty('inputTokens');
    expect(progress.snapshot()).not.toHaveProperty('outputTokens');
    for (let i = 1; i < 128; i++) observe(progress, `Tool${i}`, 'PRIVATE result');
    observe(progress, 'Overflow', 'PRIVATE error', { isError: true, executed: false });
    observe(progress, 'FileRead', 'PRIVATE error', { isError: true });
    expect(progress.snapshot()).toMatchObject({ toolStatsTruncated: true, toolExecutions: 1629, failedCalls: 2 });
    expect(progress.snapshot().toolStats).toHaveLength(128);
    expect(progress.snapshot().toolStats[0]).toEqual({ name: 'FileRead', executions: 1502, failedCalls: 1, blockedCalls: 0 });
    const names = new QueryProgress();
    const validName = 'x'.repeat(128);
    const otherName = `${'x'.repeat(127)}B`;
    observe(names, validName, 'PRIVATE output');
    observe(names, otherName, 'PRIVATE output');
    const invalidNames = [`${validName}A`, `${validName}B`, '', ' FileRead', 'FileRead ', '\tFileRead',
      'File\nRead', 'File\u0000Read', 'File\u001fRead', 'File\u007fRead', '\u00a0FileRead', 'FileRead\u00a0'];
    for (const name of invalidNames) observe(names, name, 'PRIVATE error', { isError: true, executed: false });
    names.resetEvidence();
    observe(names, validName, 'PRIVATE error', { isError: true });
    expect(names.snapshot()).toMatchObject({ toolStatsTruncated: true, toolExecutions: 3, failedCalls: invalidNames.length + 1,
      toolStats: [
        { name: validName, executions: 2, failedCalls: 1, blockedCalls: 0 },
        { name: otherName, executions: 1, failedCalls: 0, blockedCalls: 0 },
      ] });
    expect(JSON.stringify(names.snapshot())).not.toContain('PRIVATE');
  });
});
