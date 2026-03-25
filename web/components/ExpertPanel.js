import {
  EXPERT_ROLES, EXPERT_TEAMS, getRolesByTeam,
  getSelectionLabel, MAX_SELECTIONS, DEFAULT_TEAM,
  getVisibleTeams
} from '../utils/expert-roles.js';

export default {
  name: 'ExpertPanel',
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
          v-for="team in availableTeams"
          :key="team.id"
          class="expert-team-tab"
          :class="{ active: enabledTeams.has(team.id), disabled: !enabledTeams.has(team.id) }"
          @click="toggleTeam(team.id)"
          :title="team.name"
        >
          <span class="team-tab-icon">{{ team.icon }}</span>
          <span class="team-tab-name">{{ team.name }}</span>
        </button>
      </div>

      <!-- Role List -->
      <div class="expert-role-list" ref="roleListRef">
          <!-- Team grouped mode -->
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
      </div>

      <!-- Selected Summary (bottom) -->
      <div class="expert-panel-footer" v-if="selections.length > 0">
        <div class="expert-selected-chips">
          <span
            v-for="(sel, index) in selections"
            :key="sel.role + (sel.action || '')"
            class="expert-chip"
          >
            {{ getSelectionLabel(sel) }}
            <button class="chip-remove" @click="removeSelection(index)">&times;</button>
          </span>
        </div>
        <button class="expert-clear-all" @click="clearAll">
          {{ $t('expertPanel.clearAll') }}
        </button>
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

    // Teams the user has enabled (loaded)
    const enabledTeams = Vue.ref(new Set([DEFAULT_TEAM]));

    // Expert selections: reactive copy from v-model
    const selections = Vue.computed(() => props.modelValue);

    // Available teams for the tab bar (filtered by admin visibility)
    const availableTeams = Vue.computed(() => {
      return getVisibleTeams(isAdmin.value);
    });

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

    // Team management
    const toggleTeam = (teamId) => {
      // Already the only selected team — no-op
      if (enabledTeams.value.size === 1 && enabledTeams.value.has(teamId)) return;

      // Exclusive single-select: only keep the clicked team
      enabledTeams.value = new Set([teamId]);

      // Clear selections that don't belong to this team
      const newSelections = selections.value.filter(sel => {
        const role = EXPERT_ROLES[sel.role];
        return role && role.group === teamId;
      });
      if (newSelections.length !== selections.value.length) {
        emit('update:modelValue', newSelections);
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
      // Can't select if already at max and this role isn't selected
      if (selections.value.length >= MAX_SELECTIONS && !hasRoleSelection(roleId)) {
        return true;
      }
      return false;
    };

    const isDisabled = (roleId, actionId) => {
      // Already selected this exact combo
      if (isSelected(roleId, actionId)) return false;
      // Same role, different action already selected (mutual exclusion)
      if (hasRoleSelection(roleId)) return true;
      // At max selections
      if (selections.value.length >= MAX_SELECTIONS) return true;
      return false;
    };

    const toggleRoleOnly = (role) => {
      if (isRoleOnlySelected(role.id)) {
        // Deselect
        emit('update:modelValue', selections.value.filter(s => !(s.role === role.id && !s.action)));
        return;
      }
      if (hasRoleSelection(role.id)) {
        // Replace existing selection for this role with pure role
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
        // Deselect
        emit('update:modelValue', selections.value.filter(s => !(s.role === role.id && s.action === action.id)));
        return;
      }
      if (hasRoleSelection(role.id)) {
        // Same role, different action → replace
        emit('update:modelValue', [
          ...selections.value.filter(s => s.role !== role.id),
          { role: role.id, action: action.id }
        ]);
        return;
      }
      if (selections.value.length >= MAX_SELECTIONS) return;
      emit('update:modelValue', [...selections.value, { role: role.id, action: action.id }]);
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
      roleListRef,
      enabledTeams,
      selections,
      availableTeams,
      filteredGroups,
      toggleTeam,
      isSelected,
      isRoleOnlySelected,
      hasRoleSelection,
      isRoleDisabled,
      isDisabled,
      toggleRoleOnly,
      toggleAction,
      removeSelection,
      clearAll,
      getSelectionLabel
    };
  }
};
