export default {
  name: 'TaskPanel',
  props: {
    visible: { type: Boolean, default: false }
  },
  emits: ['close'],
  template: `
    <div class="task-panel" :class="{ open: visible }" role="complementary" aria-label="Background tasks">
      <!-- Header -->
      <div class="task-panel-header">
        <span class="task-panel-title">
          {{ $t('taskPanel.title') }}
          <span class="task-panel-count" v-if="allTasks.length > 0">({{ allTasks.length }})</span>
        </span>
        <button class="task-panel-close" @click="$emit('close')" :aria-label="$t('common.close')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>

      <!-- Task List -->
      <div class="task-panel-list" v-if="allTasks.length > 0" role="list">
        <!-- Running tasks -->
        <div v-for="task in runningTasks" :key="task.id" role="listitem"
             class="task-card" :class="{ 'is-exiting': task.exiting }"
             @mouseenter="onTaskHover(task, true)"
             @mouseleave="onTaskHover(task, false)">
          <!-- Card Header -->
          <div class="task-card-header" @click="toggleCollapse(task)" :aria-expanded="!task.collapsed">
            <span class="task-card-icon">{{ getTaskIcon(task) }}</span>
            <span class="task-card-title" :class="{ 'is-bash': task.type === 'bash' }">{{ getTaskTitle(task) }}</span>
            <svg class="task-card-chevron" :class="{ 'is-collapsed': task.collapsed }" viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
            </svg>
            <button class="task-card-stop" :class="{ 'is-stopping': task.status === 'stopping' }"
                    @click.stop="stopTask(task)"
                    :disabled="task.status === 'stopping'"
                    :aria-label="$t('taskPanel.stopTask') + ': ' + getTaskTitle(task)">
              <svg v-if="task.status === 'stopping'" viewBox="0 0 24 24" width="12" height="12">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="31.4" stroke-dashoffset="10"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="12" height="12">
                <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>
              </svg>
            </button>
          </div>
          <!-- Output Area -->
          <div v-if="!task.collapsed" class="task-card-output-wrapper">
            <div v-if="task.output" class="task-card-output" :ref="el => setOutputRef(task.id, el)">{{ trimOutput(task.output) }}</div>
            <div v-else class="task-card-output-placeholder">
              <span class="task-card-output-dot"></span>
              <span class="task-card-output-dot"></span>
              <span class="task-card-output-dot"></span>
              <span class="task-card-output-placeholder-text">{{ $t('taskPanel.waitingOutput') }}</span>
            </div>
          </div>
          <!-- Footer -->
          <div class="task-card-footer">
            <span class="task-card-status is-running">{{ task.status === 'stopping' ? $t('taskPanel.stopping') : $t('taskPanel.running') }}</span>
            <span class="task-card-time">{{ formatElapsed(task.startTime) }}</span>
          </div>
        </div>

        <!-- Completed divider -->
        <div v-if="completedTasks.length > 0 && runningTasks.length > 0" class="task-panel-divider">
          <span class="task-panel-divider-line"></span>
          <span class="task-panel-divider-label">{{ $t('taskPanel.completed') }}</span>
          <span class="task-panel-divider-line"></span>
        </div>

        <!-- Completed tasks -->
        <div v-for="task in completedTasks" :key="task.id" role="listitem"
             class="task-card is-completed" :class="{ 'is-exiting': task.exiting, 'is-error': task.status === 'error' }"
             @mouseenter="onTaskHover(task, true)"
             @mouseleave="onTaskHover(task, false)">
          <div class="task-card-header" @click="toggleCollapse(task)" :aria-expanded="!task.collapsed">
            <span class="task-card-icon">{{ getCompletedIcon(task) }}</span>
            <span class="task-card-title" :class="{ 'is-bash': task.type === 'bash' }">{{ getTaskTitle(task) }}</span>
            <svg class="task-card-chevron" :class="{ 'is-collapsed': task.collapsed }" viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
            </svg>
          </div>
          <div v-if="!task.collapsed" class="task-card-output-wrapper">
            <div v-if="task.output" class="task-card-output">{{ trimOutput(task.output) }}</div>
          </div>
          <div class="task-card-footer">
            <span class="task-card-status" :class="getStatusClass(task)">{{ getStatusText(task) }}</span>
            <span class="task-card-time">{{ formatElapsed(task.endTime || task.startTime) }}</span>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else class="task-panel-empty">
        <div class="task-panel-empty-icon">&#x1F4A4;</div>
        <div class="task-panel-empty-text">{{ $t('taskPanel.empty') }}</div>
        <div class="task-panel-empty-hint">{{ $t('taskPanel.emptyHint') }}</div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const outputRefs = {};
    const now = Vue.ref(Date.now());

    // Update relative times every second
    let timer = null;
    Vue.onMounted(() => {
      timer = setInterval(() => { now.value = Date.now(); }, 1000);
    });
    Vue.onUnmounted(() => {
      if (timer) clearInterval(timer);
    });

    // Close on Escape
    const onKeydown = (e) => {
      if (e.key === 'Escape' && props.visible) {
        emit('close');
      }
    };
    Vue.onMounted(() => document.addEventListener('keydown', onKeydown));
    Vue.onUnmounted(() => document.removeEventListener('keydown', onKeydown));

    const allTasks = Vue.computed(() => {
      return store.currentBackgroundTasks;
    });

    const runningTasks = Vue.computed(() => {
      return allTasks.value.filter(t => t.status === 'running' || t.status === 'stopping');
    });

    const completedTasks = Vue.computed(() => {
      return allTasks.value.filter(t => t.status !== 'running' && t.status !== 'stopping');
    });

    const getTaskIcon = (task) => {
      return task.type === 'agent' ? '\u{1F916}' : '\u{1F4BB}';
    };

    const getCompletedIcon = (task) => {
      if (task.status === 'error') return '\u274C';
      if (task.status === 'stopped') return '\u{1F6D1}';
      return '\u2705';
    };

    const getTaskTitle = (task) => {
      if (task.type === 'agent') {
        return task.description || 'Agent Task';
      }
      const cmd = task.command || task.description || '';
      return cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
    };

    const getStatusClass = (task) => {
      if (task.status === 'error') return 'is-error';
      if (task.status === 'stopped') return 'is-stopped';
      return 'is-completed';
    };

    const getStatusText = (task) => {
      const t = Vue.inject('t');
      if (task.status === 'error') return t('taskPanel.failed');
      if (task.status === 'stopped') return t('taskPanel.stopped');
      return t('taskPanel.completed');
    };

    const formatElapsed = (timestamp) => {
      const t = Vue.inject('t');
      if (!timestamp) return '';
      const seconds = Math.floor((now.value - timestamp) / 1000);
      if (seconds < 5) return t('taskPanel.justNow');
      if (seconds < 60) return t('taskPanel.secondsAgo').replace('{n}', seconds);
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t('taskPanel.minutesAgo').replace('{n}', minutes);
      return t('taskPanel.hoursAgo').replace('{n}', Math.floor(minutes / 60));
    };

    const trimOutput = (output) => {
      if (!output) return '';
      // Show last 30 lines max
      const lines = output.split('\n');
      if (lines.length > 30) {
        return '...\n' + lines.slice(-30).join('\n');
      }
      return output;
    };

    const toggleCollapse = (task) => {
      task.collapsed = !task.collapsed;
      // If expanding a completed task, pause its exit timer
      if (!task.collapsed && (task.status === 'completed' || task.status === 'error' || task.status === 'stopped')) {
        store.pauseExitTimer(store.currentConversation, task.id);
      }
    };

    const stopTask = (task) => {
      store.stopBackgroundTask(store.currentConversation, task.id);
    };

    const onTaskHover = (task, hovering) => {
      if (task.status === 'completed' || task.status === 'error' || task.status === 'stopped') {
        if (hovering) {
          store.pauseExitTimer(store.currentConversation, task.id);
        } else {
          store.resumeExitTimer(store.currentConversation, task.id);
        }
      }
    };

    const setOutputRef = (taskId, el) => {
      if (el) {
        outputRefs[taskId] = el;
        // Auto-scroll to bottom
        Vue.nextTick(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    };

    // Watch for output changes and auto-scroll
    Vue.watch(
      () => allTasks.value.map(t => t.output?.length || 0),
      () => {
        Vue.nextTick(() => {
          for (const task of allTasks.value) {
            const el = outputRefs[task.id];
            if (el && !task.collapsed) {
              el.scrollTop = el.scrollHeight;
            }
          }
        });
      },
      { deep: true }
    );

    return {
      store, allTasks, runningTasks, completedTasks,
      getTaskIcon, getCompletedIcon, getTaskTitle, getStatusClass, getStatusText,
      formatElapsed, trimOutput, toggleCollapse, stopTask, onTaskHover, setOutputRef
    };
  }
};
