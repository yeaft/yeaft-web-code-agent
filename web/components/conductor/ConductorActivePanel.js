/**
 * ConductorActivePanel — Right-side panel showing task list.
 *
 * Each task card shows:
 *   - Task title
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
  template: `
    <aside class="conductor-active-panel">
      <div class="conductor-active-panel-scroll">
        <!-- Header -->
        <div class="conductor-active-header">
          <span class="conductor-active-title">Tasks</span>
          <span class="conductor-active-count">{{ activeTaskCount }} active</span>
        </div>

        <!-- Task Cards -->
        <div v-if="sortedTasks.length > 0" class="conductor-task-list">
          <div v-for="task in sortedTasks" :key="task.taskId"
               class="conductor-task-card"
               :class="{
                 'is-active': task.status === 'active' || task.status === 'executing',
                 'is-completed': task.status === 'completed',
                 'is-selected': task.taskId === selectedTaskId
               }"
               @click="$emit('open-task', task.taskId)">
            <!-- Task header: title + instance count -->
            <div class="conductor-task-card-header">
              <span class="conductor-task-card-title">{{ task.title || task.taskId }}</span>
              <span class="conductor-task-card-instances" v-if="taskActorCount(task.taskId) > 0">
                {{ taskActorCount(task.taskId) }} <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              </span>
            </div>

            <!-- workDir + scenario meta -->
            <div class="conductor-task-card-meta" v-if="task.workDir || task.scenario">
              <span class="conductor-task-card-workdir" v-if="task.workDir" :title="task.workDir">{{ shortenPath(task.workDir) }}</span>
              <span class="conductor-task-card-scenario" v-if="task.scenario">{{ task.scenario }}</span>
            </div>

            <!-- Progress bar -->
            <div class="conductor-task-card-bar">
              <div class="conductor-task-card-bar-fill"
                   :class="{ 'is-indeterminate': task.progress === -1 }"
                   :style="{ width: progressWidth(task) }">
              </div>
            </div>

            <!-- Actor pills (compact) -->
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

        <!-- Empty state -->
        <div v-else class="conductor-active-empty">
          <div class="conductor-active-empty-icon">📋</div>
          <div class="conductor-active-empty-text">No active tasks</div>
          <div class="conductor-active-empty-hint">Send a request to the Conductor to create tasks</div>
        </div>
      </div>
    </aside>
  `,
  computed: {
    sortedTasks() {
      const entries = Object.values(this.tasks || {});
      // Active tasks first, then by creation time (newest first)
      return [...entries].sort((a, b) => {
        const statusOrder = { active: 0, executing: 0, planning: 1, waiting: 2, completed: 3 };
        const aOrder = statusOrder[a.status] ?? 1;
        const bOrder = statusOrder[b.status] ?? 1;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
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
      // Show last 2 segments: parent/project
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
      if (task.progress === -1) return '100%'; // indeterminate
      if (task.progress >= 0) return Math.min(task.progress, 100) + '%';
      // Fallback: compute from plan
      if (task.plan && task.plan.length > 0) {
        const done = task.plan.filter(s => s.status === 'done' || s.status === 'completed').length;
        return (done / task.plan.length * 100) + '%';
      }
      return '0%';
    }
  }
};
