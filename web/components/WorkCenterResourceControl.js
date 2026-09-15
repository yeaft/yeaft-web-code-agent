const LIMIT_FIELDS = Object.freeze([
  'maxRequests', 'maxTokens', 'maxRunRequests', 'maxActionAttempts', 'maxCoordinatorFailures',
]);

/** Blank fields are unchanged. Never round or coerce unsafe budget increments. */
export function budgetAdditions(values, limits = {}) {
  const additions = {};
  for (const field of LIMIT_FIELDS) {
    const text = String(values[field] ?? '').trim();
    if (!text) continue;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0
        || !Number.isSafeInteger(Number(limits[field]) + value)) return null;
    additions[field] = value;
  }
  return Object.keys(additions).length ? additions : null;
}

export default {
  name: 'WorkCenterResourceControl',
  props: {
    item: { type: Object, required: true },
    agentId: { type: String, required: true },
    disabled: { type: Boolean, default: false },
  },
  data() {
    return {
      fields: LIMIT_FIELDS,
      values: {},
      formOpen: false,
      editRevision: null,
      pending: '',
      error: '',
      notice: '',
      refreshRequired: false,
      active: true,
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    control() { return this.item.executionControl; },
    online() {
      return this.store.connectionState === 'connected'
        && this.store.agents.some(agent => agent.id === this.agentId && agent.online);
    },
    stale() {
      return this.refreshRequired || (this.formOpen && this.editRevision !== this.control.revision);
    },
    unavailable() {
      return this.disabled || !this.online || !!this.pending;
    },
    canManage() {
      return !this.unavailable && !this.stale && this.item.status !== 'done'
        && Number.isSafeInteger(this.control.revision) && this.control.revision > 0;
    },
    additions() { return budgetAdditions(this.values, this.control.limits); },
    hasInput() { return Object.values(this.values).some(value => String(value).trim()); },
    stopLabel() {
      const key = `workCenter.resource.stop.${this.control.stopReason?.code}`;
      const label = this.$t(key);
      return label === key ? this.$t('workCenter.resource.stopped') : label;
    },
    usageRows() {
      return [
        { key: 'total', usage: this.control.usage },
        { key: 'coordinator', usage: this.control.breakdown?.coordinator },
        { key: 'actions', usage: this.control.breakdown?.actions },
      ];
    },
  },
  watch: {
    online: {
      immediate: true,
      handler(online) { if (!online) this.refreshRequired = true; },
    },
  },
  beforeUnmount() { this.active = false; },
  methods: {
    count(value) {
      return Number.isFinite(value) ? value.toLocaleString() : '—';
    },
    openForm() {
      if (!this.canManage) return;
      this.values = {};
      this.editRevision = this.control.revision;
      this.formOpen = true;
      this.error = '';
      this.notice = '';
    },
    async refreshLatest() {
      if (this.unavailable) return;
      const { id } = this.item;
      const agentId = this.agentId;
      this.pending = 'refresh';
      this.refreshRequired = true;
      this.formOpen = false;
      this.values = {};
      try {
        const detail = await this.store.getWorkItem(id, agentId);
        if (!this.active) return;
        if (detail?.id !== id || !detail.executionControl || !this.online) return;
        this.refreshRequired = false;
        this.notice = this.$t('workCenter.resource.reconfirm');
      } catch (error) {
        if (this.active) this.error = error?.message || String(error);
      } finally {
        if (this.active) this.pending = '';
      }
    },
    async changeBudget(op) {
      if (!this.canManage || (op === 'extend' && (!this.formOpen || !this.additions))) return;
      if (op === 'resume' && !this.control.stopReason && this.item.status !== 'cancelled') return;
      const { id, revision } = this.item;
      const agentId = this.agentId;
      const executionControlRevision = this.control.revision;
      this.pending = op;
      this.error = '';
      this.notice = '';
      try {
        if (op === 'extend') {
          await this.store.extendWorkItemBudget(id, executionControlRevision, this.additions, agentId);
        } else {
          await this.store.resumeWorkItem(id, revision, agentId, executionControlRevision);
        }
        if (!this.active) return;
        this.formOpen = false;
        this.values = {};
        this.notice = this.$t(op === 'extend' ? 'workCenter.resource.extended' : 'workCenter.resource.resumed');
      } catch (error) {
        if (!this.active) return;
        this.error = error?.message || String(error);
        this.refreshRequired = true;
        this.pending = '';
        // A timeout may have committed. Read the latest state; never replay a mutation.
        await this.refreshLatest();
      } finally {
        if (this.active) this.pending = '';
      }
    },
  },
  template: `
    <section class="work-center-resources" :aria-label="$t('workCenter.resource.title')" :aria-busy="!!pending">
      <h3>{{ $t('workCenter.resource.title') }}</h3>
      <div class="work-center-resource-totals">
        <span>{{ $t('workCenter.resource.requests') }} <strong>{{ count(control.usage?.llmRequestCount) }} / {{ count(control.limits.maxRequests) }}</strong></span>
        <span>{{ $t('workCenter.resource.chargedTokens') }} <strong>{{ count(control.usage?.chargedTokens) }} / {{ count(control.limits.maxTokens) }}</strong></span>
      </div>
      <p v-if="control.stopReason" class="work-center-resource-stop" role="status">
        {{ stopLabel }}
        <span v-if="control.stopReason.attempts != null"> · {{ count(control.stopReason.attempts) }} / {{ count(control.stopReason.effectiveMaxAttempts) }}</span>
      </p>
      <details class="work-center-resource-details">
        <summary>{{ $t('workCenter.resource.details') }}</summary>
        <p class="work-center-muted">{{ $t('workCenter.resource.accounting') }}</p>
        <dl class="work-center-resource-breakdown">
          <div v-for="row in usageRows" :key="row.key">
            <dt>{{ $t('workCenter.resource.' + row.key) }}</dt>
            <dd>
              <span>{{ $t('workCenter.resource.usage', { requests: count(row.usage?.llmRequestCount), charged: count(row.usage?.chargedTokens) }) }}</span>
              <span>{{ $t('workCenter.resource.tokens', { reported: count(row.usage?.totalTokens), reserved: count(row.usage?.reservedTokens) }) }}</span>
              <span>{{ $t('workCenter.resource.unknown', { unknown: count(row.usage?.unknownRequests), inflight: count(row.usage?.inFlightRequests) }) }}</span>
            </dd>
          </div>
        </dl>
        <dl class="work-center-resource-limits">
          <div><dt>{{ $t('workCenter.resource.maxRunRequests') }}</dt><dd>{{ count(control.limits.maxRunRequests) }}</dd></div>
          <div><dt>{{ $t('workCenter.resource.maxActionAttempts') }}</dt><dd>{{ count(control.limits.maxActionAttempts) }}</dd></div>
          <div><dt>{{ $t('workCenter.resource.maxCoordinatorFailures') }}</dt><dd>{{ count(control.coordinatorFailures) }} / {{ count(control.limits.maxCoordinatorFailures) }}</dd></div>
        </dl>
        <p class="work-center-muted">{{ $t('workCenter.resource.attemptLimit') }}</p>
        <ul v-if="control.actionAttempts?.length" class="work-center-resource-attempts">
          <li v-for="action in control.actionAttempts" :key="action.actionId"><code>{{ action.actionId }}</code> · {{ count(action.attempts) }} / {{ count(action.effectiveMaxAttempts) }}</li>
        </ul>
      </details>
      <p v-if="!online" class="work-center-muted" role="status">{{ $t('workCenter.resource.offline') }}</p>
      <p v-if="stale" class="work-center-resource-stop" role="status">{{ $t('workCenter.resource.stale') }}</p>
      <p v-if="error" class="work-center-detail-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="work-center-muted" role="status">{{ notice }}</p>
      <div class="work-center-resource-buttons">
        <button v-if="stale" class="btn-secondary" type="button" :disabled="unavailable" @click="refreshLatest">{{ $t('workCenter.resource.refresh') }}</button>
        <button v-if="!formOpen && item.status !== 'done'" class="btn-ghost" type="button" :disabled="!canManage" @click="openForm">{{ $t('workCenter.resource.extend') }}</button>
        <button v-if="control.stopReason || item.status === 'cancelled'" class="btn-secondary" type="button" :disabled="!canManage || formOpen" @click="changeBudget('resume')">{{ $t('workCenter.resumeWorkItem') }}</button>
        <span v-if="pending" class="work-center-muted" role="status">{{ $t('workCenter.resource.pending') }}</span>
      </div>
      <form v-if="formOpen" class="work-center-resource-form" @submit.prevent="changeBudget('extend')" novalidate>
        <p id="work-center-budget-help" class="work-center-muted">{{ $t('workCenter.resource.extendHelp') }} {{ $t('workCenter.resource.attemptExtension') }}</p>
        <div class="work-center-resource-inputs">
          <label v-for="field in fields" :key="field">
            <span>{{ $t('workCenter.resource.' + field) }} <small>{{ $t('workCenter.resource.current', { count: count(control.limits[field]) }) }}</small></span>
            <input v-model="values[field]" type="text" inputmode="numeric" :name="field" autocomplete="off"
              :disabled="!canManage" aria-describedby="work-center-budget-help" :aria-invalid="hasInput && !additions ? 'true' : undefined" placeholder="+">
          </label>
        </div>
        <p v-if="hasInput && !additions" class="work-center-detail-error" role="alert">{{ $t('workCenter.resource.invalid') }}</p>
        <div class="work-center-resource-buttons">
          <button class="btn-primary" type="submit" :disabled="!canManage || !additions">{{ $t('workCenter.resource.confirmExtend') }}</button>
          <button class="btn-ghost" type="button" :disabled="!!pending" @click="formOpen = false">{{ $t('workCenter.resource.close') }}</button>
        </div>
      </form>
    </section>
  `,
};
