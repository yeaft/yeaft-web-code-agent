/**
 * CrewRolePanel — Left sidebar: Role cards and action buttons.
 */
import { ICONS, getRoleStyle as getRoleStyleFn } from './crewHelpers.js';

export default {
  name: 'CrewRolePanel',
  props: {
    store: { type: Object, required: true },
    sessionRoles: { type: Array, required: true },
    roleColorMap: { type: Object, default: () => ({}) },
    crewStatus: { type: Object, default: null },
    crewMessages: { type: Array, default: () => [] },
    mode: { type: String, default: 'crew' }
  },
  emits: ['scroll-to-role', 'control-action', 'clear-role', 'abort-role', 'show-add-role'],
  template: `
    <aside class="crew-panel-left">
      <div class="crew-panel-left-scroll">
        <button class="crew-mobile-close" @click="store.crewMobilePanel = null"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> {{ $t('crew.close') }}</button>
        <div class="crew-role-list">
          <div v-for="role in sessionRoles" :key="role.name"
               class="crew-role-card"
               :class="{ 'is-streaming': isRoleStreaming(role.name) }"
               :style="getRoleStyle(role.name)"
               @click="$emit('scroll-to-role', role.name)">
            <div class="crew-role-card-header">
              <span class="crew-role-card-icon">{{ role.icon }}</span>
              <span class="crew-role-card-name">{{ role.displayName }}</span>
              <span v-if="role.isDecisionMaker" class="crew-role-card-dm">\u2605</span>
              <span class="crew-role-card-header-actions" @click.stop>
                <button v-if="isRoleStreaming(role.name)" class="crew-role-action-btn crew-role-abort-btn" @click.stop="$emit('abort-role', role.name)" :title="$t('crew.abortTask')">⏹</button>
                <button class="crew-role-action-btn" @click.stop="$emit('clear-role', role.name)" :title="$t('crew.clearChat')">🗑</button>
              </span>
            </div>
            <div v-if="getRoleCurrentTask(role.name)" class="crew-role-card-feature">
              {{ getRoleCurrentTask(role.name) }}
            </div>
            <div v-if="isRoleStreaming(role.name) && getRoleCurrentTool(role.name)"
                 class="crew-role-card-tool">
              {{ getRoleCurrentTool(role.name) }}
            </div>
          </div>
        </div>

        <div class="crew-panel-left-actions">
          <button class="crew-add-role-btn" @click="$emit('show-add-role')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span>{{ $t('crew.addRole') }}</span>
          </button>
          <button class="crew-action-btn" @click="$emit('control-action', 'clear')" :title="$t('crew.clearSession')">
            <span v-html="icons.close"></span>
          </button>
          <button class="crew-action-btn danger" @click="$emit('control-action', 'stop_all')" :title="$t('crew.stopRound')">
            <span v-html="icons.stop"></span>
          </button>
        </div>
      </div>
    </aside>
  `,
  computed: {
    icons() { return ICONS; }
  },
  methods: {
    getRoleStyle(roleName) {
      return getRoleStyleFn(roleName, this.roleColorMap[roleName]);
    },

    isRoleStreaming(roleName) {
      return this.crewStatus?.activeRoles?.includes(roleName);
    },

    getRoleCurrentTool(roleName) {
      return this.crewStatus?.currentToolByRole?.[roleName] || null;
    },

    getRoleCurrentTask(roleName) {
      const messages = this.crewMessages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === roleName && msg.taskTitle) {
          if (msg.type === 'route' && msg.routeTo === 'pm') return null;
          return msg.taskTitle;
        }
      }
      return null;
    }
  }
};
