export const SESSION_SCENE_IDS = Object.freeze(['general', 'software', 'writing', 'short-video', 'investment']);

const LEGACY_SCENES = new Map([
  ['omni', 'general'],
  ['software-omni', 'software'],
  ['writing-omni', 'writing'],
  ['short-video-omni', 'short-video'],
  ['quant-omni', 'investment'],
]);

export function displaySessionScene(session) {
  return SESSION_SCENE_IDS.includes(session?.sceneId)
    ? session.sceneId
    : LEGACY_SCENES.get(session?.defaultVpId) || 'general';
}

export default {
  name: 'SessionSceneSelect',
  props: {
    session: { type: Object, required: true },
    agentId: { type: String, default: null },
    disabled: { type: Boolean, default: false },
  },
  data() {
    return { requestedScene: '', error: false, sceneIds: SESSION_SCENE_IDS };
  },
  computed: {
    pendingScene() {
      return this.requestedScene || Pinia.useChatStore().pendingSessionSceneSelectionFor?.(this.session.id, this.agentId) || '';
    },
    selectedScene() { return this.pendingScene || this.session.sceneId || ''; },
    inferredScene() { return displaySessionScene(this.session); },
  },
  methods: {
    async changeScene(event) {
      const sceneId = event.target.value;
      if (this.disabled || this.pendingScene || !this.sceneIds.includes(sceneId) || sceneId === this.session.sceneId) return;
      this.requestedScene = sceneId;
      this.error = false;
      try {
        const chat = Pinia.useChatStore();
        const result = await chat.updateYeaftSessionScene(this.session.id, sceneId, this.agentId);
        this.error = !result?.ok;
      } catch (_) {
        this.error = true;
      } finally {
        this.requestedScene = '';
        await this.$nextTick();
        // If a rejected change left the committed value unchanged, Vue may
        // have no value patch to apply after the browser changed the select.
        if (this.$refs.select) this.$refs.select.value = this.selectedScene;
      }
    },
  },
  template: `
    <div class="yeaft-composer-scene">
      <select
        ref="select"
        class="yeaft-composer-scene-select"
        :value="selectedScene"
        :aria-label="$t('yeaft.session.scene.label')"
        :title="$t('yeaft.session.scene.label')"
        :aria-busy="!!pendingScene"
        :disabled="disabled || !!pendingScene"
        @change="changeScene"
      >
        <option v-if="!session.sceneId" value="" disabled>{{ $t('yeaft.session.scene.' + (inferredScene || 'choose')) }}</option>
        <option v-for="sceneId in sceneIds" :key="sceneId" :value="sceneId">{{ $t('yeaft.session.scene.' + sceneId) }}</option>
      </select>
      <span v-if="error" class="yeaft-composer-scene-error" role="alert">{{ $t('yeaft.session.scene.updateError') }}</span>
    </div>
  `,
};
