import {
  EXPERT_ROLES, EXPERT_TEAMS, getRolesByTeam,
  getSelectionLabel, MAX_SELECTIONS, DEFAULT_TEAM,
  getVisibleTeams
} from '../utils/expert-roles.js';
import ExpertRoleEditor from './ExpertRoleEditor.js';

export default {
  name: 'ExpertPanel',
  components: { ExpertRoleEditor },
  template: `
    <div class="expert-panel" :class="{ open: visible }">
      <div class="expert-panel-header">
        <span class="expert-panel-title">{{ $t('expertPanel.title') }}</span>
        <button class="expert-panel-close" @click="$emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>

      <!-- Team Tabs -->
      <div class="expert-team-tabs">
        <button
          v-for="team in allTeamTabs"
          :key="team.id"
          class="expert-team-tab"
          :class="{ active: enabledTeams.has(team.id) }"
          @click="toggleTeam(team.id)"
          :title="team.name"
        >
          <span class="team-tab-icon">{{ team.icon }}</span>
          <span class="team-tab-name">{{ team.name }}</span>
        </button>
      </div>

      <!-- Role Detail View (shown when viewing a role's prompt) -->
      <div v-if="viewingRoleId" class="expert-role-detail">
        <div class="expert-role-detail-header">
          <button class="expert-role-detail-back" @click="viewingRoleId = null">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <span class="expert-role-detail-name">{{ viewingRoleTitle }}</span>
        </div>
        <!-- Built-in role detail (from agent definitions) -->
        <div class="expert-role-detail-body" v-if="viewingRoleDef">
          <div class="expert-prompt-section">
            <div class="expert-prompt-label">{{ $t('expertPanel.persona') }}</div>
            <pre class="expert-prompt-content">{{ isZh ? viewingRoleDef.messagePrefix : viewingRoleDef.messagePrefixEn }}</pre>
          </div>
          <div class="expert-prompt-section" v-for="(actionDef, actionId) in viewingRoleDef.actions" :key="actionId">
            <div class="expert-prompt-label">{{ isZh ? actionDef.name : actionDef.nameEn }}</div>
            <div class="expert-prompt-sublabel">{{ $t('expertPanel.template') }}</div>
            <pre class="expert-prompt-content">{{ isZh ? actionDef.messageTemplate : actionDef.messageTemplateEn }}</pre>
            <div class="expert-prompt-sublabel">{{ $t('expertPanel.defaultMsg') }}</div>
            <pre class="expert-prompt-content">{{ isZh ? actionDef.defaultMessage : actionDef.defaultMessageEn }}</pre>
          </div>
        </div>
        <!-- Custom role detail (from store.customExpertRoles) -->
        <div class="expert-role-detail-body" v-else-if="viewingCustomRole">
          <div class="expert-prompt-section" v-if="viewingCustomRole.messagePrefix || viewingCustomRole.messagePrefixEn">
            <div class="expert-prompt-label">{{ $t('expertPanel.persona') }}</div>
            <pre class="expert-prompt-content">{{ isZh ? viewingCustomRole.messagePrefix : (viewingCustomRole.messagePrefixEn || viewingCustomRole.messagePrefix) }}</pre>
          </div>
          <div class="expert-prompt-section" v-for="action in viewingCustomRole.actions" :key="action.id">
            <div class="expert-prompt-label">{{ isZh ? action.name : (action.nameEn || action.name) }}</div>
            <div class="expert-prompt-sublabel" v-if="action.messageTemplate || action.messageTemplateEn">{{ $t('expertPanel.template') }}</div>
            <pre class="expert-prompt-content" v-if="action.messageTemplate || action.messageTemplateEn">{{ isZh ? action.messageTemplate : (action.messageTemplateEn || action.messageTemplate) }}</pre>
            <div class="expert-prompt-sublabel" v-if="action.defaultMessage || action.defaultMessageEn">{{ $t('expertPanel.defaultMsg') }}</div>
            <pre class="expert-prompt-content" v-if="action.defaultMessage || action.defaultMessageEn">{{ isZh ? action.defaultMessage : (action.defaultMessageEn || action.defaultMessage) }}</pre>
          </div>
          <div class="expert-prompt-section" v-if="!viewingCustomRole.actions || viewingCustomRole.actions.length === 0">
            <div class="expert-prompt-label" style="color: var(--text-muted)">{{ $t('expertPanel.noActions') }}</div>
          </div>
        </div>
        <div class="expert-role-detail-body" v-else>
          <div class="expert-prompt-loading">{{ $t('expertPanel.loading') }}</div>
        </div>
      </div>

      <!-- Role List (hidden when viewing detail) -->
      <div class="expert-role-list" ref="roleListRef" v-show="!viewingRoleId">
          <!-- Built-in team grouped mode -->
          <div v-for="group in filteredGroups" :key="group.teamId" class="expert-team-group">
            <div class="expert-team-header">
              <span class="team-header-icon">{{ group.team.icon }}</span>
              <span class="team-header-name">{{ group.team.name }}</span>
            </div>
            <div
              v-for="role in group.roles"
              :key="role.id"
              class="expert-role-card"
              :class="{ 'has-selection': hasRoleSelection(role.id) }"
            >
              <div class="role-card-header">
                <span
                  class="role-card-name"
                  :class="{ selected: isRoleOnlySelected(role.id), disabled: isRoleDisabled(role.id) }"
                  @click="toggleRoleOnly(role)"
                >{{ role.title }}\u00B7{{ role.name }}</span>
                <button
                  class="role-view-btn"
                  @click="viewRole(role.id)"
                  :title="$t('expertPanel.viewPrompt')"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                </button>
              </div>
              <div class="role-card-actions">
                <button
                  v-for="action in role.actions"
                  :key="action.id"
                  class="role-action-btn"
                  :class="{ selected: isSelected(role.id, action.id), disabled: isDisabled(role.id, action.id) }"
                  @click="toggleAction(role, action)"
                >{{ action.name }}</button>
              </div>
            </div>
          </div>

          <!-- Custom Roles Section (when custom tab is active) -->
          <div v-if="isCustomTabActive" class="expert-team-group">
            <div class="expert-team-header">
              <span class="team-header-icon">\u2728</span>
              <span class="team-header-name">{{ $t('expertPanel.customRoles') }}</span>
              <button class="expert-add-role-btn" @click="openEditor(null)" :title="$t('expertPanel.addRole')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              </button>
            </div>

            <!-- Empty state -->
            <div v-if="store.customExpertRoles.length === 0" class="expert-custom-empty">
              <div class="expert-custom-empty-text">{{ $t('expertPanel.noCustomRoles') }}</div>
              <button class="expert-custom-empty-btn" @click="openEditor(null)">{{ $t('expertPanel.createFirst') }}</button>
            </div>

            <!-- Custom role cards -->
            <div
              v-for="role in store.customExpertRoles"
              :key="'custom-' + role.id"
              class="expert-role-card"
              :class="{ 'has-selection': hasRoleSelection(role.id) }"
            >
              <div class="role-card-header">
                <span
                  class="role-card-name"
                  :class="{ selected: isRoleOnlySelected(role.id), disabled: isRoleDisabled(role.id) }"
                  @click="toggleCustomRoleOnly(role)"
                >{{ role.title }}\u00B7{{ role.name }}</span>
                <div class="role-card-actions-toolbar">
                  <button
                    class="role-view-btn"
                    @click="viewRole(role.id)"
                    :title="$t('expertPanel.viewPrompt')"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                  </button>
                  <button
                    class="role-edit-btn"
                    @click="openEditor(role)"
                    :title="$t('expertPanel.editRole')"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                  </button>
                  <button
                    class="role-delete-btn"
                    @click="confirmDeleteRole(role)"
                    :title="$t('expertPanel.deleteRole')"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                  </button>
                </div>
              </div>
              <div class="role-card-actions">
                <button
                  v-for="action in role.actions"
                  :key="action.id"
                  class="role-action-btn"
                  :class="{ selected: isSelected(role.id, action.id), disabled: isDisabled(role.id, action.id) }"
                  @click="toggleCustomAction(role, action)"
                >{{ action.name }}</button>
              </div>
            </div>
          </div>
      </div>

      <!-- Selected Summary (bottom) -->
      <div class="expert-panel-footer" v-if="selections.length > 0 && !viewingRoleId">
        <div class="expert-selected-chips">
          <span
            v-for="(sel, index) in selections"
            :key="sel.role + (sel.action || '')"
            class="expert-chip"
          >
            {{ getSelectionLabelFull(sel) }}
            <button class="chip-remove" @click="removeSelection(index)">&times;</button>
          </span>
        </div>
        <button class="expert-clear-all" @click="clearAll">
          {{ $t('expertPanel.clearAll') }}
        </button>
      </div>

      <!-- Role Editor Modal -->
      <ExpertRoleEditor
        v-if="editorOpen"
        :role="editingRole"
        @close="editorOpen = false"
        @saved="onEditorSaved"
      />

      <!-- Delete Confirmation -->
      <div v-if="deletingRole" class="expert-editor-overlay" @click.self="deletingRole = null">
        <div class="expert-delete-confirm">
          <div class="expert-delete-confirm-text">
            {{ $t('expertPanel.deleteConfirm', { name: deletingRole.name }) }}
          </div>
          <div class="expert-delete-confirm-actions">
            <button class="expert-editor-cancel" @click="deletingRole = null">{{ $t('expertEditor.cancel') }}</button>
            <button class="expert-delete-confirm-btn" @click="executeDelete">{{ $t('expertPanel.deleteConfirmBtn') }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
  props: {
    visible: { type: Boolean, default: false },
    modelValue: { type: Array, default: () => [] }
  },
  emits: ['close', 'update:modelValue'],
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    const roleListRef = Vue.ref(null);

    // Whether current user is admin
    const isAdmin = Vue.computed(() => authStore.role === 'admin');

    // Language detection
    const isZh = Vue.computed(() => (store.locale || 'zh-CN') === 'zh-CN');

    // Currently viewing role detail (null = role list view)
    const viewingRoleId = Vue.ref(null);

    // Editor state
    const editorOpen = Vue.ref(false);
    const editingRole = Vue.ref(null);

    // Delete confirmation
    const deletingRole = Vue.ref(null);

    // Custom team tab definition
    const customTeamTab = { id: 'custom', name: isZh.value ? '自定义' : 'Custom', nameEn: 'Custom', icon: '\u2728', order: 99 };

    // Metadata for the viewed role (from frontend EXPERT_ROLES or custom roles)
    const viewingRoleMeta = Vue.computed(() => {
      if (!viewingRoleId.value) return null;
      const builtin = EXPERT_ROLES[viewingRoleId.value];
      if (builtin) return builtin;
      return store.customExpertRoles.find(r => r.id === viewingRoleId.value) || null;
    });

    // Display title for role detail header
    const viewingRoleTitle = Vue.computed(() => {
      const meta = viewingRoleMeta.value;
      if (!meta) return '';
      return `${meta.title}\u00B7${meta.name}`;
    });

    // Definition for the viewed role (from agent, with prompt content) — built-in only
    const viewingRoleDef = Vue.computed(() => {
      if (!viewingRoleId.value || !store.expertRoleDefinitions) return null;
      return store.expertRoleDefinitions[viewingRoleId.value] || null;
    });

    // Custom role for detail view
    const viewingCustomRole = Vue.computed(() => {
      if (!viewingRoleId.value) return null;
      // Only return custom role if not a built-in
      if (EXPERT_ROLES[viewingRoleId.value]) return null;
      return store.customExpertRoles.find(r => r.id === viewingRoleId.value) || null;
    });

    // Teams the user has enabled (loaded)
    const enabledTeams = Vue.ref(new Set([DEFAULT_TEAM]));

    // Expert selections: reactive copy from v-model
    const selections = Vue.computed(() => props.modelValue);

    // Available teams for the tab bar (filtered by admin visibility)
    const availableTeams = Vue.computed(() => {
      return getVisibleTeams(isAdmin.value);
    });

    // All team tabs including custom
    const allTeamTabs = Vue.computed(() => {
      const teams = [...availableTeams.value];
      // Always add custom tab
      teams.push({
        id: 'custom',
        name: isZh.value ? '自定义' : 'Custom',
        icon: '\u2728',
        order: 99
      });
      return teams;
    });

    // Whether custom tab is currently active
    const isCustomTabActive = Vue.computed(() => enabledTeams.value.has('custom'));

    // Set of visible team IDs for quick lookup
    const visibleTeamIds = Vue.computed(() => {
      return new Set(availableTeams.value.map(t => t.id));
    });

    // Filtered groups based on enabled teams (only from visible teams)
    const filteredGroups = Vue.computed(() => {
      return getRolesByTeam().filter(g =>
        visibleTeamIds.value.has(g.teamId) && enabledTeams.value.has(g.teamId)
      );
    });

    // Auto-fetch expert role definitions and custom roles when panel opens
    Vue.watch(() => props.visible, (val) => {
      if (val) {
        store.fetchExpertRoleDefinitions();
        store.fetchCustomExpertRoles();
      }
    });

    // View role detail
    const viewRole = (roleId) => {
      viewingRoleId.value = roleId;
      // Ensure definitions are fetched for built-in roles
      if (EXPERT_ROLES[roleId]) {
        store.fetchExpertRoleDefinitions();
      }
    };

    // Editor management
    const openEditor = (role) => {
      editingRole.value = role;
      editorOpen.value = true;
    };

    const onEditorSaved = () => {
      store.fetchCustomExpertRoles();
    };

    // Delete management
    const confirmDeleteRole = (role) => {
      deletingRole.value = role;
    };

    const executeDelete = async () => {
      if (!deletingRole.value) return;
      try {
        // Remove any selections for this role
        const roleId = deletingRole.value.id;
        const newSelections = selections.value.filter(s => s.role !== roleId);
        if (newSelections.length !== selections.value.length) {
          emit('update:modelValue', newSelections);
        }
        await store.deleteCustomExpertRole(roleId);
      } catch (err) {
        console.error('Failed to delete custom role:', err);
      }
      deletingRole.value = null;
    };

    // Team management
    const toggleTeam = (teamId) => {
      // Already the only selected team — no-op
      if (enabledTeams.value.size === 1 && enabledTeams.value.has(teamId)) return;

      // Exclusive single-select: only keep the clicked team
      enabledTeams.value = new Set([teamId]);

      // Clear selections that don't belong to this team
      if (teamId === 'custom') {
        // Keep only custom role selections
        const customIds = new Set(store.customExpertRoles.map(r => r.id));
        const newSelections = selections.value.filter(sel => customIds.has(sel.role));
        if (newSelections.length !== selections.value.length) {
          emit('update:modelValue', newSelections);
        }
      } else {
        const newSelections = selections.value.filter(sel => {
          const role = EXPERT_ROLES[sel.role];
          return role && role.group === teamId;
        });
        if (newSelections.length !== selections.value.length) {
          emit('update:modelValue', newSelections);
        }
      }
    };

    // Selection logic
    const isSelected = (roleId, actionId) => {
      return selections.value.some(s => s.role === roleId && s.action === (actionId || null));
    };

    const isRoleOnlySelected = (roleId) => {
      return selections.value.some(s => s.role === roleId && !s.action);
    };

    const hasRoleSelection = (roleId) => {
      return selections.value.some(s => s.role === roleId);
    };

    const isRoleDisabled = (roleId) => {
      if (selections.value.length >= MAX_SELECTIONS && !hasRoleSelection(roleId)) {
        return true;
      }
      return false;
    };

    const isDisabled = (roleId, actionId) => {
      if (isSelected(roleId, actionId)) return false;
      if (hasRoleSelection(roleId)) return true;
      if (selections.value.length >= MAX_SELECTIONS) return true;
      return false;
    };

    const toggleRoleOnly = (role) => {
      if (isRoleOnlySelected(role.id)) {
        emit('update:modelValue', selections.value.filter(s => !(s.role === role.id && !s.action)));
        return;
      }
      if (hasRoleSelection(role.id)) {
        emit('update:modelValue', [
          ...selections.value.filter(s => s.role !== role.id),
          { role: role.id, action: null }
        ]);
        return;
      }
      if (selections.value.length >= MAX_SELECTIONS) return;
      emit('update:modelValue', [...selections.value, { role: role.id, action: null }]);
    };

    const toggleAction = (role, action) => {
      if (isSelected(role.id, action.id)) {
        emit('update:modelValue', selections.value.filter(s => !(s.role === role.id && s.action === action.id)));
        return;
      }
      if (hasRoleSelection(role.id)) {
        emit('update:modelValue', [
          ...selections.value.filter(s => s.role !== role.id),
          { role: role.id, action: action.id }
        ]);
        return;
      }
      if (selections.value.length >= MAX_SELECTIONS) return;
      emit('update:modelValue', [...selections.value, { role: role.id, action: action.id }]);
    };

    // Custom role selection (same logic, but uses custom role data)
    const toggleCustomRoleOnly = (role) => {
      toggleRoleOnly(role);
    };

    const toggleCustomAction = (role, action) => {
      toggleAction(role, action);
    };

    // Enhanced label that also handles custom roles
    const getSelectionLabelFull = (sel) => {
      // Try built-in first
      const builtinRole = EXPERT_ROLES[sel.role];
      if (builtinRole) return getSelectionLabel(sel);
      // Try custom role
      const customRole = store.customExpertRoles.find(r => r.id === sel.role);
      if (!customRole) return sel.role;
      if (sel.action) {
        const action = customRole.actions?.find(a => a.id === sel.action);
        return action ? `${customRole.name}\u00B7${action.name}` : customRole.name;
      }
      return customRole.name;
    };

    const removeSelection = (index) => {
      const arr = [...selections.value];
      arr.splice(index, 1);
      emit('update:modelValue', arr);
    };

    const clearAll = () => {
      emit('update:modelValue', []);
    };

    return {
      store,
      roleListRef,
      enabledTeams,
      selections,
      availableTeams,
      allTeamTabs,
      filteredGroups,
      isZh,
      isCustomTabActive,
      viewingRoleId,
      viewingRoleMeta,
      viewingRoleTitle,
      viewingRoleDef,
      viewingCustomRole,
      viewRole,
      editorOpen,
      editingRole,
      openEditor,
      onEditorSaved,
      deletingRole,
      confirmDeleteRole,
      executeDelete,
      toggleTeam,
      isSelected,
      isRoleOnlySelected,
      hasRoleSelection,
      isRoleDisabled,
      isDisabled,
      toggleRoleOnly,
      toggleAction,
      toggleCustomRoleOnly,
      toggleCustomAction,
      getSelectionLabelFull,
      removeSelection,
      clearAll,
      getSelectionLabel
    };
  }
};
