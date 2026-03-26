/**
 * ConductorActivePanel — Right-side panel showing task kanban.
 *
 * Dual-column layout aligned with CrewFeaturePanel:
 *   - "In Progress" group: active/executing/planning tasks
 *   - "Completed" group: completed tasks (collapsed by default)
 *
 * Each task card shows:
 *   - Task title
 *   - workDir short path + scenario label
 *   - Progress bar (step-based)
 *   - Instance (actor) count
 *   - Click → emits 'open-task' to open ConductorTaskPanel
 */
import ActorCard from './ActorCard.js';

export default {
  name: 'ConductorActivePanel',
  components: { ActorCard },
  props: {
    store: { type: Object, required: true },
    sessionId: { type: String, default: null },
    tasks: { type: Object, default: () => ({}) },
    actors: { type: Object, default: () => ({}) },
    selectedTaskId: { type: String, default: null }
  },
  emits: ['open-task'],
  data() {
    return {
      showCompletedTasks: false
    };
  },
  template: `
    <aside class="conductor-active-panel">
      <div class="conductor-active-panel-scroll">
        <!-- Header -->
        <div class="conductor-active-header">
          <span class="conductor-active-title">{{ $t('conductor.panelTitle') }}</span>
          <span class="conductor-active-count">{{ $t('conductor.panelActive', { count: activeTaskCount }) }}</span>
        </div>

        <!-- In Progress group -->
        <div v-if="inProgressTasks.length > 0" class="crew-kanban-group">
          <div class="crew-kanban-group-header is-active">
            <span class="crew-kanban-group-dot is-active"></span>
            {{ $t('conductor.statusInProgress') }} ({{ inProgressTasks.length }})
          </div>
          <div v-for="task in inProgressTasks" :key="task.taskId"
               class="crew-feature-card"
               :class="{
                 'is-selected': task.taskId === selectedTaskId
               }"
               @click="$emit('open-task', task.taskId)">
            <div class="crew-feature-card-header">
              <span class="crew-feature-card-title">{{ task.title || task.taskId }}</span>
              <span class="crew-feature-card-count" v-if="taskActorCount(task.taskId) > 0">
                {{ taskActorCount(task.taskId) }} <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              </span>
            </div>
            <div class="conductor-task-card-meta" v-if="task.workDir || task.scenario">
              <span class="conductor-task-card-workdir" v-if="task.workDir" :title="task.workDir">{{ shortenPath(task.workDir) }}</span>
              <span class="conductor-task-card-scenario" v-if="task.scenario">{{ task.scenario }}</span>
            </div>
            <div class="crew-feature-card-bar">
              <div class="crew-feature-card-bar-fill"
                   :class="{ 'is-indeterminate': task.progress === -1 }"
                   :style="{ width: progressWidth(task) }">
              </div>
            </div>
            <div v-if="taskActors(task.taskId).length > 0" class="conductor-task-actors">
              <actor-card
                v-for="actor in taskActors(task.taskId)"
                :key="actor.key"
                :actor="actor"
                :compact="true"
              />
            </div>
          </div>
        </div>

        <!-- Completed group (collapsed by default) -->
        <div v-if="completedTasks.length > 0" class="crew-kanban-group">
          <div class="crew-kanban-group-header is-completed" @click="showCompletedTasks = !showCompletedTasks">
            <svg class="crew-kanban-group-chevron" :class="{ 'is-expanded': showCompletedTasks }" viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M10 6l6 6-6 6z"/>
            </svg>
            <span class="crew-kanban-group-dot is-completed"></span>
            {{ $t('conductor.showCompleted', { count: completedTasks.length }) }}
          </div>
          <template v-if="showCompletedTasks">
            <div v-for="task in completedTasks" :key="task.taskId"
                 class="crew-feature-card is-completed"
                 :class="{ 'is-selected': task.taskId === selectedTaskId }"
                 @click="$emit('open-task', task.taskId)">
              <div class="crew-feature-card-header">
                <span class="crew-feature-card-title">{{ task.title || task.taskId }}</span>
              </div>
              <div class="conductor-task-card-meta" v-if="task.workDir || task.scenario">
                <span class="conductor-task-card-workdir" v-if="task.workDir" :title="task.workDir">{{ shortenPath(task.workDir) }}</span>
                <span class="conductor-task-card-scenario" v-if="task.scenario">{{ task.scenario }}</span>
              </div>
              <div class="crew-feature-card-bar">
                <div class="crew-feature-card-bar-fill" style="width: 100%"></div>
              </div>
            </div>
          </template>
        </div>

        <!-- Empty state -->
        <div v-if="sortedTasks.length === 0" class="conductor-active-empty">
          <div class="conductor-active-empty-icon">
            <svg viewBox="0 0 24 24" width="28" height="28"><path fill="var(--text-muted)" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM17.99 9l-1.41-1.42-6.59 6.59-2.58-2.57-1.42 1.41 4 3.99z"/></svg>
          </div>
          <div class="conductor-active-empty-text">{{ $t('conductor.emptyNoTasks') }}</div>
          <div class="conductor-active-empty-hint">{{ $t('conductor.emptyNoTasksHint') }}</div>
        </div>
      </div>
    </aside>
  `,
  computed: {
    sortedTasks() {
      const entries = Object.values(this.tasks || {});
      return [...entries].sort((a, b) => {
        const statusOrder = { active: 0, executing: 0, planning: 1, waiting: 2, completed: 3 };
        const aOrder = statusOrder[a.status] ?? 1;
        const bOrder = statusOrder[b.status] ?? 1;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    },
    inProgressTasks() {
      return this.sortedTasks.filter(t => t.status !== 'completed');
    },
    completedTasks() {
      return this.sortedTasks.filter(t => t.status === 'completed');
    },
    activeTaskCount() {
      return Object.values(this.tasks || {}).filter(
        t => t.status === 'active' || t.status === 'executing' || t.status === 'planning'
      ).length;
    }
  },
  methods: {
    shortenPath(path) {
      if (!path) return '';
      const parts = path.replace(/\\/g, '/').split('/');
      if (parts.length <= 2) return path;
      return '~/' + parts.slice(-2).join('/');
    },
    taskActors(taskId) {
      return Object.values(this.actors || {}).filter(a => a.taskId === taskId);
    },
    taskActorCount(taskId) {
      return this.taskActors(taskId).length;
    },
    progressWidth(task) {
      if (task.progress === -1) return '100%';
      if (task.progress >= 0) return Math.min(task.progress, 100) + '%';
      if (task.plan && task.plan.length > 0) {
        const done = task.plan.filter(s => s.status === 'done' || s.status === 'completed').length;
        return (done / task.plan.length * 100) + '%';
      }
      return '0%';
    }
  }
};
