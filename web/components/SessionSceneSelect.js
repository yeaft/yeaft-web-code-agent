// Menu order. Mirrors agent/yeaft/sessions/scene-ids.js; 'short-video' is the
// stored ID of the content creation scene.
export const SESSION_SCENE_IDS = Object.freeze([
  'general', 'software', 'frontend', 'writing', 'short-video', 'video-editing',
  'primary-education', 'investment',
]);

// Scenes added after the original five are offered only when the Agent
// advertises them, so an older Agent never receives a scene it would reject.
export const SESSION_SCENE_CAPABILITIES = Object.freeze({
  frontend: 'session_scene_frontend',
  'video-editing': 'session_scene_video_editing',
  'primary-education': 'session_scene_primary_education',
});

/**
 * Scenes an Agent can run, in menu order.
 * @param {(capability: string) => boolean|undefined} hasCapability
 * @returns {string[]}
 */
export function sessionScenesForAgent(hasCapability) {
  return SESSION_SCENE_IDS.filter(sceneId => !SESSION_SCENE_CAPABILITIES[sceneId]
    || hasCapability(SESSION_SCENE_CAPABILITIES[sceneId]) === true);
}

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
    inActionMenu: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    open: { type: Boolean, default: undefined },
  },
  emits: ['update:open'],
  setup() {
    return { listboxId: `session-scene-${Vue.useId()}` };
  },
  data() {
    return { localOpen: false, requestedScene: '', errorKey: '', unconfirmedScene: '' };
  },
  computed: {
    sceneIds() {
      const chat = Pinia.useChatStore();
      const offered = sessionScenesForAgent(capability => chat.hasAgentCapability?.(this.agentId, capability));
      // Keep the Session's current scene listed and selected, e.g. while capabilities load.
      return SESSION_SCENE_IDS.filter(sceneId => offered.includes(sceneId) || sceneId === this.session.sceneId);
    },
    pendingScene() {
      return this.requestedScene || Pinia.useChatStore().pendingSessionSceneSelectionFor?.(this.session.id, this.agentId) || '';
    },
    displayedScene() { return this.pendingScene || displaySessionScene(this.session); },
    displayedLabel() { return this.$t('yeaft.session.scene.' + this.displayedScene); },
    isOpen() { return !this.unavailable && (this.open ?? this.localOpen); },
    unavailable() { return this.disabled || !!this.pendingScene; },
  },
  watch: {
    isOpen: {
      flush: 'post',
      handler(open) {
        if (open) this.focusOption(this.displayedScene);
      },
    },
    'session.sceneId'(sceneId) {
      if (sceneId && sceneId === this.unconfirmedScene) {
        this.unconfirmedScene = '';
        this.errorKey = '';
      }
    },
    unavailable(value) {
      if (value) this.setOpen(false);
    },
  },
  mounted() {
    document.addEventListener('pointerdown', this.onOutside, true);
    document.addEventListener('click', this.onOutside, true);
    if (this.isOpen) this.focusOption(this.displayedScene);
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('click', this.onOutside, true);
  },
  methods: {
    setOpen(open) {
      if (open === (this.open ?? this.localOpen) || (open && this.unavailable)) return;
      if (this.open === undefined) this.localOpen = open;
      this.$emit('update:open', open);
    },
    closeToTrigger() {
      this.$refs.trigger.focus({ preventScroll: true });
      this.setOpen(false);
    },
    focusOption(sceneId) {
      this.$refs.listbox?.querySelector(`[data-scene-id="${sceneId}"]`)?.focus();
    },
    onOutside(event) {
      if (this.isOpen && !this.$el.contains(event.target)) this.setOpen(false);
    },
    onFocusout(event) {
      if (this.isOpen && !this.$el.contains(event.relatedTarget)) this.setOpen(false);
    },
    onKeydown(event) {
      const { key } = event;
      if (!this.isOpen) {
        if (!this.unavailable && (key === 'ArrowDown' || key === 'ArrowUp')) {
          event.preventDefault();
          this.setOpen(true);
        }
        return;
      }
      if (key === 'Tab') {
        // Continue from the trigger in the browser's normal tab order, in either direction.
        this.closeToTrigger();
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeToTrigger();
        return;
      }
      const sceneId = event.target.dataset.sceneId;
      const index = this.sceneIds.indexOf(sceneId);
      const last = this.sceneIds.length - 1;
      let next;
      if (key === 'ArrowDown') next = Math.min(index + 1, last);
      else if (key === 'ArrowUp') next = index < 0 ? last : Math.max(index - 1, 0);
      else if (key === 'Home') next = 0;
      else if (key === 'End') next = last;
      else if ((key === 'Enter' || key === ' ') && sceneId) {
        event.preventDefault();
        this.changeScene(sceneId);
        return;
      } else return;
      event.preventDefault();
      this.focusOption(this.sceneIds[next]);
    },
    async changeScene(sceneId) {
      if (this.unavailable || !this.sceneIds.includes(sceneId)) return;
      this.closeToTrigger();
      // Reselecting the displayed scene doesn't prove what the Agent saved.
      if (sceneId === this.session.sceneId) return;
      this.errorKey = '';
      this.unconfirmedScene = '';
      this.requestedScene = sceneId;
      try {
        const chat = Pinia.useChatStore();
        const result = await chat.updateYeaftSessionScene(this.session.id, sceneId, this.agentId);
        if (result?.ok) return;
        if (result?.error?.code === 'scene_unconfirmed') {
          // A fresh Session snapshot may have confirmed the save in the meantime.
          if (this.session.sceneId !== sceneId) {
            this.unconfirmedScene = sceneId;
            this.errorKey = 'unconfirmed';
          }
        } else {
          this.errorKey = 'updateError';
        }
      } catch (_) {
        this.errorKey = 'updateError';
      } finally {
        this.requestedScene = '';
      }
    },
  },
  template: `
    <div class="yeaft-composer-choice yeaft-composer-scene" :class="{ 'is-open': isOpen }" @keydown="onKeydown" @focusout="onFocusout">
      <button
        ref="trigger"
        type="button"
        class="session-scene-select__trigger"
        :aria-label="$t(inActionMenu ? 'yeaft.session.scene.choose' : 'yeaft.session.scene.label') + ': ' + displayedLabel"
        :title="$t('yeaft.session.scene.label')"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        :aria-controls="isOpen ? listboxId : undefined"
        :aria-busy="!!pendingScene"
        :aria-disabled="unavailable"
        :disabled="disabled"
        @mousedown="isOpen && $event.preventDefault()"
        @click="isOpen ? closeToTrigger() : setOpen(true)"
      >
        <span class="chat-composer-overflow-label">{{ $t('yeaft.session.scene.choose') }}</span>
        <span class="yeaft-composer-model-name">{{ displayedLabel }}</span>
        <svg class="yeaft-model-chevron" :class="{ open: isOpen }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
      </button>
      <div v-if="isOpen" :id="listboxId" ref="listbox" class="yeaft-model-dropdown yeaft-composer-scene-dropdown" role="listbox" :aria-label="$t('yeaft.session.scene.label')">
        <button
          v-for="sceneId in sceneIds"
          :key="sceneId"
          type="button"
          class="yeaft-model-option yeaft-composer-scene-option"
          :class="{ active: sceneId === session.sceneId }"
          role="option"
          tabindex="-1"
          :data-scene-id="sceneId"
          :aria-selected="sceneId === session.sceneId"
          @mousedown.prevent
          @click="changeScene(sceneId)"
        >
          <span class="yeaft-model-check" aria-hidden="true">{{ sceneId === session.sceneId ? '✓' : '' }}</span>
          <span class="yeaft-model-option-label">{{ $t('yeaft.session.scene.' + sceneId) }}</span>
        </button>
      </div>
      <span v-if="errorKey" class="yeaft-composer-scene-error" role="alert">{{ $t('yeaft.session.scene.' + errorKey) }}</span>
    </div>
  `,
};
