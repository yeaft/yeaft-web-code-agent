/** Opt-in instance scheduler. Timer reads never originate in request/status paths.
 * SQLite owns consent, due times, event coalescing and admission across processes.
 * This owns no conversation, provider, task runner or execution quota.
 */
export class PersonAutonomy {
  constructor({ repository, runtime, intervalMs = 5000 }) {
    this.repository = repository; this.runtime = runtime; this.intervalMs = intervalMs;
    this.closed = false; this.pending = null; this.observations = new Set();
    this.timer = setTimeout(() => this.tick(), intervalMs); this.timer.unref();
  }
  observe(completion) {
    if (this.closed || !completion?.ownerId) return;
    const task = completion.task;
    if (!task?.source?.episodeId || !['succeeded', 'failed'].includes(task.status)) return;
    const pending = this.repository.autonomyObserve(completion.ownerId, {
      taskId: task.id, episodeId: task.source.episodeId, status: task.status, sourceRef: completion.sourceRef,
    }).catch(() => {});
    this.observations.add(pending); pending.finally(() => this.observations.delete(pending));
  }
  tick() {
    if (this.closed || this.pending) return this.pending;
    clearTimeout(this.timer);
    this.pending = this.scan().catch(() => {}).finally(() => {
      this.pending = null;
      if (!this.closed) { this.timer = setTimeout(() => this.tick(), this.intervalMs); this.timer.unref(); }
    });
    return this.pending;
  }
  async scan() {
    let after = '';
    do {
      const page = await this.repository.autonomyOwners({ after, limit: 50 });
      for (const ownerId of page.owners) {
        if (this.closed) return;
        if (this.runtime.isOwnerRunning(ownerId)) continue; // Also cancellation and pause.
        // Win durable admission before opening task storage: a losing worker
        // must not orphan another process's live tasks during reconciliation.
        // Runtime context restores status after admission, never replaying effects.
        const admitted = await this.repository.autonomyAdmit(ownerId, {
          workerId: this.runtime.workerId, budget: this.runtime.budget,
        });
        if (!admitted || admitted.duplicate) continue;
        // Recheck the durable lease after queued cancellation/settings requests.
        await this.repository.heartbeat(admitted.episode);
        // Shutdown/cancel can win while SQLite is admitting. Join and fence the
        // admitted record instead of dispatching a queued model callback later.
        if (this.closed || this.runtime.isOwnerRunning(ownerId)) {
          await this.repository.finish(admitted.episode, 'interrupted', 'INTERRUPTED');
        } else this.runtime.start(admitted.episode);
      }
      after = page.next;
    } while (after && !this.closed);
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    await this.pending;
    await Promise.allSettled([...this.observations]);
  }
}
