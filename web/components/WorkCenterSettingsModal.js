import {
  clearOverlayPointerGesture,
  shouldDismissFromOverlayClick,
  trackOverlayPointerDown,
  trackOverlayPointerUp,
} from '../utils/overlay-dismiss.js';

const ACTION_TYPES = ['triage', 'research', 'design', 'diagnose', 'implement', 'migrate', 'test', 'review', 'integrate', 'document', 'operate', 'deliver', 'write', 'create_vp', 'custom'];
const MODEL_TAGS = ['fast', 'balanced', 'ultimate'];
const ALLOWED_EFFORTS = new Set(['medium', 'high', 'xhigh']);
const DEFAULT_MODEL_TAGS = Object.freeze({
  fast: 'gpt-5.6-luna',
  balanced: 'gpt-5.6-sol',
  ultimate: 'gpt-6-astra',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultAssignmentPolicy(capability, separateFromStageTypes = []) {
  return {
    mode: 'auto',
    capability,
    candidateVpIds: [],
    fixedVpId: null,
    separateFromStageTypes,
  };
}

function defaultStage(id, name, type, extra = {}) {
  return {
    id,
    name,
    type,
    instruction: '',
    assignmentPolicy: defaultAssignmentPolicy(type, extra.separateFromStageTypes),
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    maxAttempts: 2,
    ...(extra.changesRequestedStageId ? { changesRequestedStageId: extra.changesRequestedStageId } : {}),
  };
}

function defaultSettingsDraft() {
  return {
    version: 1,
    revision: 1,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    maxConcurrentActions: 3,
    defaultWorkDir: '',
    globalInstructions: '',
    modelTags: { ...DEFAULT_MODEL_TAGS },
    modelPolicy: { mode: 'tag', model: null, tag: 'balanced', effort: 'high' },
    coordinatorModelPolicy: { mode: 'tag', model: null, tag: 'ultimate', effort: 'xhigh' },
    actionModelPolicies: Object.fromEntries(ACTION_TYPES.map(type => [type, {
      mode: 'tag',
      model: null,
      tag: ['triage', 'research', 'design', 'diagnose', 'review'].includes(type)
        ? 'ultimate'
        : ['document', 'deliver', 'write'].includes(type) ? 'fast' : 'balanced',
      effort: ['triage', 'research', 'design', 'diagnose', 'review'].includes(type)
        ? 'xhigh'
        : ['document', 'deliver', 'write'].includes(type) ? 'medium' : 'high',
    }])),
    actionInstructions: Object.fromEntries(ACTION_TYPES.map(type => [type, ''])),
    workflows: [{
      version: 1,
      id: 'software-change',
      name: 'Software change',
      stages: [
        defaultStage('triage', 'Triage', 'triage'),
        defaultStage('implement', 'Implement', 'implement'),
        defaultStage('review', 'Review', 'review', {
          separateFromStageTypes: ['implement'],
          changesRequestedStageId: 'implement',
        }),
        defaultStage('deliver', 'Deliver', 'deliver'),
      ],
    }],
  };
}

export function supportsDynamicSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!value.modelTags || typeof value.modelTags !== 'object' || Array.isArray(value.modelTags)) return false;
  if (!value.modelPolicy || typeof value.modelPolicy !== 'object' || Array.isArray(value.modelPolicy)) return false;
  if (!value.coordinatorModelPolicy || typeof value.coordinatorModelPolicy !== 'object'
      || Array.isArray(value.coordinatorModelPolicy)) return false;
  if (typeof value.globalInstructions !== 'string') return false;
  if (!value.actionInstructions || typeof value.actionInstructions !== 'object' || Array.isArray(value.actionInstructions)) return false;
  if (!value.actionModelPolicies || typeof value.actionModelPolicies !== 'object' || Array.isArray(value.actionModelPolicies)) return false;
  return ACTION_TYPES.every(type => typeof value.actionInstructions[type] === 'string');
}

function confirmsSettingsSave(actual, submittedRevision) {
  return supportsDynamicSettings(actual)
    && Number.isInteger(actual.revision)
    && Number.isInteger(submittedRevision)
    && actual.revision > submittedRevision;
}

export function normalizeSettingsDraft(value, defaultStageInstructions = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
  const workflows = Array.isArray(source.workflows) && source.workflows.length > 0
    ? source.workflows
    : defaultSettingsDraft().workflows;
  const defaultWorkflow = workflows.find(workflow => workflow?.id === source.defaultWorkflowId)
    || workflows[0]
    || null;
  const stages = Array.isArray(defaultWorkflow?.stages) ? defaultWorkflow.stages : [];
  const stageInstructions = Object.fromEntries(stages
    .filter(stage => ACTION_TYPES.includes(stage?.type) && typeof stage.instruction === 'string')
    .map(stage => [stage.type, stage.instruction]));
  const sourceInstructions = source.actionInstructions && typeof source.actionInstructions === 'object'
    && !Array.isArray(source.actionInstructions)
    ? source.actionInstructions
    : {};
  const migratedModelPolicy = stages.find(stage => stage?.type === 'triage')?.modelPolicy
    || stages[0]?.modelPolicy;

  return {
    ...defaultSettingsDraft(),
    ...source,
    modelTags: {
      ...DEFAULT_MODEL_TAGS,
      ...(source.modelTags || {}),
    },
    modelPolicy: {
      mode: 'tag',
      model: null,
      tag: 'balanced',
      effort: 'high',
      ...(migratedModelPolicy || {}),
      ...(source.modelPolicy || {}),
    },
    coordinatorModelPolicy: {
      mode: 'tag',
      model: null,
      tag: 'ultimate',
      effort: 'xhigh',
      ...(source.coordinatorModelPolicy || {}),
    },
    actionModelPolicies: Object.fromEntries(ACTION_TYPES.map(type => [
      type,
      { ...defaultSettingsDraft().actionModelPolicies[type], ...(source.actionModelPolicies?.[type] || {}) },
    ])),
    actionInstructions: Object.fromEntries(ACTION_TYPES.map(type => [
      type,
      typeof sourceInstructions[type] === 'string'
        ? sourceInstructions[type]
        : (stageInstructions[type] || defaultStageInstructions[type] || ''),
    ])),
    workflows,
  };
}

function isUnsupportedSettingsError(error) {
  const message = error?.message || String(error);
  return /^Unsupported Work Center operation:\s*get_settings$/i.test(message.trim());
}

export default {
  name: 'WorkCenterSettingsModal',
  emits: ['close', 'saved', 'open-agent-models'],
  props: {
    agentId: { type: String, required: true },
  },
  data() {
    return {
      section: 'workflow',
      draft: null,
      loading: true,
      saving: false,
      error: '',
      conflict: false,
      settingsUnsupported: false,
      draftAgentId: null,
      loadGeneration: 0,
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    runtime() { return this.store.workCenterRuntimeByAgent[this.agentId] || {}; },
    vps() { return Array.isArray(this.runtime.vps) ? this.runtime.vps : []; },
    models() { return Array.isArray(this.runtime.models) ? this.runtime.models : []; },
    workflows() { return Array.isArray(this.draft?.workflows) ? this.draft.workflows : []; },
    actionTypes() { return ACTION_TYPES; },
    defaultWorkflow() {
      return this.workflows.find(workflow => workflow.id === this.draft?.defaultWorkflowId)
        || this.workflows[0]
        || null;
    },
    defaultStageInstructions() {
      return this.runtime.defaultStageInstructions || {};
    },
    sections() {
      return [
        { id: 'workflow', label: this.$t('workCenter.settings.workflow') },
        { id: 'models', label: this.$t('workCenter.settings.models') },
      ];
    },
  },
  watch: {
    runtime: {
      deep: true,
      handler() {
        this.normalizeDraftEffort();
      },
    },
  },
  async mounted() {
    window.addEventListener('keydown', this.onKeydown);
    const cached = this.store.workCenterSettingsByAgent[this.agentId];
    if (cached) {
      this.draft = normalizeSettingsDraft(cached, this.defaultStageInstructions);
      this.normalizeDraftEffort();
      this.draftAgentId = this.agentId;
      this.settingsUnsupported = !supportsDynamicSettings(cached);
      if (this.settingsUnsupported) this.error = this.$t('workCenter.settings.upgradeRequired');
      this.loading = false;
    }
    await this.load();
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKeydown);
  },
  methods: {
    trackOverlayPointerDown,
    trackOverlayPointerUp,
    clearOverlayPointerGesture,

    async load() {
      const target = this.agentId;
      const generation = ++this.loadGeneration;
      this.loading = true;
      this.error = this.settingsUnsupported && this.draft
        ? this.$t('workCenter.settings.upgradeRequired')
        : '';
      try {
        const data = await this.store.loadWorkCenterSettings(target);
        if (generation !== this.loadGeneration || target !== this.agentId) return;
        this.draft = normalizeSettingsDraft(data.settings, this.defaultStageInstructions);
        this.normalizeDraftEffort();
        this.draftAgentId = target;
        this.conflict = false;
        this.settingsUnsupported = !supportsDynamicSettings(data.settings);
        this.error = this.settingsUnsupported ? this.$t('workCenter.settings.upgradeRequired') : '';
      } catch (error) {
        if (generation !== this.loadGeneration || target !== this.agentId) return;
        if (isUnsupportedSettingsError(error)) {
          this.draft = normalizeSettingsDraft(null, this.defaultStageInstructions);
          this.draftAgentId = target;
          this.settingsUnsupported = true;
          this.error = this.$t('workCenter.settings.upgradeRequired');
        } else {
          this.error = error?.message || String(error);
        }
      } finally {
        if (generation === this.loadGeneration && target === this.agentId) this.loading = false;
      }
    },
    onKeydown(event) {
      if (event.key === 'Escape' && !this.saving) this.$emit('close');
    },
    onOverlayClick(event) {
      if (shouldDismissFromOverlayClick(event)) this.close();
    },
    close() {
      if (!this.saving) this.$emit('close');
    },
    vpLabel(vp) {
      return (this.$i18n?.locale === 'zh-CN' && vp.nameZh) ? vp.nameZh : (vp.name || vp.id);
    },
    setAssignmentMode(stage, mode) {
      stage.assignmentPolicy.mode = mode;
      if (mode === 'fixed' && !stage.assignmentPolicy.fixedVpId) {
        stage.assignmentPolicy.fixedVpId = this.vps[0]?.id || null;
      }
      if (mode === 'pool' && stage.assignmentPolicy.candidateVpIds.length === 0 && this.vps[0]) {
        stage.assignmentPolicy.candidateVpIds = [this.vps[0].id];
      }
    },
    addWorkflow() {
      const index = this.workflows.length + 1;
      const source = this.defaultWorkflow || this.workflows[0];
      const workflow = source ? clone(source) : { version: 1, stages: [] };
      workflow.id = `workflow-${Date.now()}`;
      workflow.name = this.$t('workCenter.settings.newWorkflow', { index });
      this.draft.workflows.push(workflow);
      this.draft.defaultWorkflowId = workflow.id;
    },
    removeWorkflow() {
      if (this.workflows.length <= 1 || !this.defaultWorkflow) return;
      this.draft.workflows = this.workflows.filter(workflow => workflow.id !== this.defaultWorkflow.id);
      this.draft.defaultWorkflowId = this.draft.workflows[0].id;
    },
    addStage() {
      if (!this.defaultWorkflow) return;
      const stageId = `stage-${Date.now()}`;
      this.defaultWorkflow.stages.push({
        id: stageId,
        name: this.$t('workCenter.settings.newStage'),
        type: 'custom',
        instruction: this.defaultStageInstructions.custom || '',
        assignmentPolicy: { mode: 'auto', capability: 'custom', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
        modelPolicy: { mode: 'inherit', model: null, effort: null },
        maxAttempts: 2,
      });
    },
    moveStage(index, direction) {
      const stages = this.defaultWorkflow?.stages;
      const target = index + direction;
      if (!stages || target < 0 || target >= stages.length) return;
      const [stage] = stages.splice(index, 1);
      stages.splice(target, 0, stage);
    },
    reviewReturnCandidates(stage) {
      const stages = this.defaultWorkflow?.stages || [];
      const reviewIndex = stages.findIndex(item => item.id === stage.id);
      if (reviewIndex <= 0) return [];
      return stages.slice(0, reviewIndex)
        .filter(candidate => candidate.type !== 'review' && candidate.type !== 'deliver');
    },
    canRemoveStage(index) {
      const stages = this.defaultWorkflow?.stages;
      if (!stages || stages.length <= 1) return false;
      const removed = stages[index];
      const remaining = stages.filter((_, candidateIndex) => candidateIndex !== index);
      return remaining.every((stage, stageIndex) => {
        if (stage.type !== 'review' || stage.changesRequestedStageId !== removed.id) return true;
        return remaining.slice(0, stageIndex)
          .some(candidate => candidate.type !== 'review' && candidate.type !== 'deliver');
      });
    },
    removeStage(index) {
      const stages = this.defaultWorkflow?.stages;
      if (!stages || !this.canRemoveStage(index)) return false;
      const [removed] = stages.splice(index, 1);
      for (const [stageIndex, stage] of stages.entries()) {
        if (stage.type !== 'review' || stage.changesRequestedStageId !== removed.id) continue;
        const candidates = stages.slice(0, stageIndex)
          .filter(candidate => candidate.type !== 'review' && candidate.type !== 'deliver');
        stage.changesRequestedStageId = candidates.at(-1).id;
      }
      return true;
    },
    toggleCandidate(stage, vpId, checked) {
      const current = new Set(stage.assignmentPolicy.candidateVpIds || []);
      if (checked) current.add(vpId);
      else current.delete(vpId);
      stage.assignmentPolicy.candidateVpIds = [...current];
    },
    defaultInstructionForStage(stage) {
      return this.defaultStageInstructions[stage.type]
        || this.defaultStageInstructions.custom
        || '';
    },
    resetStageInstruction(stage) {
      stage.instruction = this.defaultInstructionForStage(stage);
    },
    setStageType(stage, type) {
      const previousDefault = this.defaultInstructionForStage(stage);
      const shouldReplaceInstruction = !stage.instruction || stage.instruction === previousDefault;
      stage.type = type;
      if (shouldReplaceInstruction) this.resetStageInstruction(stage);
    },
    modelRefForStage(stage) {
      if (stage.modelPolicy.mode === 'specific') return stage.modelPolicy.model;
      if (stage.modelPolicy.mode === 'tag') return this.draft?.modelTags?.[stage.modelPolicy.tag] || null;
      if (stage.modelPolicy.mode === 'primary') return this.runtime.primaryModel || null;
      if (stage.modelPolicy.mode === 'fast') return this.runtime.fastModel || null;
      return null;
    },
    modelForStage(stage) {
      const ref = this.modelRefForStage(stage);
      if (!ref) return null;
      return this.models.find(item => item.ref === ref || item.id === ref) || null;
    },
    modelTagSelection(tag) {
      const ref = this.draft?.modelTags?.[tag] || null;
      const model = this.models.find(item => item.ref === ref || item.id === ref);
      return model?.ref || model?.id || ref;
    },
    effortOptionsForStage(stage) {
      const model = this.modelForStage(stage);
      if (model) return Array.isArray(model.effortOptions)
        ? model.effortOptions.filter(effort => ALLOWED_EFFORTS.has(effort))
        : [];
      if (stage.modelPolicy.mode === 'inherit') {
        return [...new Set(this.models.flatMap(item => (
          Array.isArray(item.effortOptions)
            ? item.effortOptions.filter(effort => ALLOWED_EFFORTS.has(effort))
            : []
        )))];
      }
      return [];
    },
    effortHelpKeyForStage(stage) {
      if (!this.modelRefForStage(stage)) return 'workCenter.settings.effortChooseModelHelp';
      if (this.effortOptionsForStage(stage).length === 0) return 'workCenter.settings.effortUnsupportedHelp';
      return 'workCenter.settings.effortHelp';
    },
    normalizeStageEffort(stage) {
      const options = this.effortOptionsForStage(stage);
      if (!stage.modelPolicy.effort || options.includes(stage.modelPolicy.effort)) return;
      stage.modelPolicy.effort = null;
    },
    normalizeDraftEffort() {
      if (!this.draft?.modelPolicy || !Array.isArray(this.runtime?.models)) return;
      this.normalizeStageEffort({ modelPolicy: this.draft.modelPolicy });
      this.normalizeStageEffort({ modelPolicy: this.draft.coordinatorModelPolicy });
      for (const policy of Object.values(this.draft.actionModelPolicies || {})) {
        this.normalizeStageEffort({ modelPolicy: policy });
      }
    },
    setModelMode(stage, mode) {
      stage.modelPolicy.mode = mode;
      if (mode === 'specific' && !stage.modelPolicy.model) {
        stage.modelPolicy.model = this.models[0]?.ref || this.models[0]?.id || null;
      }
      if (mode === 'tag' && !stage.modelPolicy.tag) stage.modelPolicy.tag = MODEL_TAGS[0];
      this.normalizeStageEffort(stage);
    },
    setStageModel(stage, model) {
      stage.modelPolicy.model = model || null;
      this.normalizeStageEffort(stage);
    },
    setModelTag(tag, model) {
      this.draft.modelTags[tag] = model || null;
      this.normalizeDraftEffort();
    },
    async save() {
      if (!this.draft || this.saving || this.settingsUnsupported) return;
      const target = this.agentId;
      if (this.draftAgentId !== target) {
        this.conflict = true;
        this.error = this.$t('workCenter.settings.conflict');
        return;
      }
      this.saving = true;
      this.error = '';
      this.conflict = false;
      try {
        this.normalizeDraftEffort();
        const submitted = clone(this.draft);
        const data = await this.store.saveWorkCenterSettings(submitted, target);
        if (target !== this.agentId || this.draftAgentId !== target) return;
        if (!confirmsSettingsSave(data.settings, submitted.revision)) {
          this.settingsUnsupported = !supportsDynamicSettings(data.settings);
          this.error = this.$t(this.settingsUnsupported
            ? 'workCenter.settings.upgradeRequired'
            : 'workCenter.settings.saveNotConfirmed');
          return;
        }
        this.draft = normalizeSettingsDraft(data.settings, this.defaultStageInstructions);
        this.$emit('saved', data.settings);
        this.$emit('close');
      } catch (error) {
        if (target !== this.agentId) return;
        const message = error?.message || String(error);
        this.conflict = /changed elsewhere|reload before saving/i.test(message);
        this.error = this.conflict ? this.$t('workCenter.settings.conflict') : message;
      } finally {
        if (target === this.agentId) this.saving = false;
      }
    },
  },
  template: `
    <Teleport to="body">
      <div
        class="modal-overlay work-center-settings-overlay"
        @pointerdown="trackOverlayPointerDown"
        @pointerup="trackOverlayPointerUp"
        @pointercancel="clearOverlayPointerGesture"
        @click="onOverlayClick"
      >
        <section class="modal-card work-center-settings-card" role="dialog" aria-modal="true" :aria-label="$t('workCenter.settings.title')">
          <header class="work-center-settings-header">
            <div>
              <h2>{{ $t('workCenter.settings.title') }}</h2>
              <p>{{ $t('workCenter.settings.subtitle') }}</p>
            </div>
            <button class="work-center-settings-close" type="button" @click="close" :aria-label="$t('common.close')">×</button>
          </header>

          <div class="work-center-settings-body">
            <nav class="work-center-settings-nav" :aria-label="$t('workCenter.settings.title')">
              <button v-for="item in sections" :key="item.id" type="button"
                      :class="{ active: section === item.id }" @click="section = item.id">{{ item.label }}</button>
            </nav>

            <main class="work-center-settings-pane">
              <p v-if="loading && !draft" class="work-center-muted">{{ $t('common.loading') }}</p>
              <p v-else-if="!draft" class="work-center-settings-error" role="alert">{{ error }}</p>

              <template v-else-if="section === 'workflow'">
                <div class="work-center-settings-section-heading">
                  <div>
                    <h3>{{ $t('workCenter.settings.workflow') }}</h3>
                    <p>{{ $t('workCenter.settings.aiWorkflowHelp') }}</p>
                  </div>
                </div>
                <article class="work-center-policy-stage work-center-global-policy">
                  <header><strong>{{ $t('workCenter.settings.globalInstructions') }}</strong></header>
                  <div class="work-center-stage-instruction">
                    <textarea v-model="draft.globalInstructions" rows="7" maxlength="20000"
                              :placeholder="$t('workCenter.settings.globalInstructionsHint')" :disabled="settingsUnsupported"></textarea>
                    <small>{{ $t('workCenter.settings.globalInstructionsHelp') }}</small>
                  </div>
                </article>
                <div class="work-center-settings-section-heading work-center-action-policy-heading">
                  <div><h3>{{ $t('workCenter.settings.actionPolicies') }}</h3><p>{{ $t('workCenter.settings.actionPoliciesHelp') }}</p></div>
                </div>
                <article v-for="type in actionTypes" :key="type" class="work-center-policy-stage">
                  <header><strong>{{ $t('workCenter.action.' + type) }}</strong></header>
                  <div class="work-center-stage-instruction">
                    <div class="work-center-stage-instruction-heading">
                      <span>{{ $t('workCenter.settings.instruction') }}</span>
                      <button class="btn-ghost" type="button" @click="draft.actionInstructions[type] = defaultStageInstructions[type] || ''"
                              :disabled="settingsUnsupported || draft.actionInstructions[type] === (defaultStageInstructions[type] || '')">{{ $t('workCenter.settings.instructionReset') }}</button>
                    </div>
                    <textarea v-model="draft.actionInstructions[type]" rows="5" :placeholder="$t('workCenter.settings.instructionHint')" :disabled="settingsUnsupported"></textarea>
                    <small>{{ $t('workCenter.settings.dynamicInstructionHelp') }}</small>
                  </div>
                </article>
              </template>

              <template v-else-if="section === 'models'">
                <div class="work-center-settings-section-heading">
                  <div><h3>{{ $t('workCenter.settings.models') }}</h3><p>{{ $t('workCenter.settings.dynamicModelsHelp') }}</p></div>
                  <button class="btn-secondary" type="button" @click="$emit('open-agent-models')">{{ $t('workCenter.settings.manageProviders') }}</button>
                </div>
                <article class="work-center-model-stage">
                  <label>{{ $t('workCenter.settings.maxConcurrentActions') }}
                    <input v-model.number="draft.maxConcurrentActions" type="number" min="1" max="12" :disabled="settingsUnsupported">
                    <small>{{ $t('workCenter.settings.maxConcurrentActionsHelp') }}</small>
                  </label>
                </article>
                <article v-for="tag in ['fast', 'balanced', 'ultimate']" :key="tag" class="work-center-model-stage">
                  <strong>{{ $t('workCenter.settings.modelTag.' + tag) }}</strong>
                  <label>{{ $t('workCenter.settings.model') }}
                    <select :value="modelTagSelection(tag)" :disabled="settingsUnsupported" @change="setModelTag(tag, $event.target.value)">
                      <option v-if="draft.modelTags[tag] && !modelForStage({ modelPolicy: { mode: 'tag', tag } })" :value="draft.modelTags[tag]" disabled>{{ draft.modelTags[tag] }}</option>
                      <option v-for="model in models" :key="model.ref || model.id" :value="model.ref || model.id">{{ model.provider }} · {{ model.label || model.id }}</option>
                    </select>
                  </label>
                </article>
                <article class="work-center-model-stage">
                  <strong>{{ $t('workCenter.settings.coordinatorModel') }}</strong>
                  <label>{{ $t('workCenter.settings.modelPolicy') }}
                    <select :value="draft.coordinatorModelPolicy.mode" :disabled="settingsUnsupported" @change="setModelMode({ modelPolicy: draft.coordinatorModelPolicy }, $event.target.value)">
                      <option value="inherit">{{ $t('workCenter.settings.model.inherit') }}</option>
                      <option value="primary">{{ $t('workCenter.settings.model.primary') }}</option>
                      <option value="fast">{{ $t('workCenter.settings.model.fast') }}</option>
                      <option value="tag">{{ $t('workCenter.settings.model.tag') }}</option>
                      <option value="specific">{{ $t('workCenter.settings.model.specific') }}</option>
                    </select>
                  </label>
                  <label v-if="draft.coordinatorModelPolicy.mode === 'tag'">{{ $t('workCenter.settings.modelTag') }}
                    <select v-model="draft.coordinatorModelPolicy.tag" :disabled="settingsUnsupported">
                      <option v-for="tag in ['fast', 'balanced', 'ultimate']" :key="tag" :value="tag">{{ $t('workCenter.settings.modelTag.' + tag) }}</option>
                    </select>
                  </label>
                  <label v-if="draft.coordinatorModelPolicy.mode === 'specific'">{{ $t('workCenter.settings.model') }}
                    <select :value="draft.coordinatorModelPolicy.model" :disabled="settingsUnsupported" @change="setStageModel({ modelPolicy: draft.coordinatorModelPolicy }, $event.target.value)">
                      <option v-for="model in models" :key="model.ref || model.id" :value="model.ref || model.id">{{ model.provider }} · {{ model.label || model.id }}</option>
                    </select>
                  </label>
                  <label class="work-center-model-effort">{{ $t('workCenter.settings.effort') }}
                    <select v-model="draft.coordinatorModelPolicy.effort" :disabled="settingsUnsupported || effortOptionsForStage({ modelPolicy: draft.coordinatorModelPolicy }).length === 0">
                      <option :value="null">{{ $t('workCenter.settings.effortDefault') }}</option>
                      <option v-for="effort in effortOptionsForStage({ modelPolicy: draft.coordinatorModelPolicy })" :key="effort" :value="effort">{{ effort }}</option>
                    </select>
                  </label>
                  <small>{{ $t('workCenter.settings.coordinatorModelHelp') }}</small>
                </article>
                <article v-for="type in actionTypes" :key="type" class="work-center-model-stage">
                  <strong>{{ $t('workCenter.action.' + type) }}</strong>
                  <label>{{ $t('workCenter.settings.modelPolicy') }}
                    <select :value="draft.actionModelPolicies[type].mode" :disabled="settingsUnsupported" @change="setModelMode({ modelPolicy: draft.actionModelPolicies[type] }, $event.target.value)">
                      <option value="inherit">{{ $t('workCenter.settings.model.inherit') }}</option>
                      <option value="primary">{{ $t('workCenter.settings.model.primary') }}</option>
                      <option value="fast">{{ $t('workCenter.settings.model.fast') }}</option>
                      <option value="tag">{{ $t('workCenter.settings.model.tag') }}</option>
                      <option value="specific">{{ $t('workCenter.settings.model.specific') }}</option>
                    </select>
                  </label>
                  <label v-if="draft.actionModelPolicies[type].mode === 'tag'">{{ $t('workCenter.settings.modelTag') }}
                    <select v-model="draft.actionModelPolicies[type].tag" :disabled="settingsUnsupported">
                      <option v-for="tag in ['fast', 'balanced', 'ultimate']" :key="tag" :value="tag">{{ $t('workCenter.settings.modelTag.' + tag) }}</option>
                    </select>
                  </label>
                  <label v-if="draft.actionModelPolicies[type].mode === 'specific'">{{ $t('workCenter.settings.model') }}
                    <select :value="draft.actionModelPolicies[type].model" :disabled="settingsUnsupported" @change="setStageModel({ modelPolicy: draft.actionModelPolicies[type] }, $event.target.value)">
                      <option v-for="model in models" :key="model.ref || model.id" :value="model.ref || model.id">{{ model.provider }} · {{ model.label || model.id }}</option>
                    </select>
                  </label>
                  <label class="work-center-model-effort">{{ $t('workCenter.settings.effort') }}
                    <select v-model="draft.actionModelPolicies[type].effort" :disabled="settingsUnsupported || effortOptionsForStage({ modelPolicy: draft.actionModelPolicies[type] }).length === 0">
                      <option :value="null">{{ $t('workCenter.settings.effortDefault') }}</option>
                      <option v-for="effort in effortOptionsForStage({ modelPolicy: draft.actionModelPolicies[type] })" :key="effort" :value="effort">{{ effort }}</option>
                    </select>
                  </label>
                </article>
                <article class="work-center-model-stage">
                  <strong>{{ $t('workCenter.settings.allActions') }}</strong>
                  <label>{{ $t('workCenter.settings.modelPolicy') }}
                    <select :value="draft.modelPolicy.mode" :disabled="settingsUnsupported" @change="setModelMode({ modelPolicy: draft.modelPolicy }, $event.target.value)">
                      <option value="inherit">{{ $t('workCenter.settings.model.inherit') }}</option>
                      <option value="primary">{{ $t('workCenter.settings.model.primary') }}</option>
                      <option value="fast">{{ $t('workCenter.settings.model.fast') }}</option>
                      <option value="tag">{{ $t('workCenter.settings.model.tag') }}</option>
                      <option value="specific">{{ $t('workCenter.settings.model.specific') }}</option>
                    </select>
                  </label>
                  <label v-if="draft.modelPolicy.mode === 'tag'">{{ $t('workCenter.settings.modelTag') }}
                    <select v-model="draft.modelPolicy.tag" :disabled="settingsUnsupported">
                      <option v-for="tag in ['fast', 'balanced', 'ultimate']" :key="tag" :value="tag">{{ $t('workCenter.settings.modelTag.' + tag) }}</option>
                    </select>
                  </label>
                  <label v-if="draft.modelPolicy.mode === 'specific'">{{ $t('workCenter.settings.model') }}
                    <select :value="draft.modelPolicy.model" :disabled="settingsUnsupported" @change="setStageModel({ modelPolicy: draft.modelPolicy }, $event.target.value)">
                      <option v-for="model in models" :key="model.ref || model.id" :value="model.ref || model.id">{{ model.provider }} · {{ model.label || model.id }}</option>
                    </select>
                  </label>
                  <label class="work-center-model-effort">{{ $t('workCenter.settings.effort') }}
                    <select v-model="draft.modelPolicy.effort"
                            :disabled="settingsUnsupported || effortOptionsForStage({ modelPolicy: draft.modelPolicy }).length === 0">
                      <option :value="null">{{ $t('workCenter.settings.effortDefault') }}</option>
                      <option v-for="effort in effortOptionsForStage({ modelPolicy: draft.modelPolicy })" :key="effort" :value="effort">{{ effort }}</option>
                    </select>
                    <small>{{ $t(effortHelpKeyForStage({ modelPolicy: draft.modelPolicy })) }}</small>
                  </label>
                </article>
              </template>
            </main>
          </div>

          <p v-if="error && draft" class="work-center-settings-error" role="alert">{{ error }}</p>
          <footer class="work-center-settings-footer">
            <button v-if="conflict" class="btn-secondary" type="button" @click="load" :disabled="saving || loading">{{ $t('workCenter.settings.reload') }}</button>
            <span class="work-center-settings-footer-spacer"></span>
            <button class="btn-secondary" type="button" @click="close">{{ $t('common.cancel') }}</button>
            <button class="btn-primary" type="button" @click="save" :disabled="saving || loading || conflict || settingsUnsupported">{{ saving ? $t('workCenter.settings.saving') : $t('common.save') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
  `,
};
