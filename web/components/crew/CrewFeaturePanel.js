/**
 * CrewFeaturePanel — Right sidebar: Feature Kanban board + message view.
 *
 * Two modes:
 *   1. List mode (default): narrow panel showing compact feature cards.
 *      Each card has a fixed two-line layout (title + progress + elapsed,
 *      then latest message summary). Click any card to enter expanded mode.
 *   2. Expanded mode: panel widens to 50% width. Shows todo list at top,
 *      followed by full message thread using CrewTurnRenderer.
 */
import {
  formatDuration, formatTime, getRoleStyle as getRoleStyleFn, shortName
} from './crewHelpers.js';
import {
  shouldShowTurnDivider, getMaxRound
} from './crewMessageGrouping.js';
import CrewTurnRenderer from './CrewTurnRenderer.js';

export default {
  name: 'CrewFeaturePanel',
  components: { CrewTurnRenderer },
  props: {
    store: { type: Object, required: true },
    featureKanban: { type: Array, required: true },
    featureKanbanGrouped: { type: Object, required: true },
    kanbanProgressData: { type: Object, required: true },
    featureBlocks: { type: Array, default: () => [] },
    getBlockTurns: { type: Function, default: () => [] },
    expandedTurns: { type: Object, default: () => ({}) },
    expandedFeatureTaskId: { type: String, default: null },
    nowTick: { type: Number, required: true },
    icons: { type: Object, required: true },
    roleColorMap: { type: Object, default: () => ({}) },
    getRoleDisplayName: { type: Function, default: (name) => name },
    persistedFeatureIds: { type: Set, default: () => new Set() },
    crewMessages: { type: Array, default: () => [] }
  },
  emits: ['toggle-turn', 'expand-feature', 'close-feature', 'ask-submit'],
  data() {
    return {
      showCompletedFeatures: false,
      showRouteActivity: true,
      expandedVisibleCount: 20
    };
  },
  watch: {
    expandedFeatureTaskId(newVal) {
      // Reset pagination when switching features
      this.expandedVisibleCount = 20;
      if (newVal) {
        this.$nextTick(() => {
          const scrollEl = this.$el?.querySelector('.crew-panel-right-scroll');
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
      }
    }
  },
  computed: {
    expandedBlock() {
      if (!this.expandedFeatureTaskId) return null;
      return this.featureBlocks.find(
        b => b.type === 'feature' && b.taskId === this.expandedFeatureTaskId
      ) || null;
    },
    expandedTurnsList() {
      if (!this.expandedBlock) return [];
      const allTurns = this.getBlockTurns(this.expandedBlock);
      if (!allTurns || allTurns.length <= this.expandedVisibleCount) return allTurns;
      // Show only the last N turns (latest messages visible by default)
      return allTurns.slice(allTurns.length - this.expandedVisibleCount);
    },
    expandedHasMoreTurns() {
      if (!this.expandedBlock) return false;
      const allTurns = this.getBlockTurns(this.expandedBlock);
      return allTurns && allTurns.length > this.expandedVisibleCount;
    },
    expandedFeatureTitle() {
      if (!this.expandedFeatureTaskId) return '';
      if (this.expandedBlock) return this.expandedBlock.taskTitle || this.expandedFeatureTaskId;
      // No message block — fall back to kanban feature title
      const feature = this.featureKanban.find(f => f.taskId === this.expandedFeatureTaskId);
      return feature?.taskTitle || this.expandedFeatureTaskId;
    },
    expandedFeatureTodos() {
      if (!this.expandedFeatureTaskId) return [];
      const feature = this.featureKanban.find(f => f.taskId === this.expandedFeatureTaskId);
      return feature ? feature.todos : [];
    },
    // Show features that have signals (messages, todos, streaming, activity).
    // Filter out empty shells (0/0, no messages, no activity) from old history.
    filteredFeatures() {
      const _blocks = this.featureBlocks; // explicit dependency for Vue reactivity
      return [...this.featureKanban]
        .filter(f => {
          // Persisted on Agent — always show (messages may be in shard files, not in memory)
          if (this.persistedFeatureIds.has(f.taskId)) return true;
          // Has messages — always show (core fix from v0.1.179)
          if (this.hasFeatureMessages(f.taskId)) return true;
          // Has todo progress — keep
          if (f.totalCount > 0) return true;
          // Currently streaming — keep
          if (f.hasStreaming) return true;
          // Has activity record — keep
          if (f.lastActivityAt > 0) return true;
          // Empty shell — filter out
          return false;
        })
        .sort((a, b) => {
          const aHas = this.hasFeatureMessages(a.taskId) ? 1 : 0;
          const bHas = this.hasFeatureMessages(b.taskId) ? 1 : 0;
          if (aHas !== bHas) return bHas - aHas;
          return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
        });
    },
    filteredInProgress() {
      return this.filteredFeatures.filter(f => !this.isFeatureCompleted(f));
    },
    filteredCompleted() {
      return this.filteredFeatures.filter(f => this.isFeatureCompleted(f));
    },
    // Recent route events from crewMessages (last 8)
    recentRoutes() {
      const routes = [];
      for (let i = this.crewMessages.length - 1; i >= 0 && routes.length < 8; i--) {
        const m = this.crewMessages[i];
        if (m.type === 'route') {
          routes.push(m);
        }
      }
      return routes;
    }
  },
  template: `
    <aside class="crew-panel-right">
      <div class="crew-panel-right-scroll">
        <button class="crew-mobile-close" @click="store.crewMobilePanel = null"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> {{ $t('crew.close') }}</button>

        <!-- ===== EXPANDED MODE: Full message thread for a feature ===== -->
        <template v-if="expandedFeatureTaskId">
          <div class="crew-feature-expanded-header">
            <button class="crew-feature-expanded-back" @click="$emit('close-feature')">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <span class="crew-feature-expanded-title">{{ expandedFeatureTitle }}</span>
          </div>
          <div v-if="expandedFeatureTodos.length > 0" class="crew-feature-card-todos">
            <div v-for="todo in expandedFeatureTodos" :key="todo.id"
                 class="crew-feature-card-todo" :class="'is-' + todo.status">
              <span class="todo-status">
                <svg v-if="todo.status === 'completed'" viewBox="0 0 24 24" width="12" height="12">
                  <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              </span>
              <span class="todo-text">
                {{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}
              </span>
              <span v-if="todo.roleIcon" class="todo-role">{{ todo.roleIcon }}</span>
            </div>
          </div>
          <div class="crew-feature-expanded-messages">
            <template v-if="expandedTurnsList.length > 0">
              <div v-if="expandedHasMoreTurns" class="crew-load-older" @click="expandedVisibleCount += 20">
                {{ $t('crew.loadOlder') }}
              </div>
              <template v-for="(turn, tidx) in expandedTurnsList" :key="turn.id">
                <div v-if="tidx > 0 && shouldShowTurnDivider(expandedTurnsList, tidx)" class="crew-turn-divider"></div>
                <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                  <div class="crew-round-line"></div>
                  <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                  <div class="crew-round-line"></div>
                </div>
                <crew-turn-renderer
                  :turn="turn"
                  :show-human-bubble="true"
                  :expanded-turns="expandedTurns"
                  :icons="icons"
                  :role-color-map="roleColorMap"
                  :get-role-display-name="getRoleDisplayName"
                  @toggle-turn="$emit('toggle-turn', $event)"
                  @ask-submit="(rid, ans) => $emit('ask-submit', rid, ans)"
                />
              </template>
            </template>
            <div v-else class="crew-feature-card-empty">
              {{ $t('crew.noMessages') }}
            </div>
          </div>
        </template>

        <!-- ===== LIST MODE: Feature cards with active/completed groups ===== -->
        <template v-else>
          <!-- Route Activity -->
          <div v-if="recentRoutes.length > 0" class="crew-route-activity">
            <div class="crew-route-activity-header" @click="showRouteActivity = !showRouteActivity">
              <svg class="crew-route-activity-chevron" :class="{ 'is-expanded': showRouteActivity }" viewBox="0 0 24 24" width="12" height="12">
                <path fill="currentColor" d="M10 6l6 6-6 6z"/>
              </svg>
              <span class="crew-route-activity-title">{{ $t('crew.routeActivity') }}</span>
              <span class="crew-route-activity-count">({{ recentRoutes.length }})</span>
            </div>
            <div v-if="showRouteActivity" class="crew-route-activity-list">
              <div v-for="r in recentRoutes" :key="r.id || r.timestamp" class="crew-route-activity-item">
                <div class="crew-route-activity-task-line">{{ r.taskTitle || $t('crew.globalTask') }}</div>
                <div class="crew-route-activity-route-line">
                  <span v-if="r.roleIcon" class="crew-route-activity-icon">{{ r.roleIcon }}</span>
                  <span class="crew-route-activity-from">{{ shortNameFn(r.roleName) }}</span>
                  <span class="crew-route-activity-arrow">&rarr;</span>
                  <span class="crew-route-activity-to">{{ r.routeTo }}</span>
                  <span class="crew-route-activity-time">{{ formatTime(r.timestamp) }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="filteredInProgress.length > 0" class="crew-kanban-group">
            <div class="crew-kanban-group-header is-active">
              <span class="crew-kanban-group-dot is-active"></span>
              {{ $t('crew.statusInProgress') }} ({{ filteredInProgress.length }})
            </div>
            <div v-for="feature in filteredInProgress" :key="feature.taskId"
                 class="crew-feature-card"
                 :class="{ 'has-streaming': feature.hasStreaming, 'is-empty': !hasFeatureMessages(feature.taskId) }"
                 @click="$emit('expand-feature', feature.taskId)">
              <div class="crew-feature-card-header">
                <span class="crew-feature-card-title">{{ feature.taskTitle }}</span>
                <span class="crew-feature-card-count">
                  {{ feature.doneCount }} / {{ feature.totalCount }}
                </span>
                <span v-if="feature.createdAt" class="crew-feature-card-elapsed">{{ $t('crew.elapsed', { duration: formatDuration(nowTick - feature.createdAt) }) }}</span>
              </div>
              <div class="crew-feature-card-bar">
                <div class="crew-feature-card-bar-fill"
                     :style="{ width: (feature.totalCount > 0 ? (feature.doneCount / feature.totalCount * 100) : 0) + '%' }">
                </div>
              </div>
              <div v-if="getSummary(feature.taskId)" class="crew-feature-card-summary">
                <div class="crew-feature-summary-meta">
                  <span v-if="getSummary(feature.taskId).icon" class="crew-feature-summary-icon">{{ getSummary(feature.taskId).icon }}</span>
                  <span class="crew-feature-summary-role" :style="getRoleStyle(getSummary(feature.taskId).role)">{{ getSummary(feature.taskId).roleName }}</span>
                  <span class="crew-feature-summary-time">{{ getSummary(feature.taskId).time }}</span>
                </div>
                <div class="crew-feature-summary-text">{{ getSummary(feature.taskId).text }}</div>
                <div v-if="getSummary(feature.taskId).actions.length > 0" class="crew-feature-summary-actions">
                  <span class="crew-feature-summary-actions-count">{{ getSummary(feature.taskId).actions.length }} actions</span>
                  <span class="crew-feature-summary-actions-list">{{ getSummary(feature.taskId).actions.join(', ') }}</span>
                </div>
              </div>
              <div v-if="getFeatureRoutes(feature.taskId).length > 0" class="crew-feature-route-pipeline">
                <template v-for="(r, ri) in getFeatureRoutes(feature.taskId)" :key="r.id || ri">
                  <span v-if="ri > 0" class="crew-route-step-arrow">&rarr;</span>
                  <span class="crew-route-step">
                    <span v-if="r.roleIcon" class="crew-route-step-icon">{{ r.roleIcon }}</span>
                    <span class="crew-route-step-name">{{ shortNameFn(r.roleName) }}</span>
                  </span>
                </template>
                <span class="crew-route-step-arrow">&rarr;</span>
                <span class="crew-route-step">
                  <span class="crew-route-step-name">{{ getFeatureRoutes(feature.taskId).slice(-1)[0]?.routeTo }}</span>
                </span>
              </div>
            </div>
          </div>

          <div v-if="filteredCompleted.length > 0" class="crew-kanban-group">
            <div class="crew-kanban-group-header is-completed" @click="showCompletedFeatures = !showCompletedFeatures">
              <svg class="crew-kanban-group-chevron" :class="{ 'is-expanded': showCompletedFeatures }" viewBox="0 0 24 24" width="12" height="12">
                <path fill="currentColor" d="M10 6l6 6-6 6z"/>
              </svg>
              <span class="crew-kanban-group-dot is-completed"></span>
              {{ $t('crew.statusCompleted') }} ({{ filteredCompleted.length }})
            </div>
            <template v-if="showCompletedFeatures">
              <div v-for="feature in filteredCompleted" :key="feature.taskId"
                   class="crew-feature-card is-completed"
                   @click="$emit('expand-feature', feature.taskId)">
                <div class="crew-feature-card-header">
                  <span class="crew-feature-card-title">{{ feature.taskTitle }}</span>
                  <span class="crew-feature-card-count">
                    {{ feature.doneCount }} / {{ feature.totalCount }}
                  </span>
                  <span v-if="feature.createdAt && feature.lastActivityAt" class="crew-feature-card-elapsed">{{ $t('crew.elapsed', { duration: formatDuration(feature.lastActivityAt - feature.createdAt) }) }}</span>
                </div>
                <div class="crew-feature-card-bar">
                  <div class="crew-feature-card-bar-fill"
                       :style="{ width: (feature.totalCount > 0 ? (feature.doneCount / feature.totalCount * 100) : 0) + '%' }">
                  </div>
                </div>
                <div v-if="getSummary(feature.taskId)" class="crew-feature-card-summary">
                  <div class="crew-feature-summary-meta">
                    <span v-if="getSummary(feature.taskId).icon" class="crew-feature-summary-icon">{{ getSummary(feature.taskId).icon }}</span>
                    <span class="crew-feature-summary-role" :style="getRoleStyle(getSummary(feature.taskId).role)">{{ getSummary(feature.taskId).roleName }}</span>
                    <span class="crew-feature-summary-time">{{ getSummary(feature.taskId).time }}</span>
                  </div>
                  <div class="crew-feature-summary-text">{{ getSummary(feature.taskId).text }}</div>
                  <div v-if="getSummary(feature.taskId).actions.length > 0" class="crew-feature-summary-actions">
                    <span class="crew-feature-summary-actions-count">{{ getSummary(feature.taskId).actions.length }} actions</span>
                    <span class="crew-feature-summary-actions-list">{{ getSummary(feature.taskId).actions.join(', ') }}</span>
                  </div>
                </div>
                <div v-if="getFeatureRoutes(feature.taskId).length > 0" class="crew-feature-route-pipeline">
                  <template v-for="(r, ri) in getFeatureRoutes(feature.taskId)" :key="r.id || ri">
                    <span v-if="ri > 0" class="crew-route-step-arrow">&rarr;</span>
                    <span class="crew-route-step">
                      <span v-if="r.roleIcon" class="crew-route-step-icon">{{ r.roleIcon }}</span>
                      <span class="crew-route-step-name">{{ shortNameFn(r.roleName) }}</span>
                    </span>
                  </template>
                  <span class="crew-route-step-arrow">&rarr;</span>
                  <span class="crew-route-step">
                    <span class="crew-route-step-name">{{ getFeatureRoutes(feature.taskId).slice(-1)[0]?.routeTo }}</span>
                  </span>
                </div>
              </div>
            </template>
          </div>

          <!-- Empty state -->
          <div v-if="featureKanban.length === 0" class="crew-kanban-empty">
            <div class="crew-kanban-empty-text">{{ $t('crew.noFeatures') }}</div>
          </div>
        </template>
      </div>
    </aside>
  `,
  methods: {
    formatDuration,
    formatTime,
    shortNameFn: shortName,
    getRoleStyle(roleName) {
      return getRoleStyleFn(roleName, this.roleColorMap[roleName]);
    },
    shouldShowTurnDivider,
    getMaxRound,

    /**
     * Get the last 3 route events for a specific task (for per-feature pipeline).
     */
    getFeatureRoutes(taskId) {
      const routes = [];
      for (let i = this.crewMessages.length - 1; i >= 0 && routes.length < 3; i--) {
        const m = this.crewMessages[i];
        if (m.type === 'route' && m.taskId === taskId) {
          routes.unshift(m); // keep chronological order
        }
      }
      return routes;
    },

    /**
     * Check if a feature has any messages (used to hide empty features).
     */
    hasFeatureMessages(taskId) {
      const block = this.featureBlocks.find(
        b => b.type === 'feature' && b.taskId === taskId
      );
      if (!block) return false;
      const turns = this.getBlockTurns(block);
      return turns && turns.length > 0;
    },

    /**
     * Detect if a feature is completed by scanning its messages for merge/tag keywords.
     * A feature is "completed" when its latest PM message mentions merging or tagging.
     */
    isFeatureCompleted(feature) {
      // If actively streaming, definitely not completed
      if (feature.hasStreaming) return false;

      const block = this.featureBlocks.find(
        b => b.type === 'feature' && b.taskId === feature.taskId
      );
      if (!block) return false;
      const turns = this.getBlockTurns(block);
      if (!turns || turns.length === 0) return false;

      // Find the LAST merge/completion message from decision maker.
      // Then check if any text messages came after it — if so, feature was reactivated.
      const MERGE_PATTERN = /(?:已\s*(?:合并|merge)|squash\s*merge|PR\s*#\d+\s*已|tag\s+v[\d.]+\s*已|已\s*push|merged\s+to\s+main|已\s*完成)/i;
      let lastMergeIdx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        const msg = turn.textMsg || turn.message;
        if (!msg || !msg.content) continue;
        if (msg.isDecisionMaker && MERGE_PATTERN.test(msg.content)) {
          lastMergeIdx = i;
          break;
        }
      }
      if (lastMergeIdx === -1) return false;

      // Check if any text messages exist after the merge message — reactivation
      for (let i = lastMergeIdx + 1; i < turns.length; i++) {
        const turn = turns[i];
        const msg = turn.textMsg || turn.message;
        if (msg && msg.content) return false; // reactivated
      }
      return true;
    },

    /**
     * Cached accessor for getLatestMessageSummary — avoids calling it 4x per card in template.
     * Cache invalidated via featureBlocks reference identity.
     */
    getSummary(taskId) {
      if (!this._summaryCache || this._summaryCacheRef !== this.featureBlocks) {
        this._summaryCache = {};
        this._summaryCacheRef = this.featureBlocks;
      }
      if (taskId in this._summaryCache) return this._summaryCache[taskId];
      const result = this.getLatestMessageSummary(taskId);
      this._summaryCache[taskId] = result;
      return result;
    },

    /**
     * Get latest message summary for a feature card (list mode).
     * Returns { icon, roleName, role, text, time, actions } or null if no text message exists.
     */
    getLatestMessageSummary(taskId) {
      const block = this.featureBlocks.find(
        b => b.type === 'feature' && b.taskId === taskId
      );
      if (!block) return null;
      const turns = this.getBlockTurns(block);
      if (!turns || turns.length === 0) return null;

      // Walk backward through turns to find the latest visible content (text or route)
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (turn.type === 'turn') {
          if (turn.textMsg) {
            const timestamp = turn.messages?.[0]?.timestamp || turn.textMsg.timestamp;
            const rawRole = turn.role || turn.roleName || '';
            const actions = (turn.toolMsgs || []).map(t => t.toolName).filter(Boolean);
            return {
              icon: turn.roleIcon || '',
              roleName: this.getRoleDisplayName(rawRole),
              role: rawRole,
              text: this.truncateText(turn.textMsg.content, 80),
              time: timestamp ? formatTime(timestamp) : '',
              actions
            };
          }
          // Route-only turn — show the route summary as card text
          if (turn.routeMsgs && turn.routeMsgs.length > 0) {
            const rm = turn.routeMsgs[turn.routeMsgs.length - 1];
            const rawRole = turn.role || turn.roleName || '';
            return {
              icon: turn.roleIcon || '',
              roleName: this.getRoleDisplayName(rawRole),
              role: rawRole,
              text: `→ ${this.getRoleDisplayName(rm.routeTo)}: ${this.truncateText(rm.routeSummary, 60)}`,
              time: rm.timestamp ? formatTime(rm.timestamp) : '',
              actions: []
            };
          }
        }
        if (turn.type !== 'turn' && turn.message?.type === 'text') {
          const rawRole = turn.message.role || turn.message.roleName || '';
          return {
            icon: turn.message.roleIcon || '',
            roleName: this.getRoleDisplayName(rawRole),
            role: rawRole,
            text: this.truncateText(turn.message.content, 80),
            time: turn.message.timestamp ? formatTime(turn.message.timestamp) : '',
            actions: []
          };
        }
      }
      return null;
    },

    truncateText(text, maxLen) {
      if (!text) return '';
      // Strip markdown, take first line
      const clean = text.replace(/[#*_`~\[\]]/g, '').trim();
      const firstLine = clean.split('\n')[0];
      if (firstLine.length <= maxLen) return firstLine;
      return firstLine.substring(0, maxLen) + '\u2026';
    }
  }
};
