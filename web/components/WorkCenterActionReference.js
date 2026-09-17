/** Resolve only within the selected WorkItem; legacy stage aliases must be unambiguous. */
export function resolveActionReference(actions = [], { actionId, stageId, runId } = {}, runReferences = []) {
  const run = runId ? runReferences.find(reference => reference.id === runId) : null;
  const id = actionId || run?.actionId;
  if (id) return actions.find(action => action.id === id) || null;
  if (!stageId) return null;
  const matches = actions.filter(action => action.stageId === stageId);
  return matches.length === 1 ? matches[0] : null;
}

export default {
  name: 'WorkCenterActionReference',
  props: {
    actions: { type: Array, default: () => [] },
    actionId: { type: String, default: '' },
    stageId: { type: String, default: '' },
    runId: { type: String, default: '' },
    runReferences: { type: Array, default: () => [] },
  },
  emits: ['select-action'],
  computed: {
    action() { return resolveActionReference(this.actions, this, this.runReferences); },
    label() {
      if (!this.action) return this.$t('workCenter.sourceUnavailable');
      const sequence = Number(this.action.sequence) || this.actions.indexOf(this.action) + 1;
      const number = this.$t('workCenter.actionNumber', { number: sequence });
      const objective = this.action.brief?.objective || this.action.objective || this.action.title;
      const type = this.$t(`workCenter.action.${this.action.type}`);
      return `${number} · ${objective || (type.startsWith('workCenter.') ? this.$t('workCenter.untitledAction') : type)}`;
    },
    identity() { return this.runId || this.actionId || this.stageId; },
  },
  template: `
    <button v-if="action" type="button" class="work-center-action-reference" :title="label"
      :data-action-id="action.id" @click="$emit('select-action', action)">
      <span>{{ label }}</span>
      <span aria-hidden="true" class="work-center-reference-arrow">↗</span>
    </button>
    <span v-else class="work-center-reference-unavailable" :title="identity">{{ label }}</span>
  `,
};
