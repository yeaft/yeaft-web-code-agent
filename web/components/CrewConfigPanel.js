/**
 * CrewConfigPanel - Crew 模式配置面板
 * 支持创建和编辑模式，参考会话 modal 的交互风格
 *
 * 创建流程: 先选 Agent → 选工作区 → 检测 .crew 目录 →
 *   已存在 → 显示恢复选项 / 不存在 → 显示新建配置
 */

import { getTemplate } from '../crew-templates/index.js';

export default {
  name: 'CrewConfigPanel',
  template: `
    <div class="crew-config-overlay" @click.self="$emit('close')">
      <div class="crew-config-panel">
        <div class="crew-config-header">
          <h2>{{ isEditMode ? 'Crew Settings' : 'Crew Session' }}</h2>
          <button class="crew-config-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="crew-config-body">
          <!-- 创建模式 -->
          <template v-if="!isEditMode">
            <!-- Agent -->
            <div class="crew-config-section">
              <label class="crew-config-label">Agent</label>
              <div class="crew-select-wrapper">
                <select class="crew-config-select" v-model="selectedAgent">
                  <option value="">{{ $t('crewConfig.selectAgent') }}</option>
                  <option v-for="agent in crewAgents" :key="agent.id" :value="agent.id">
                    {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                  </option>
                </select>
                <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </div>
            </div>

            <!-- 工作区 -->
            <div class="crew-config-section" v-if="selectedAgent">
              <label class="crew-config-label">{{ $t('crewConfig.workspace') }}</label>
              <div class="crew-workdir-group">
                <input class="crew-config-input" v-model="projectDir" :placeholder="selectedAgentWorkDir || '/home/user/projects/app'" @change="onWorkDirChange" />
                <button class="crew-browse-btn" @click="$emit('browse', 'crew')" :title="$t('crewConfig.browse')">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                </button>
              </div>
            </div>

            <!-- .crew 检测状态 -->
            <div class="crew-config-section" v-if="selectedAgent && projectDir && crewCheckState === 'checking'">
              <div class="crew-check-status">
                <span class="crew-check-spinner"></span>
                {{ $t('crewConfig.checkingCrew') }}
              </div>
            </div>

            <!-- .crew 已存在：显示恢复/删除选项 -->
            <div class="crew-config-section" v-if="selectedAgent && crewCheckState === 'exists'">
              <div class="crew-exists-banner">
                <div class="crew-exists-icon">
                  <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                </div>
                <div class="crew-exists-info">
                  <div class="crew-exists-title">{{ $t('crewConfig.foundConfig') }}</div>
                  <div class="crew-exists-detail" v-if="crewExistsSessionInfo">
                    {{ crewExistsSessionInfo.name || $t('crewConfig.unnamedTeam') }}
                    <span v-if="crewExistsSessionInfo.sessionId" class="crew-exists-session-id">{{ crewExistsSessionInfo.sessionId.slice(0, 12) }}...</span>
                  </div>
                  <div class="crew-exists-path">{{ shortenPath(projectDir) }}/.crew</div>
                </div>
              </div>

              <!-- 操作按钮区 -->
              <div class="crew-exists-actions">
                <button class="crew-exists-action-btn" @click="restoreFromDisk"
                        :disabled="!crewExistsSessionInfo?.sessionId"
                        v-if="crewExistsSessionInfo?.sessionId">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                  {{ $t('crewConfig.restoreCrew') }}
                </button>
                <button class="crew-exists-action-btn danger" @click="deleteCrewDir">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                  {{ crewExistsSessionInfo?.sessionId ? $t('crewConfig.deleteConfig') : $t('crewConfig.deleteAndRecreate') }}
                </button>
              </div>

              <div class="crew-exists-hint" v-if="crewExistsSessionInfo?.sessionId">{{ $t('crewConfig.existsHintRestore') }}</div>
              <div class="crew-exists-hint" v-else>{{ $t('crewConfig.existsHintDelete') }}</div>
            </div>

            <!-- .crew 不存在或确认新建：正常创建流程 -->
            <template v-if="selectedAgent && crewCheckState === 'none'">
              <!-- 团队名称 -->
              <div class="crew-config-section">
                <label class="crew-config-label">{{ $t('crewConfig.teamName') }}</label>
                <input class="crew-config-input" v-model="name"
                       :placeholder="$t('crewConfig.teamNamePlaceholder')"
                       maxlength="30" />
              </div>

              <!-- 角色模板 -->
              <div class="crew-config-section">
                <label class="crew-config-label">{{ $t('crewConfig.teamTemplate') }}</label>
                <div class="crew-template-btns">
                  <button class="crew-template-btn" @click="loadTemplate('dev')" :class="{ active: currentTemplate === 'dev' }">{{ $t('crewConfig.tplDev') }}</button>
                  <button class="crew-template-btn" @click="loadTemplate('writing')" :class="{ active: currentTemplate === 'writing' }">{{ $t('crewConfig.tplWriting') }}</button>
                  <button class="crew-template-btn" @click="loadTemplate('trading')" :class="{ active: currentTemplate === 'trading' }">{{ $t('crewConfig.tplTrading') }}</button>
                  <button class="crew-template-btn" @click="loadTemplate('video')" :class="{ active: currentTemplate === 'video' }">{{ $t('crewConfig.tplVideo') }}</button>
                  <button class="crew-template-btn" @click="loadTemplate('custom')" :class="{ active: currentTemplate === 'custom' }">{{ $t('crewConfig.tplCustom') }}</button>
                </div>
              </div>

              <!-- 角色配置（可编辑卡片） -->
              <div class="crew-config-section">
                <label class="crew-config-label">{{ $t('crewConfig.roleConfig') }}</label>
                <div class="crew-roles-list">
                  <div v-for="(role, idx) in roles" :key="idx" class="crew-role-item" :class="{ 'is-decision-maker': role.isDecisionMaker }">
                    <div class="crew-role-header">
                      <input class="crew-role-icon-input" v-model="role.icon" maxlength="4" />
                      <input class="crew-role-name-input" v-model="role.displayName" :placeholder="$t('crewConfig.roleName')" />
                      <label class="crew-role-decision-label" :title="role.isDecisionMaker ? $t('crewConfig.isDecisionMaker') : $t('crewConfig.setDecisionMaker')">
                        <input type="radio" name="decisionMaker" :checked="role.isDecisionMaker" @change="setDecisionMaker(idx)" />
                        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                      </label>
                      <button class="crew-role-remove" @click="removeRole(idx)">&times;</button>
                    </div>
                    <input class="crew-role-desc-input" v-model="role.description" :placeholder="$t('crewConfig.roleDesc')" />
                    <div v-if="isExpandableRole(role.name)" class="crew-role-concurrency">
                      <template v-if="role.name === 'developer'">
                        <span class="crew-concurrency-label">{{ $t('crewConfig.concurrency') }}</span>
                        <input type="number" class="crew-concurrency-input" :value="role.count || 1" @input="setDevCount($event.target.value)" min="1" max="5" />
                      </template>
                      <template v-else>
                        <span class="crew-concurrency-follow">{{ $t('crewConfig.followDev', { count: devCount }) }}</span>
                      </template>
                    </div>
                    <details class="crew-role-advanced">
                      <summary>{{ $t('crewConfig.advancedSettings') }}</summary>
                      <textarea class="crew-config-textarea" v-model="role.claudeMd" :placeholder="$t('crewConfig.customPrompt')" rows="3"></textarea>
                    </details>
                  </div>
                </div>
                <div class="crew-add-role-area">
                  <div class="crew-add-role-builtin" v-if="showBuiltinRolePicker">
                    <div class="crew-builtin-role-list">
                      <div v-for="br in availableBuiltinRoles" :key="br.name"
                           class="crew-builtin-role-item" @click="addBuiltinRole(br)">
                        <span class="crew-builtin-role-icon">{{ br.icon }}</span>
                        <span class="crew-builtin-role-name">{{ br.displayName }}</span>
                        <span class="crew-builtin-role-desc">{{ br.description }}</span>
                      </div>
                    </div>
                    <div class="crew-add-role-actions">
                      <button class="crew-add-custom-btn" @click="addCustomRole">{{ $t('crewConfig.customRoleBtn') }}</button>
                      <button class="crew-add-cancel-btn" @click="showBuiltinRolePicker = false">{{ $t('common.cancel') }}</button>
                    </div>
                  </div>
                  <button v-else class="crew-add-role-btn" @click="showBuiltinRolePicker = true">{{ $t('crewConfig.addRoleBtn') }}</button>
                </div>
              </div>

              </template>
          </template>

          <!-- 编辑模式 -->
          <template v-else>
            <!-- 团队名称 -->
            <div class="crew-config-section">
              <label class="crew-config-label">{{ $t('crewConfig.teamName') }}</label>
              <input class="crew-config-input" v-model="name"
                     :placeholder="$t('crewConfig.teamNamePlaceholder')"
                     maxlength="30" />
            </div>

            <!-- 角色配置 -->
            <div class="crew-config-section">
              <label class="crew-config-label">{{ $t('crewConfig.roleConfig') }}</label>
              <div class="crew-roles-list">
                <div v-for="(role, idx) in roles" :key="idx" class="crew-role-item" :class="{ 'is-decision-maker': role.isDecisionMaker }">
                  <div class="crew-role-header">
                    <input class="crew-role-icon-input" v-model="role.icon" maxlength="4" :disabled="!role._isNew" />
                    <input class="crew-role-name-input" v-model="role.displayName" :placeholder="$t('crewConfig.roleName')" :disabled="!role._isNew" />
                    <label class="crew-role-decision-label" :title="role.isDecisionMaker ? $t('crewConfig.isDecisionMaker') : $t('crewConfig.setDecisionMaker')">
                      <input type="radio" name="decisionMaker" :checked="role.isDecisionMaker" @change="setDecisionMaker(idx)" />
                      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                    </label>
                    <button class="crew-role-remove" @click="removeRole(idx)">&times;</button>
                  </div>
                  <input class="crew-role-desc-input" v-model="role.description" :placeholder="$t('crewConfig.roleDesc')" :disabled="!role._isNew" />
                  <div v-if="isFirstExpandableOfType(role, idx)" class="crew-role-concurrency">
                    <template v-if="(role.roleType || role.name) === 'developer'">
                      <span class="crew-concurrency-label">{{ $t('crewConfig.concurrency') }}</span>
                      <input type="number" class="crew-concurrency-input" :value="editDevCount" @input="setEditDevCount($event.target.value)" min="1" max="5" />
                    </template>
                    <template v-else>
                      <span class="crew-concurrency-follow">{{ $t('crewConfig.followDev', { count: editDevCount }) }}</span>
                    </template>
                  </div>
                  <details v-if="role._isNew" class="crew-role-advanced">
                    <summary>{{ $t('crewConfig.advancedSettings') }}</summary>
                    <textarea class="crew-config-textarea" v-model="role.claudeMd" :placeholder="$t('crewConfig.customPrompt')" rows="3"></textarea>
                  </details>
                </div>
              </div>
              <div class="crew-add-role-area">
                <div class="crew-add-role-builtin" v-if="showBuiltinRolePicker">
                  <div class="crew-builtin-role-list">
                    <div v-for="br in availableBuiltinRoles" :key="br.name"
                         class="crew-builtin-role-item" @click="addBuiltinRole(br)">
                      <span class="crew-builtin-role-icon">{{ br.icon }}</span>
                      <span class="crew-builtin-role-name">{{ br.displayName }}</span>
                      <span class="crew-builtin-role-desc">{{ br.description }}</span>
                    </div>
                  </div>
                  <div class="crew-add-role-actions">
                    <button class="crew-add-custom-btn" @click="addCustomRole">{{ $t('crewConfig.customRoleBtn') }}</button>
                    <button class="crew-add-cancel-btn" @click="showBuiltinRolePicker = false">{{ $t('common.cancel') }}</button>
                  </div>
                </div>
                <button v-else class="crew-add-role-btn" @click="showBuiltinRolePicker = true">{{ $t('crewConfig.addRoleBtn') }}</button>
              </div>
            </div>

          </template>

          <!-- 没有选择 Agent 时的提示 -->
          <div class="crew-empty-state" v-if="!isEditMode && !selectedAgent">
            <div class="crew-empty-icon">
              <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </div>
            <div class="crew-empty-text" v-if="crewAgents.length === 0">{{ $t('crewConfig.noCrewAgents') }}</div>
            <div class="crew-empty-text" v-else>{{ $t('crewConfig.selectAgentHint') }}</div>
          </div>
        </div>

        <div class="crew-config-footer" v-if="isEditMode || (selectedAgent && crewCheckState === 'none')">
          <template v-if="isEditMode">
            <span class="crew-config-hint" v-if="pendingNewRoles.length > 0">{{ $t('crewConfig.pendingRoles', { count: pendingNewRoles.length }) }}</span>
            <button class="modern-btn" @click="$emit('close')">{{ $t('crew.close') }}</button>
            <button class="modern-btn" @click="applyChanges">{{ $t('crewConfig.applyChanges') }}</button>
          </template>
          <template v-else>
            <button class="modern-btn" @click="$emit('close')">{{ $t('common.cancel') }}</button>
            <button class="modern-btn" @click="startSession" :disabled="!canStart">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              {{ $t('crewConfig.start') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  `,

  props: {
    defaultWorkDir: { type: String, default: '' },
    mode: { type: String, default: 'create' },
    session: { type: Object, default: null },
    status: { type: Object, default: null }
  },

  emits: ['close', 'start', 'browse'],

  setup() {
    const store = Pinia.useChatStore();
    return { store };
  },

  data() {
    return {
      selectedAgent: '',
      projectDir: this.defaultWorkDir || '',
      name: '',
      currentTemplate: 'dev',
      teamType: 'dev',
      roles: [],
      pendingRemovals: [],
      // .crew 检测状态: 'idle' | 'checking' | 'exists' | 'none'
      crewCheckState: 'idle',
      crewExistsSessionInfo: null,
      // 添加角色面板
      showBuiltinRolePicker: false,
      // 编辑模式下的并发数
      _editDevCount: 0,
      // 防抖定时器
      _checkDebounceTimer: null
    };
  },

  computed: {
    isEditMode() {
      return this.mode === 'edit' && this.session;
    },
    crewAgents() {
      return this.store.agents.filter(a => a.online && a.capabilities?.includes('crew'));
    },
    selectedAgentWorkDir() {
      if (!this.selectedAgent) return '';
      const agent = this.store.agents.find(a => a.id === this.selectedAgent);
      return agent?.workDir || '';
    },
    canStart() {
      return this.selectedAgent && this.projectDir.trim() && this.crewCheckState === 'none';
    },
    pendingNewRoles() {
      return this.roles.filter(r => r._isNew);
    },
    devCount() {
      const dev = this.roles.find(r => r.name === 'developer');
      return dev?.count > 1 ? dev.count : 1;
    },
    editDevCount() {
      return this._editDevCount || 1;
    },
    // 可选的内置角色（排除已添加的）
    availableBuiltinRoles() {
      const existingNames = new Set(this.roles.map(r => r.name));
      return BUILTIN_ROLES.filter(r => !existingNames.has(r.name));
    }
  },

  watch: {
    selectedAgent(newVal) {
      if (newVal && !this.projectDir) {
        this.projectDir = this.selectedAgentWorkDir;
      }
      // Agent 变更后触发 .crew 检测
      if (newVal && this.projectDir) {
        this.triggerCrewCheck();
      }
    },
    // 监听 store 中的检测结果
    'store.crewExistsResult'(result) {
      if (!result) return;
      // 确保是当前工作目录的结果
      if (result.projectDir === this.projectDir.trim()) {
        if (result.exists) {
          this.crewCheckState = 'exists';
          this.crewExistsSessionInfo = result.sessionInfo;
        } else {
          this.crewCheckState = 'none';
          this.crewExistsSessionInfo = null;
        }
      }
    }
  },

  created() {
    if (this.isEditMode) {
      this.name = this.session.name || '';
      this.projectDir = this.session.projectDir || '';
      this.roles = (this.session.roles || []).map(r => ({ ...r }));
      // Compute current dev count from expanded roles (dev-1, dev-2, ...)
      const devRoles = this.roles.filter(r => r.roleType === 'developer' || r.name === 'developer');
      this._editDevCount = devRoles.length || 1;
    } else {
      this.loadTemplate('dev');
      if (this.store.currentAgent) {
        const current = this.store.agents.find(a => a.id === this.store.currentAgent);
        if (current?.online && current?.capabilities?.includes('crew')) {
          this.selectedAgent = current.id;
        }
      }
      if (!this.selectedAgent && this.crewAgents.length > 0) {
        this.selectedAgent = this.crewAgents[0].id;
      }
    }
  },

  beforeUnmount() {
    if (this._checkDebounceTimer) {
      clearTimeout(this._checkDebounceTimer);
    }
  },

  methods: {
    onWorkDirChange() {
      if (this.selectedAgent && this.projectDir.trim()) {
        this.triggerCrewCheck();
      } else {
        this.crewCheckState = 'idle';
      }
    },

    triggerCrewCheck() {
      if (this._checkDebounceTimer) {
        clearTimeout(this._checkDebounceTimer);
      }
      this.crewCheckState = 'checking';
      this.crewExistsSessionInfo = null;
      this._checkDebounceTimer = setTimeout(() => {
        const dir = this.projectDir.trim();
        if (dir && this.selectedAgent) {
          this.store.checkCrewExists(dir, this.selectedAgent);
        }
      }, 300);
    },

    restoreFromDisk() {
      const agentId = this.selectedAgent;
      if (agentId) this.store.selectAgent(agentId);
      const sessionId = this.crewExistsSessionInfo?.sessionId;
      if (!sessionId) return;
      this.store.resumeCrewSession(sessionId, agentId);
      this.$emit('close');
    },

    deleteCrewDir() {
      if (!confirm(this.$t('crewConfig.confirmDeleteCrew'))) return;
      const dir = this.projectDir.trim();
      if (!dir || !this.selectedAgent) return;
      this.store.deleteCrewDir(dir, this.selectedAgent);
      this.crewCheckState = 'none';
      this.crewExistsSessionInfo = null;
    },

    formatSessionTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    shortenPath(p) {
      if (!p) return '';
      const home = '/home/';
      if (p.startsWith(home)) {
        const rest = p.slice(home.length);
        const slash = rest.indexOf('/');
        return slash >= 0 ? '~' + rest.slice(slash) : '~';
      }
      return p;
    },
    isExpandableRole(name) {
      // Roles that expand by dev count (dev-1..dev-N, rev-1..rev-N, etc).
      // TODO: replace this whitelist with an explicit `expandable: true` field
      // on BUILTIN_ROLES / templates so UI doesn't need to track role names.
      return ['developer', 'tester', 'reviewer', 'product-reviewer'].includes(name);
    },
    isFirstExpandableOfType(role, idx) {
      const type = role.roleType || role.name;
      if (!this.isExpandableRole(type)) return false;
      // Show concurrency UI only on the first role of this type
      return idx === this.roles.findIndex(r => (r.roleType || r.name) === type);
    },
    setDevCount(val) {
      const n = Math.max(1, Math.min(5, parseInt(val, 10) || 1));
      const dev = this.roles.find(r => r.name === 'developer');
      if (dev) dev.count = n;
    },
    setEditDevCount(val) {
      this._editDevCount = Math.max(1, Math.min(5, parseInt(val, 10) || 1));
    },
    loadTemplate(type) {
      this.currentTemplate = type;
      this.teamType = type === 'custom' ? 'discussion' : type;
      if (type === 'custom') {
        this.roles = [];
      } else {
        const locale = this.store.locale || 'zh-CN';
        const roles = getTemplate(type, locale);
        this.roles = roles ? roles.map(r => ({ ...r })) : [];
      }
    },

    addBuiltinRole(builtinRole) {
      const addOne = (role) => {
        if (this.roles.some(r => r.name === role.name)) return;
        this.roles.push({
          ...role,
          isDecisionMaker: this.roles.length === 0,
          _isNew: this.isEditMode
        });
      };
      addOne(builtinRole);
      if (builtinRole.bundleGroup) {
        const bundleRoles = BUILTIN_ROLES.filter(
          r => r.bundleGroup === builtinRole.bundleGroup && r.name !== builtinRole.name
        );
        for (const br of bundleRoles) {
          addOne(br);
        }
      }
      this.showBuiltinRolePicker = false;
    },

    addCustomRole() {
      const idx = this.roles.length + 1;
      this.roles.push({
        name: 'role' + idx,
        displayName: 'Role ' + idx,
        icon: '',
        description: '',
        claudeMd: '',
        isDecisionMaker: this.roles.length === 0,
        _isNew: this.isEditMode
      });
      this.showBuiltinRolePicker = false;
    },

    removeRole(idx) {
      const role = this.roles[idx];
      const wasDecisionMaker = role.isDecisionMaker;

      if (this.isEditMode && !role._isNew) {
        this.pendingRemovals.push(role.name);
      }

      this.roles.splice(idx, 1);
      if (wasDecisionMaker && this.roles.length > 0) {
        this.roles[0].isDecisionMaker = true;
      }
    },

    setDecisionMaker(idx) {
      this.roles.forEach((r, i) => { r.isDecisionMaker = (i === idx); });
    },

    startSession() {
      if (!this.canStart) return;
      this.store.selectAgent(this.selectedAgent);
      const roles = this.roles.map(r => ({
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
        displayName: r.displayName,
        icon: r.icon,
        description: r.description,
        claudeMd: r.claudeMd || '',
        model: r.model,
        isDecisionMaker: r.isDecisionMaker || false,
        count: r.count || 1
      }));
      this.$emit('start', {
        agentId: this.selectedAgent,
        projectDir: this.projectDir.trim(),
        sharedDir: '.crew',
        name: this.name.trim(),
        roles,
        teamType: this.teamType || 'dev',
        language: this.$locale?.value || 'zh-CN'
      });
    },

    applyChanges() {
      for (const name of this.pendingRemovals) {
        this.store.removeCrewRole(name);
      }
      for (const role of this.pendingNewRoles) {
        const { _isNew, ...roleData } = role;
        roleData.name = roleData.name || roleData.displayName.toLowerCase().replace(/\s+/g, '_');
        this.store.addCrewRole(roleData);
      }
      const sid = this.store.currentConversation;
      const trimmedName = this.name.trim();

      // Build roles config with updated concurrency count
      // De-duplicate expanded roles back to base roles for the update message
      const roleTypeMap = new Map();
      for (const r of this.roles) {
        const type = r.roleType || r.name;
        if (!roleTypeMap.has(type)) {
          roleTypeMap.set(type, {
            name: type,
            displayName: r.displayName.replace(/-\d+$/, ''),
            icon: r.icon,
            description: r.description,
            model: r.model,
            isDecisionMaker: r.isDecisionMaker || false,
            count: this.isExpandableRole(type) ? this._editDevCount : 1
          });
        }
      }
      const rolesConfig = Array.from(roleTypeMap.values());

      this.store.sendWsMessage({
        type: 'update_crew_session',
        sessionId: sid,
        name: trimmedName,
        roles: rolesConfig
      });
      // Update local state so sidebar title refreshes immediately
      const conv = this.store.conversations.find(c => c.id === sid);
      if (conv) conv.name = trimmedName;
      const cs = this.store.crewSessions[sid];
      if (cs) {
        cs.name = trimmedName;
      }
      this.pendingRemovals = [];
      this.roles.forEach(r => { delete r._isNew; });
      this.$emit('close');

      // Trigger session reload to pick up role changes
      this.store.setRefreshingSession(sid, true);
      this.store.startRefreshTimeout(sid);
      this.store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: sid,
        agentId: this.store.currentAgent
      });
    }
  }
};

// 内置角色列表 — 添加角色时优先展示
const BUILTIN_ROLES = [
  { name: 'pm', displayName: 'PM-乔布斯', icon: '', description: '需求分析，任务拆分和进度跟踪', claudeMd: '' },
  { name: 'developer', displayName: '开发者-托瓦兹', icon: '', description: '架构设计 + 代码实现', claudeMd: '', count: 1, bundleGroup: 'dev-bundle' },
  { name: 'reviewer', displayName: '审查者-马丁', icon: '', description: '代码审查和质量把控', claudeMd: '', bundleGroup: 'dev-bundle' },
  { name: 'tester', displayName: '测试-贝克', icon: '', description: '测试用例编写和质量验证', claudeMd: '', bundleGroup: 'dev-bundle' },
  { name: 'designer', displayName: '设计师-拉姆斯', icon: '', description: '用户交互设计和页面视觉设计', claudeMd: '' },
  { name: 'architect', displayName: '架构师-福勒', icon: '', description: '系统架构设计和技术决策', claudeMd: '' },
  { name: 'devops', displayName: '运维-凤凰', icon: '', description: 'CI/CD 流水线和部署管理', claudeMd: '' },
  { name: 'researcher', displayName: '研究员', icon: '', description: '技术调研和可行性分析', claudeMd: '' },
  { name: 'developer-cunningham', displayName: '开发者-Cunningham', icon: '', description: 'SQL Server 查询优化和执行引擎专家', claudeMd: '' },
  { name: 'developer-randal', displayName: '开发者-Randal', icon: '', description: 'SQL Server 存储引擎和数据库内核专家', claudeMd: '' },
  { name: 'reviewer-tripp', displayName: '审查者-Tripp', icon: '', description: 'SQL Server 性能审查和索引优化专家', claudeMd: '' },
  { name: 'developer-carmack', displayName: '开发者-卡马克', icon: '', description: '极致性能优化和底层编程', claudeMd: '' },
  { name: 'developer-gosling', displayName: '开发者-高斯林', icon: '', description: '工程化设计和跨平台架构', claudeMd: '' },
  { name: 'architect-knuth', displayName: '架构师-高德纳', icon: '', description: '算法分析和计算机科学理论', claudeMd: '' },
  { name: 'designer-norman', displayName: '设计师-诺曼', icon: '', description: '用户中心设计和认知心理学', claudeMd: '' },
  { name: 'tester-beck', displayName: '测试-肯特贝克', icon: '', description: '测试驱动开发和极限编程', claudeMd: '' },
  { name: 'researcher-feynman', displayName: '研究员-费曼', icon: '', description: '第一性原理分析和深入浅出解释', claudeMd: '' },
  { name: 'manager-musk', displayName: '管理者-马斯克', icon: '', description: '第一性原理思维，激进创新推动', claudeMd: '' },
  { name: 'manager-grove', displayName: '管理者-格鲁夫', icon: '', description: '目标导向管理，危机应对决策', claudeMd: '' },
  { name: 'strategist-munger', displayName: '策略师-芒格', icon: '', description: '多元思维模型和跨学科分析', claudeMd: '' },
  { name: 'strategist-buffett', displayName: '策略师-巴菲特', icon: '', description: '价值投资和长期主义', claudeMd: '' },
  { name: 'analyst-simons', displayName: '分析师-西蒙斯', icon: '', description: '量化模型和数据驱动决策', claudeMd: '' },
  { name: 'writer-orwell', displayName: '写作-奥威尔', icon: '', description: '简洁有力的写作风格', claudeMd: '' },
  { name: 'writer', displayName: '写作-Procida', icon: '', description: '技术文档和 API 文档编写', claudeMd: '' },
  { name: 'strategist-sunzi', displayName: '策略师-孙子', icon: '', description: '兵法策略和博弈思维', claudeMd: '' }
];
