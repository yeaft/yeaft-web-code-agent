import TerminalOutput from './TerminalOutput.js';

const tryParseJsonLine = (line) => {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
};

const compactText = (value, maxLength = 360) => {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
};

const readableText = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const readableSubAgentEvent = (event, translate) => {
  if (!event || typeof event !== 'object') return '';
  const $t = typeof translate === 'function' ? translate : (key) => key;
  const name = event.agentName || event.agentId || $t('yeaft.sessionStatus.task.kind.subAgent');
  switch (event.type) {
    case 'sub_agent_spawned': {
      const mission = compactText(event.mission, 240);
      return mission
        ? $t('yeaft.sessionStatus.task.subAgentStartedWithMission', { name, mission })
        : $t('yeaft.sessionStatus.task.subAgentStarted', { name });
    }
    case 'sub_agent_status':
      return event.status
        ? $t('yeaft.sessionStatus.task.subAgentStatus', { name, status: event.status })
        : $t('yeaft.sessionStatus.task.subAgentStatusUpdated', { name });
    case 'sub_agent_turn_end': {
      const text = readableText(event.content || event.text);
      return text
        ? $t('yeaft.sessionStatus.task.subAgentResult', { name, text })
        : $t('yeaft.sessionStatus.task.subAgentProducedResult', { name });
    }
    case 'text_delta': {
      const text = readableText(event.text || event.content || event.delta);
      return text ? $t('yeaft.sessionStatus.task.subAgentEvent', { name, text }) : '';
    }
    case 'user_prompt': {
      const text = compactText(event.content || event.message, 240);
      return text ? $t('yeaft.sessionStatus.task.subAgentUserPrompt', { text }) : '';
    }
    case 'tool_start':
    case 'tool_use':
    case 'tool_call':
      return $t('yeaft.sessionStatus.task.subAgentUsedTool', { name, tool: event.name || event.toolName || 'tool' });
    case 'tool_result':
    case 'tool_end':
      return $t('yeaft.sessionStatus.task.subAgentFinishedTool', { name, tool: event.name || event.toolName || 'tool' });
    case 'usage':
      return typeof event.tokens === 'number'
        ? $t('yeaft.sessionStatus.task.subAgentUsage', { name, tokens: event.tokens })
        : '';
    case 'error': {
      const error = event.error && (event.error.message || event.error);
      return error
        ? $t('yeaft.sessionStatus.task.subAgentError', { name, error })
        : $t('yeaft.sessionStatus.task.subAgentHitError', { name });
    }
    default: {
      const text = compactText(event.content || event.message, 240);
      return text ? $t('yeaft.sessionStatus.task.subAgentEvent', { name, text }) : '';
    }
  }
};

export function createSubAgentTaskStreamText(task, translate) {
  if (!task || task.kind !== 'sub_agent') return '';
  const $t = typeof translate === 'function' ? translate : (key) => key;
  const preview = typeof task.log?.preview === 'string' ? task.log.preview : '';
  const lines = [];
  let deltaAgentName = '';
  let deltaText = '';
  const flushDelta = () => {
    const text = readableText(deltaText);
    if (text) {
      lines.push($t('yeaft.sessionStatus.task.subAgentEvent', {
        name: deltaAgentName || $t('yeaft.sessionStatus.task.kind.subAgent'),
        text,
      }));
    }
    deltaAgentName = '';
    deltaText = '';
  };

  for (const line of preview.split(/\r?\n/)) {
    const event = tryParseJsonLine(line);
    if (!event) continue;
    if (event.type === 'text_delta') {
      deltaAgentName = event.agentName || event.agentId || deltaAgentName;
      deltaText += event.text || event.content || event.delta || '';
      continue;
    }
    flushDelta();
    const rendered = readableSubAgentEvent(event, $t);
    if (rendered) lines.push(rendered);
  }
  flushDelta();
  return lines.join('\n');
}

export function createSubAgentTaskDetailLines(task, translate) {
  if (!task || task.kind !== 'sub_agent') return [];
  const $t = typeof translate === 'function' ? translate : (key) => key;
  const resultSummary = compactText(task.result?.summary);
  const fallbackName = $t('yeaft.sessionStatus.task.kind.subAgent');
  const resultName = task.agentName || task.agentId || fallbackName;
  const resultLine = resultSummary
    ? [$t('yeaft.sessionStatus.task.subAgentResult', { name: resultName, text: resultSummary })]
    : [];
  const activityLines = createSubAgentTaskStreamText(task, translate)
    .split('\n')
    .filter(Boolean)
    .filter(line => !resultLine.includes(line));
  return [...resultLine, ...activityLines];
}

/**
 * VpTimelinePane — right-of-conversation Session status pane.
 *
 * Originally introduced as a VP roster pane. It now presents the active
 * Yeaft Session status: the VP roster first, then running background
 * tasks. The historical file/component name is intentionally kept to avoid
 * a noisy rename chain across parent components and tests.
 *
 * Props:
 *   rows — TimelineRow[] (see web/stores/helpers/vp-timeline.js for shape).
 *   tasks — running and recent terminal Session task snapshots.
 *   announcementText — active Session announcement preview source.
 * Emits:
 *   mention-vp (vpId)      — primary row click / Enter / Space. YeaftPage
 *                            forwards to the chat input which appends
 *                            `@<vpId> ` to the current draft.
 *   edit-vp (vpId)         — hover-revealed edit button on the row.
 *   start-resize  (event)  — mousedown on the resize handle; YeaftPage
 *                            owns the drag bookkeeping (matches the
 *                            .yeaft-detail pattern).
 *   cancel-vp-turn (vpId)  — abort button click for an active turn.
 *   edit-announcement      — open the Session settings announcement editor.
 *   close                  — hide the Session status pane.
 */
export default {
  name: 'VpTimelinePane',
  components: { TerminalOutput },
  emits: ['mention-vp', 'edit-vp', 'start-resize', 'cancel-vp-turn', 'edit-announcement', 'cancel-task', 'close'],
  props: {
    rows: { type: Array, required: true },
    tasks: { type: Array, default: () => [] },
    announcementText: { type: String, default: '' },
    stoppingTasksById: { type: Object, default: () => ({}) },
  },
  template: `
    <aside class="yeaft-vp-timeline yeaft-session-status-pane" :aria-label="$t('yeaft.sessionStatus.aria')">
      <div
        class="yeaft-vp-timeline-resize-handle"
        @mousedown.prevent="$emit('start-resize', $event)"
        :title="$t('yeaft.vpTimeline.resizeTitle')"
        aria-hidden="true"
      ></div>
      <header class="yeaft-session-status-header">
        <span class="yeaft-session-status-title">
          <svg class="yeaft-session-status-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="3"/>
            <path d="M8 9h8"/>
            <path d="M8 14h5"/>
          </svg>
          <span>{{ $t('yeaft.sessionStatus.title') }}</span>
        </span>
        <button
          type="button"
          class="yeaft-session-status-close"
          :title="$t('yeaft.sessionStatus.close')"
          :aria-label="$t('yeaft.sessionStatus.close')"
          @click="$emit('close')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18"/>
            <path d="M6 6l12 12"/>
          </svg>
        </button>
      </header>

      <section class="yeaft-session-status-section yeaft-session-status-announcement" :aria-label="$t('yeaft.sessionStatus.announcement')">
        <header class="yeaft-session-status-section-header">
          <span>{{ $t('yeaft.sessionStatus.announcement') }}</span>
        </header>
        <button
          type="button"
          class="yeaft-session-status-announcement-card"
          :class="{ 'is-empty': !hasAnnouncement }"
          @click="$emit('edit-announcement')"
        >
          <span class="yeaft-session-status-announcement-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 14.5V9.5l11-4v13l-11-4z"/>
              <path d="M15 8.25c1.25.7 2 1.95 2 3.75s-.75 3.05-2 3.75"/>
              <path d="M7 15l1.2 4h3.1l-1.6-3.1"/>
            </svg>
          </span>
          <span class="yeaft-session-status-announcement-main">
            <span class="yeaft-session-status-announcement-text">
              {{ announcementPreview || $t('yeaft.sessionStatus.announcementEmpty') }}
            </span>
            <span class="yeaft-session-status-announcement-action">
              {{ hasAnnouncement ? $t('yeaft.sessionStatus.announcementEdit') : $t('yeaft.sessionStatus.announcementAdd') }}
            </span>
          </span>
        </button>
      </section>

      <section class="yeaft-session-status-section" :aria-label="$t('yeaft.sessionStatus.vps')">
        <header class="yeaft-session-status-section-header">
          <span>{{ $t('yeaft.sessionStatus.vps') }}</span>
          <span class="yeaft-session-status-count" v-if="rows.length">{{ rows.length }}</span>
        </header>

        <div v-if="!rows.length" class="yeaft-vp-timeline-empty">
          {{ $t('yeaft.vpTimeline.empty') }}
        </div>

        <ul v-else class="yeaft-vp-timeline-list">
          <li
            v-for="row in rows"
            :key="row.vpId"
            class="yeaft-vp-timeline-row"
            :class="['is-status-' + row.status, { 'is-stopping': row.isStopping }]"
            tabindex="0"
            role="button"
            :aria-label="row.displayName + ' — ' + statusLabel(row)"
            :title="$t('yeaft.vpTimeline.mention')"
            @click="$emit('mention-vp', row.vpId)"
            @keydown.enter.prevent="$emit('mention-vp', row.vpId)"
            @keydown.space.prevent="$emit('mention-vp', row.vpId)"
          >
            <div class="yeaft-vp-timeline-row-body">
              <span class="yeaft-vp-timeline-row-name" :style="{ color: vpTextColorFor(row.vpId) }">{{ row.displayName }}</span>
              <span class="yeaft-vp-timeline-row-status">{{ statusLabel(row) }}</span>
              <span
                v-if="row.runningThreadCount > 1"
                class="yeaft-vp-timeline-thread-count"
                :title="threadCountTitle(row)"
              >{{ row.runningThreadCount }} threads</span>
            </div>
            <!--
              Right-side affordance cluster. Both buttons stop click
              propagation so they don't fall through to the row's primary
              mention action. The abort button is only visible while the VP
              is actually doing something; the edit button is hover-revealed
              (CSS) so the row stays visually quiet at rest.
            -->
            <span class="yeaft-vp-timeline-row-actions">
              <span
                v-if="isActiveStatus(row.status)"
                class="yeaft-vp-timeline-abort"
                :class="{ 'is-stopping': row.isStopping }"
                role="button"
                tabindex="0"
                :aria-label="$t('yeaft.vpTimeline.abort')"
                :aria-disabled="row.isStopping ? 'true' : 'false'"
                :title="$t('yeaft.vpTimeline.abort')"
                @click.stop="!row.isStopping && $emit('cancel-vp-turn', row.vpId)"
                @keydown.enter.stop.prevent="!row.isStopping && $emit('cancel-vp-turn', row.vpId)"
                @keydown.space.stop.prevent="!row.isStopping && $emit('cancel-vp-turn', row.vpId)"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
                </svg>
              </span>
              <span
                class="yeaft-vp-timeline-edit"
                role="button"
                tabindex="0"
                :aria-label="$t('yeaft.vpTimeline.edit')"
                :title="$t('yeaft.vpTimeline.edit')"
                @click.stop="$emit('edit-vp', row.vpId)"
                @keydown.enter.stop.prevent="$emit('edit-vp', row.vpId)"
                @keydown.space.stop.prevent="$emit('edit-vp', row.vpId)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                </svg>
              </span>
            </span>
          </li>
        </ul>
      </section>

      <section class="yeaft-vp-task-board yeaft-session-status-section" :aria-label="$t('yeaft.sessionStatus.backgroundTasks')">
        <header class="yeaft-vp-task-board-header yeaft-session-status-section-header">
          <span>{{ $t('yeaft.sessionStatus.backgroundTasks') }}</span>
          <span class="yeaft-vp-task-count yeaft-session-status-count" v-if="tasks.length">{{ tasks.length }}</span>
        </header>
        <div v-if="!tasks.length" class="yeaft-vp-task-empty">
          {{ $t('yeaft.session.tasksEmpty') }}
        </div>
        <div v-else class="yeaft-vp-task-list">
          <article
            v-for="task in tasks"
            :key="task.id"
            class="yeaft-vp-task-item"
            :class="{ 'is-expanded': expandedTasks[task.id], 'is-terminal': task.status !== 'running', 'is-running': task.status === 'running' }"
          >
            <button type="button" class="yeaft-vp-task-summary" @click="toggleTaskExpanded(task.id)">
              <span class="yeaft-vp-task-dot" aria-hidden="true"></span>
              <span class="yeaft-vp-task-main">
                <span class="yeaft-vp-task-title">{{ task.title || task.id }}</span>
                <span class="yeaft-vp-task-meta">{{ taskOwnerName(task) }} · {{ formatTaskTime(task.startedAt) }}</span>
              </span>
              <span class="yeaft-vp-task-kind">{{ taskKindLabel(task) }}</span>
              <svg class="yeaft-vp-task-chevron" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </button>
            <div v-if="expandedTasks[task.id]" class="yeaft-vp-task-detail">
              <div v-if="shellTaskCommand(task)" class="yeaft-vp-task-command">
                <span class="yeaft-vp-task-command-label">{{ $t('yeaft.sessionStatus.task.command') }}</span>
                <code>{{ shellTaskCommand(task) }}</code>
              </div>
              <button
                v-if="isTaskCancellable(task)"
                type="button"
                class="yeaft-vp-task-cancel"
                :disabled="isTaskStopping(task)"
                @click.stop="$emit('cancel-task', task)"
              >
                {{ isTaskStopping(task) ? $t('yeaft.sessionStatus.task.stopping') : $t('yeaft.sessionStatus.task.stop') }}
              </button>
              <div v-if="task.kind === 'sub_agent'" class="yeaft-vp-task-sub-agent-panel">
                <TerminalOutput
                  v-if="subAgentTaskStreamText(task)"
                  class="yeaft-vp-task-log yeaft-vp-task-stream"
                  :content="subAgentTaskStreamText(task)"
                  :ref="el => setTaskLogRef(task.id, el && (el.$el || el))"
                  @scroll="onTaskLogScroll(task.id)"
                />
                <div v-else class="yeaft-vp-task-log-empty">{{ $t('yeaft.sessionStatus.task.subAgentNoReadableEvents') }}</div>
              </div>
              <TerminalOutput
                v-else-if="task.log && task.log.preview"
                class="yeaft-vp-task-log"
                :content="task.log.preview"
                :ref="el => setTaskLogRef(task.id, el && (el.$el || el))"
                @scroll="onTaskLogScroll(task.id)"
              />
              <div v-else class="yeaft-vp-task-log-empty">{{ $t('yeaft.sessionStatus.noLogPreview') }}</div>
            </div>
          </article>
        </div>
      </section>
    </aside>
  `,
  setup(props, { emit }) {
    const vpStore = (window.Pinia && window.Pinia.useVpStore)
      ? window.Pinia.useVpStore()
      : null;
    const vpTextColorFor = (vpId) => (vpStore && typeof vpStore.vpTextColor === 'function'
      ? vpStore.vpTextColor(vpId)
      : 'var(--text-primary)');

    // Capture $t ONCE at mount via getCurrentInstance(); reusing the
    // same reference for every status label avoids re-walking
    // appContext on every render (40 lookups for 20 rows otherwise).
    const inst = Vue.getCurrentInstance();
    const $t = (inst && inst.appContext.config.globalProperties.$t) || ((k) => k);

    const normalizedAnnouncementText = Vue.computed(() => {
      const raw = typeof props.announcementText === 'string' ? props.announcementText : '';
      return raw.trim();
    });
    const hasAnnouncement = Vue.computed(() => !!normalizedAnnouncementText.value);
    const announcementPreview = Vue.computed(() => {
      const text = normalizedAnnouncementText.value.replace(/\s+/g, ' ');
      if (text.length <= 96) return text;
      return text.slice(0, 95) + '…';
    });

    const expandedTasks = Vue.ref({});
    const taskLogRefs = new Map();
    const taskLogPinned = new Map();

    const scrollTaskLogToBottom = (taskId) => {
      const el = taskLogRefs.get(taskId);
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      taskLogPinned.set(taskId, true);
    };
    const toggleTaskExpanded = (taskId) => {
      const nextExpanded = !expandedTasks.value[taskId];
      expandedTasks.value = { ...expandedTasks.value, [taskId]: nextExpanded };
      if (nextExpanded) {
        taskLogPinned.set(taskId, true);
        Vue.nextTick(() => scrollTaskLogToBottom(taskId));
      }
    };
    const setTaskLogRef = (taskId, el) => {
      if (el) {
        taskLogRefs.set(taskId, el);
        if (!taskLogPinned.has(taskId)) taskLogPinned.set(taskId, true);
        Vue.nextTick(() => {
          if (taskLogPinned.get(taskId)) scrollTaskLogToBottom(taskId);
        });
      } else {
        taskLogRefs.delete(taskId);
      }
    };
    const onTaskLogScroll = (taskId) => {
      const el = taskLogRefs.get(taskId);
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      taskLogPinned.set(taskId, distanceFromBottom < 8);
    };
    Vue.watch(
      () => JSON.stringify((Array.isArray(props.tasks) ? props.tasks : []).map(task => [task.id, task?.log?.preview || ''])),
      () => Vue.nextTick(() => {
        taskLogRefs.forEach((_, taskId) => {
          if (taskLogPinned.get(taskId)) scrollTaskLogToBottom(taskId);
        });
      })
    );

    const taskOwnerName = (task) => {
      const owner = task?.ownerVpId || '';
      if (!owner) return 'unknown';
      return vpStore && typeof vpStore.vpLabel === 'function' ? vpStore.vpLabel(owner) : owner;
    };
    const formatTaskTime = (value) => {
      if (!value) return '';
      try { return new Date(value).toLocaleTimeString(); } catch (_) { return String(value); }
    };

    const taskKindLabel = (task) => {
      switch (task?.kind) {
        case 'sub_agent': return $t('yeaft.sessionStatus.task.kind.subAgent');
        case 'shell': return $t('yeaft.sessionStatus.task.kind.shell');
        default: return task?.kind || '';
      }
    };
    const shellTaskCommand = (task) => {
      const command = task?.runtime?.command;
      return typeof command === 'string' ? command.trim() : '';
    };
    const taskStopKey = (task) => `${task?.sessionId || ''}::${task?.id || ''}`;
    const isTaskCancellable = (task) => task?.kind === 'shell' && task?.status === 'running' && !!task?.runtime?.pid;
    const isTaskStopping = (task) => !!(task?.id && props.stoppingTasksById?.[taskStopKey(task)]);

    const taskDetailLines = (task) => createSubAgentTaskDetailLines(task, $t);
    const subAgentTaskStreamText = (task) => createSubAgentTaskStreamText(task, $t);

    const statusLabel = (row) => {
      switch (row.status) {
        case 'idle':      return $t('yeaft.vpTimeline.status.idle');
        case 'typing':    return $t('yeaft.vpTimeline.status.typing');
        case 'thinking':  return $t('yeaft.vpTimeline.status.thinking');
        case 'streaming': return $t('yeaft.vpTimeline.status.streaming');
        case 'tool':      return $t('yeaft.vpTimeline.status.tool');
        case 'error':     return $t('yeaft.vpTimeline.status.error');
        case 'offline':   return $t('yeaft.vpTimeline.status.offline');
        default:          return row.status;
      }
    };

    // "Active" = there's actually a turn in flight we could abort. We
    // intentionally exclude `idle` (no turn), `error` (turn already
    // ended with a failure), and `offline` (agent gone — abort would
    // never land). Without this gate, an offline row would render a
    // dead abort button that does nothing on click, which is worse than
    // not showing it at all.
    const ACTIVE_STATES = new Set(['typing', 'thinking', 'streaming', 'tool']);
    const isActiveStatus = (s) => ACTIVE_STATES.has(s);

    const threadCountTitle = (row) => {
      const threads = Array.isArray(row && row.threads) ? row.threads : [];
      if (!threads.length) return '';
      return threads
        .slice(0, 5)
        .map((t) => `${t.title || t.threadId || 'thread'}: ${t.status || 'idle'}`)
        .join('\n');
    };

    return {
      hasAnnouncement,
      announcementPreview,
      statusLabel,
      isActiveStatus,
      threadCountTitle,
      vpTextColorFor,
      expandedTasks,
      toggleTaskExpanded,
      taskOwnerName,
      formatTaskTime,
      taskKindLabel,
      shellTaskCommand,
      isTaskCancellable,
      isTaskStopping,
      taskDetailLines,
      subAgentTaskStreamText,
      setTaskLogRef,
      onTaskLogScroll,
    };
  },
};
