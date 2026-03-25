/**
 * ConductorConfigPanel — Conductor V2 创建配置面板
 *
 * 交互流程:
 *   1. 场景卡片选择 (Dev / Writing / Trading / Video)
 *   2. Agent 选择
 *   3. 确认创建 → emit('start', config)
 *
 * 设计要点:
 *   - 居中 modal 弹窗
 *   - 4 场景卡片 + persona 预览（头像/名字）
 *   - 不需要预先选择工作路径（Conductor 是持久对话，路径在运行时动态绑定）
 */
import { scenarioList, getScenario } from '../../conductor-templates/index.js';

export default {
  name: 'ConductorConfigPanel',
  template: `
    <div class="conductor-config-overlay" @click.self="$emit('close')">
      <div class="conductor-config-panel">
        <!-- Header -->
        <div class="conductor-config-header">
          <h2>New Conductor</h2>
          <button class="conductor-config-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="conductor-config-body">
          <!-- Step 1: Scenario Selection -->
          <div class="conductor-config-section">
            <label class="conductor-config-label">场景</label>
            <div class="conductor-scenario-grid">
              <div
                v-for="scenario in scenarios"
                :key="scenario.id"
                class="conductor-scenario-card"
                :class="{ active: selectedScenario === scenario.id }"
                :style="{ '--scenario-color': scenario.color }"
                @click="selectScenario(scenario.id)"
              >
                <div class="scenario-card-icon">{{ scenario.icon }}</div>
                <div class="scenario-card-info">
                  <div class="scenario-card-name">{{ scenario.displayName }}</div>
                  <div class="scenario-card-desc">{{ scenario.description }}</div>
                </div>
                <svg v-if="selectedScenario === scenario.id" class="scenario-card-check" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
              </div>
            </div>
          </div>

          <!-- Persona Preview (shown after scenario selected) -->
          <div class="conductor-config-section" v-if="selectedScenarioData">
            <label class="conductor-config-label">人物池 <span class="conductor-label-hint">{{ selectedScenarioData.personas.length }} 人</span></label>
            <div class="conductor-persona-preview">
              <div
                v-for="persona in selectedScenarioData.personas"
                :key="persona.id"
                class="conductor-persona-chip"
                :title="persona.name + ' — ' + persona.description"
              >
                <span class="persona-chip-name">{{ persona.displayName }}</span>
                <span class="persona-chip-tags">
                  <span v-for="s in persona.specialties" :key="s" class="persona-chip-tag">{{ getSpecialtyName(s) }}</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Step 2: Agent Selection -->
          <div class="conductor-config-section" v-if="selectedScenario">
            <label class="conductor-config-label">Agent</label>
            <div class="crew-select-wrapper">
              <select class="crew-config-select" v-model="selectedAgent">
                <option value="">选择 Agent</option>
                <option v-for="agent in conductorAgents" :key="agent.id" :value="agent.id">
                  {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                </option>
              </select>
              <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            </div>
          </div>

          <!-- Empty state: no agents -->
          <div class="conductor-empty-state" v-if="conductorAgents.length === 0">
            <div class="conductor-empty-icon">
              <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
            </div>
            <div class="conductor-empty-text">没有在线的 Agent，请先启动一个 Agent</div>
          </div>
        </div>

        <!-- Footer -->
        <div class="conductor-config-footer" v-if="selectedScenario">
          <button class="modern-btn" @click="$emit('close')">取消</button>
          <button class="modern-btn conductor-start-btn" @click="startConductor" :disabled="!canStart">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
            创建 Conductor
          </button>
        </div>
      </div>
    </div>
  `,

  emits: ['close', 'start'],

  setup() {
    const store = Pinia.useChatStore();
    return { store };
  },

  data() {
    return {
      scenarios: scenarioList,
      selectedScenario: '',
      selectedAgent: '',
    };
  },

  computed: {
    conductorAgents() {
      // Conductor uses the same agent capability as crew for now
      return this.store.agents.filter(a => a.online && a.capabilities?.includes('crew'));
    },
    selectedScenarioData() {
      if (!this.selectedScenario) return null;
      return getScenario(this.selectedScenario);
    },
    canStart() {
      return this.selectedScenario && this.selectedAgent;
    },
  },

  watch: {
    conductorAgents: {
      handler(agents) {
        // Auto-select first agent if only one available
        if (agents.length === 1 && !this.selectedAgent) {
          this.selectedAgent = agents[0].id;
        }
      },
      immediate: true,
    },
  },

  methods: {
    selectScenario(scenarioId) {
      this.selectedScenario = scenarioId;
    },
    getSpecialtyName(specialtyId) {
      if (!this.selectedScenarioData) return specialtyId;
      const s = this.selectedScenarioData.specialties.find(sp => sp.id === specialtyId);
      return s ? s.name : specialtyId;
    },
    startConductor() {
      if (!this.canStart) return;
      this.$emit('start', {
        scenario: this.selectedScenario,
        agentId: this.selectedAgent,
      });
    },
  },
};
