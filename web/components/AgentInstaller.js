import { getAgentInstallerCommand } from '../utils/agentSetup.js';

const COPY_RESET_MS = 2000;

export default {
  props: {
    agentSecret: { type: String, default: '' },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    showSettingsLink: { type: Boolean, default: true },
  },
  emits: ['open-settings'],
  data() {
    return {
      platform: 'posix',
      copyState: 'idle',
      copyTimer: null,
    };
  },
  computed: {
    command() {
      if (!this.agentSecret) return '';
      return getAgentInstallerCommand({
        platform: this.platform,
        agentSecret: this.agentSecret,
        locationLike: globalThis.location,
      });
    },
    copyLabel() {
      if (this.copyState === 'copying') return this.$t('installer.copying');
      if (this.copyState === 'copied') return this.$t('common.copied');
      if (this.copyState === 'error') return this.$t('installer.copyFailed');
      return this.$t('installer.copyCommand');
    },
    statusText() {
      if (this.loading) return this.$t('installer.secretLoading');
      if (this.error) return this.$t('installer.secretError');
      if (!this.agentSecret) return this.$t('installer.secretRequired');
      if (this.copyState === 'error') return this.$t('installer.copyError');
      if (this.copyState === 'copied') return this.$t('installer.copySuccess');
      return '';
    },
  },
  beforeUnmount() {
    if (this.copyTimer) clearTimeout(this.copyTimer);
  },
  methods: {
    selectPlatform(platform) {
      this.platform = platform;
      this.copyState = 'idle';
    },
    async copyCommand() {
      if (!this.command || this.loading || this.copyState === 'copying') return;
      this.copyState = 'copying';
      try {
        await navigator.clipboard.writeText(this.command);
        this.copyState = 'copied';
      } catch {
        this.copyState = 'error';
        if (this.$refs.commandDetails) this.$refs.commandDetails.open = true;
      }
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => { this.copyState = 'idle'; }, COPY_RESET_MS);
    },
  },
  template: `
    <div class="agent-installer">
      <div class="agent-installer-toolbar">
        <div class="agent-installer-tabs" role="group" :aria-label="$t('installer.platformLabel')">
          <button
            v-for="target in ['posix', 'powershell']"
            :key="target"
            type="button"
            class="btn-ghost agent-installer-tab"
            :class="{ active: platform === target }"
            :aria-pressed="platform === target"
            @click="selectPlatform(target)"
          >{{ $t('installer.' + target) }}</button>
        </div>
        <button
          type="button"
          class="btn-primary agent-installer-copy"
          :disabled="!command || loading || copyState === 'copying'"
          @click="copyCommand"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-if="copyState === 'copied'" d="m5 12 4 4L19 6" />
            <template v-else><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></template>
          </svg>
          <span>{{ copyLabel }}</span>
        </button>
      </div>
      <p class="agent-installer-instruction">{{ $t('installer.instruction') }}</p>
      <details ref="commandDetails" class="agent-installer-details">
        <summary>{{ $t('installer.viewCommand') }}</summary>
        <div class="agent-installer-command" :class="{ 'is-unavailable': !command }">
          <code tabindex="0">{{ command || $t('installer.commandUnavailable') }}</code>
        </div>
      </details>
      <p v-if="statusText" class="agent-installer-status" :class="{ 'is-error': error || copyState === 'error' }" aria-live="polite">
        {{ statusText }}
        <button v-if="showSettingsLink && !loading && !agentSecret" type="button" class="btn-ghost agent-installer-settings" @click="$emit('open-settings')">
          {{ $t('installer.openSecurity') }}
        </button>
      </p>
      <p class="agent-installer-note">{{ $t('installer.note') }}</p>
    </div>
  `,
};
