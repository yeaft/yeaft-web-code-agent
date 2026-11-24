import TerminalOutput from './TerminalOutput.js';
import SessionToolDetails from './SessionToolDetails.js';
import { sessionExecutionKey } from '../stores/helpers/yeaft-session-identity.js';
import { formatElapsed } from '../stores/helpers/turn-timing.js';
import { LIVE_SESSION_TURN_STATES } from '../stores/helpers/yeaft-session-turns.js';

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

const toolSummaryLine = (count, translate) => {
  const n = Number(count || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const $t = typeof translate === 'function' ? translate : (key) => key;
  return $t('yeaft.sessionStatus.task.subAgentToolSummary', { count: n });
};

const readableSubAgentEvent = (event, translate) => {
  if (!event || typeof event !== 'object') return '';
  const $t = typeof translate === 'function' ? translate : (key) => key;
  const name = event.agentName || event.agentId || $t('yeaft.sessionStatus.task.kind.subAgent');
  if (event.type === 'sub_agent_turn_end') {
    const text = readableText(event.content || event.text);
    return text ? $t('yeaft.sessionStatus.task.subAgentResult', { name, text }) : '';
  }
  if (event.type === 'error') {
    const error = event.error && (event.error.message || event.error);
    return error
      ? $t('yeaft.sessionStatus.task.subAgentError', { name, error })
      : $t('yeaft.sessionStatus.task.subAgentHitError', { name });
  }
  return '';
};

export function createSubAgentTaskStreamText(task, translate) {
  if (!task || task.kind !== 'sub_agent') return '';
  const $t = typeof translate === 'function' ? translate : (key) => key;
  const preview = typeof task.log?.preview === 'string' ? task.log.preview : '';
  const lines = [];
  let deltaAgentName = '';
  let deltaText = '';
  let toolCallCount = 0;
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
  const discardDelta = () => {
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
    if (event.type === 'tool_use' || event.type === 'tool_call') {
      toolCallCount += 1;
      continue;
    }
    if (event.type === 'sub_agent_turn_end') {
      discardDelta();
      const rendered = readableSubAgentEvent(event, $t);
      if (rendered) lines.push(rendered);
      continue;
    }
    if (event.type === 'error') {
      flushDelta();
      const rendered = readableSubAgentEvent(event, $t);
      if (rendered) lines.push(rendered);
    }
  }
  flushDelta();
  const summary = toolSummaryLine(toolCallCount, $t);
  if (summary) lines.push(summary);
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

/** Session execution activity, announcement and background tasks. */
export default {
  name: 'VpTimelinePane',
  components: { TerminalOutput, SessionToolDetails },
  emits: ['start-resize', 'stop-turn', 'edit-announcement', 'cancel-task', 'close'],
  props: {
    rows: { type: Array, required: true },
    toolsByExecution: { type: Map, default: () => new Map() },
    visible: { type: Boolean, default: true },
    tasks: { type: Array, default: () => [] },
    announcementText: { type: String, default: '' },
    stoppingTasksById: { type: Object, default: () => ({}) },
  },
  methods: {
    onEscape(event) {
      // A settings dialog can retain focus on its opener. Let the topmost
      // modal's window handler own Escape instead of closing the pane below it.
      if (document.querySelector('.group-settings-overlay, .modal-overlay')) return;
      event.stopPropagation();
      event.preventDefault();
      this.$emit('close');
    },
  },
  template: `
    <aside class="yeaft-vp-timeline yeaft-session-status-pane" :aria-label="$t('yeaft.sessionStatus.aria')" @keydown.esc="onEscape">
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

      <slot name="scheduled-task"></slot>

      <section ref="activitySection" tabindex="-1" class="yeaft-session-status-section yeaft-session-activity" :aria-label="$t('yeaft.sessionStatus.activity')">
        <header class="yeaft-session-status-section-header">
          <span>{{ $t('yeaft.sessionStatus.activity') }}</span>
        </header>

        <div v-if="!rows.length" class="yeaft-vp-timeline-empty">{{ $t('yeaft.sessionStatus.noActiveTurns') }}</div>

        <ul v-else class="yeaft-vp-timeline-list">
          <li
            v-for="(row, index) in rows"
            :key="row.key"
            class="yeaft-vp-timeline-row"
            :class="['is-status-' + row.status, { 'is-stopping': row.isStopping }]"
          >
            <div class="yeaft-vp-timeline-row-header">
              <div class="yeaft-session-activity-copy">
                <span v-if="row.label || rows.length > 1" class="yeaft-session-activity-label" :title="turnLabel(row, index)">{{ turnLabel(row, index) }}</span>
                <div class="yeaft-session-activity-meta">
                  <span class="yeaft-vp-timeline-row-status">{{ statusLabel(row) }}</span>
                  <span v-if="elapsed(row)" class="yeaft-session-activity-elapsed">{{ $t('yeaft.sessionStatus.elapsed', { duration: elapsed(row) }) }}</span>
                </div>
              </div>
              <button v-if="row.errors?.length" type="button" class="btn-ghost yeaft-vp-error-toggle"
                :aria-label="$t('yeaft.vpTimeline.errorDetailsFor', { name: turnLabel(row, index) })"
                :aria-expanded="isErrorExpanded(row)"
                @click="toggleError(row)">
                {{ $t('yeaft.sessionStatus.errorDetails') }} <span aria-hidden="true">{{ isErrorExpanded(row) ? '▾' : '▸' }}</span>
              </button>
              <button v-if="row.canStop || row.isStopping || row.status === 'cancelling'" type="button"
                class="btn-ghost yeaft-vp-timeline-abort" :class="{ 'is-stopping': row.isStopping || row.status === 'cancelling' }"
                :aria-label="$t('yeaft.sessionStatus.stopTurn', { name: turnLabel(row, index) })"
                :title="$t('yeaft.sessionStatus.stopTurn', { name: turnLabel(row, index) })"
                :disabled="row.isStopping || row.status === 'cancelling'"
                @click="$emit('stop-turn', row)">
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
                </svg>
              </button>
            </div>
            <section v-if="row.errors?.length && isErrorExpanded(row)" class="yeaft-vp-error-details"
              :aria-label="$t('yeaft.vpTimeline.errorDetailsFor', { name: turnLabel(row, index) })">
              <article v-for="(error, index) in row.errors" :key="index" class="yeaft-vp-error-detail">
                <p class="yeaft-vp-error-message">{{ error.message || $t('yeaft.vpTimeline.errorUnavailable') }}</p>
                <dl class="yeaft-vp-error-metadata">
                  <template v-if="error.code || error.reasonCode"><dt>{{ $t('yeaft.vpTimeline.errorCode') }}</dt><dd>{{ error.code || error.reasonCode }}</dd></template>
                  <template v-if="error.reason"><dt>{{ $t('yeaft.vpTimeline.errorReason') }}</dt><dd>{{ error.reason }}</dd></template>
                  <template v-if="error.statusCode"><dt>HTTP</dt><dd>{{ error.statusCode }}</dd></template>
                  <template v-if="error.provider || error.model"><dt>{{ $t('yeaft.vpTimeline.errorModel') }}</dt><dd>{{ [error.provider, error.model].filter(Boolean).join(' / ') }}</dd></template>
                  <template v-if="error.at"><dt>{{ $t('yeaft.vpTimeline.errorTime') }}</dt><dd>{{ formatErrorTime(error.at) }}</dd></template>
                  <template v-if="error.turnId"><dt>Turn</dt><dd>{{ error.turnId }}</dd></template>
                  <template v-if="error.threadId"><dt>{{ $t('yeaft.vpTimeline.errorThread') }}</dt><dd>{{ error.threadId }}</dd></template>
                </dl>
              </article>
            </section>
            <div v-for="({ key, progress, number }) in visibleExecutions(row)" :key="key" class="yeaft-query-progress" :class="progress ? 'is-' + progress.stage : 'is-tools-only'">
              <span v-if="number" class="yeaft-query-progress-label">{{ $t('yeaft.sessionStatus.executionNumber', { count: number }) }}</span>
              <div v-if="progress" class="yeaft-query-progress-state" role="status">
                <template v-if="progress.stage !== 'running'">
                  <span>{{ $t('yeaft.queryProgress.stage.' + progress.stage) }}</span><span v-if="progress.reason" class="yeaft-query-progress-reason"> · {{ $t('yeaft.queryProgress.reason.' + progress.reason) }}</span>
                </template>
              </div>
              <div v-if="progress" class="yeaft-query-progress-usage" role="group" :aria-label="$t('yeaft.queryProgress.scopeLabel')" :title="$t('yeaft.queryProgress.tokenScope')">
                <span class="yeaft-query-progress-label" aria-hidden="true">{{ $t('yeaft.queryProgress.scopeLabel') }}</span>
                <dl class="yeaft-query-progress-tokens">
                  <div><dt>{{ $t('yeaft.queryProgress.inputTokens') }}</dt><dd>{{ formatTokenCount(progress.inputTokens) }}</dd></div>
                  <div><dt>{{ $t('yeaft.queryProgress.outputTokens') }}</dt><dd>{{ formatTokenCount(progress.outputTokens) }}</dd></div>
                </dl>
              </div>
              <SessionToolDetails :tools="toolsByExecution.get(key)" @restore-focus="focusActivity">
                <template v-if="progress" #default>
                  <span>{{ $t('yeaft.queryProgress.requests', { count: formatCount(progress.modelRequests) }) }}</span>
                  <span>{{ $t('yeaft.queryProgress.tools', { count: formatCount(progress.toolExecutions) }) }}</span>
                </template>
                <template v-if="progress?.failedCalls > 0" #after>
                  <button type="button" class="btn-ghost yeaft-query-progress-failures-toggle"
                    :aria-expanded="areFailuresExpanded(row, progress)"
                    :aria-label="$t('yeaft.queryProgress.failureToggle', { count: formatCount(progress.failedCalls) })"
                    @click="toggleFailures(row, progress)">
                    {{ $t('yeaft.queryProgress.failed', { count: formatCount(progress.failedCalls) }) }}
                    <span aria-hidden="true">{{ areFailuresExpanded(row, progress) ? '▾' : '▸' }}</span>
                  </button>
                </template>
              </SessionToolDetails>
              <section v-if="progress?.failedCalls > 0 && areFailuresExpanded(row, progress)" class="yeaft-query-progress-failures" :aria-label="$t('yeaft.queryProgress.failureTitle')">
                <p class="yeaft-query-progress-label">{{ $t('yeaft.queryProgress.failureTitle') }}</p>
                <template v-if="Array.isArray(progress.toolStats)">
                  <div v-if="failedTools(progress).length" class="yeaft-query-progress-failure-list">
                    <div class="yeaft-query-progress-tool-row yeaft-query-progress-tool-head" aria-hidden="true">
                      <span>{{ $t('yeaft.queryProgress.toolName') }}</span><span>{{ $t('yeaft.queryProgress.executions') }}</span><span>{{ $t('yeaft.queryProgress.failures') }}</span><span>{{ $t('yeaft.queryProgress.blocked') }}</span>
                    </div>
                    <div v-for="tool in failedTools(progress)" :key="tool.name" class="yeaft-query-progress-tool-row"
                      :aria-label="$t('yeaft.queryProgress.toolSummary', { name: tool.name, executions: tool.executions, failures: tool.failedCalls, blocked: tool.blockedCalls })">
                      <code>{{ tool.name }}</code><span>{{ formatCount(tool.executions) }}</span><span>{{ formatCount(tool.failedCalls) }}</span><span>{{ formatCount(tool.blockedCalls) }}</span>
                    </div>
                  </div>
                  <p v-else>{{ $t('yeaft.queryProgress.failuresNotListed') }}</p>
                  <p class="yeaft-query-progress-label">{{ $t('yeaft.queryProgress.failureNote') }}</p>
                  <p v-if="progress.toolStatsTruncated">{{ $t('yeaft.queryProgress.statsTruncated') }}</p>
                </template>
                <p v-else>{{ $t('yeaft.queryProgress.statsUnavailable') }}</p>
              </section>
            </div>
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
            <div class="yeaft-vp-task-summary">
              <button
                type="button"
                class="yeaft-vp-task-toggle"
                :title="taskSummaryTitle(task)"
                @click="toggleTaskExpanded(task.id)"
              >
                <span class="yeaft-vp-task-dot" aria-hidden="true"></span>
                <span class="yeaft-vp-task-main">
                  <span class="yeaft-vp-task-title">{{ task.title || task.id }}</span>
                  <code v-if="shellTaskCommand(task)" class="yeaft-vp-task-command">{{ shellTaskCommand(task) }}</code>
                  <span class="yeaft-vp-task-meta">{{ formatTaskTime(task.startedAt) }}</span>
                </span>
              </button>
              <span class="yeaft-vp-task-kind">{{ taskKindLabel(task) }}</span>
              <button
                v-if="isTaskCancellable(task)"
                type="button"
                class="yeaft-vp-task-cancel"
                :disabled="isTaskStopping(task)"
                :title="isTaskStopping(task) ? $t('yeaft.sessionStatus.task.stopping') : $t('yeaft.sessionStatus.task.stop')"
                @click.stop="$emit('cancel-task', task)"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
                </svg>
              </button>
              <button type="button" class="yeaft-vp-task-chevron-btn" @click="toggleTaskExpanded(task.id)" :aria-label="$t('yeaft.vpTimeline.expand')">
                <svg class="yeaft-vp-task-chevron" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </button>
            </div>
            <div v-if="expandedTasks[task.id]" class="yeaft-vp-task-detail">
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
  setup(props) {
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

    const activitySection = Vue.ref(null);
    const focusActivity = () => { if (props.visible) activitySection.value?.focus(); };

    const expandedErrors = Vue.ref({});
    const errorKey = row => JSON.stringify([row.agentId, row.sessionId, row.key,
      (row.errors || []).map(error => [error.turnId, error.threadId, error.at])]);
    const isErrorExpanded = row => !!expandedErrors.value[errorKey(row)];
    const toggleError = row => {
      const key = errorKey(row);
      expandedErrors.value = { ...expandedErrors.value, [key]: !isErrorExpanded(row) };
    };
    Vue.watch(() => props.rows.filter(row => row.errors?.length).map(errorKey), keys => {
      expandedErrors.value = Object.fromEntries(Object.entries(expandedErrors.value).filter(([key]) => keys.includes(key)));
    });
    const formatErrorTime = value => new Date(value).toLocaleString();

    const visibleExecutions = (row) => {
      const observed = (row.observations || []).filter(progress => progress.stage)
        .map(progress => ({ key: sessionExecutionKey(progress), progress }));
      // Actual tool events can arrive before telemetry, or from Agents that do
      // not report request counts. Use the same key so opening details survives
      // the first metrics update, without fabricating counts.
      const observedKeys = new Set(observed.map(item => item.key));
      for (const key of row.liveExecutionKeys || []) {
        if (!observedKeys.has(key) && props.toolsByExecution.has(key)) observed.push({ key, progress: null });
      }
      return observed.length > 1 ? observed.map((item, index) => ({ ...item, number: index + 1 })) : observed;
    };
    const expandedFailures = Vue.ref({});
    const progressKey = (row, progress) => JSON.stringify([row.agentId, row.sessionId, row.key, progress.turnId, progress.threadId]);
    const areFailuresExpanded = (row, progress) => !!expandedFailures.value[progressKey(row, progress)];
    const toggleFailures = (row, progress) => {
      const key = progressKey(row, progress);
      expandedFailures.value = { ...expandedFailures.value, [key]: !areFailuresExpanded(row, progress) };
    };
    Vue.watch(() => props.rows.flatMap(row => (row.observations || [])
      .filter(progress => progress.failedCalls > 0).map(progress => progressKey(row, progress))), keys => {
      expandedFailures.value = Object.fromEntries(Object.entries(expandedFailures.value).filter(([key]) => keys.includes(key)));
    });
    const formatCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
    const formatTokenCount = value => Number.isSafeInteger(value) && value >= 0 ? formatCount(value) : $t('yeaft.queryProgress.unavailable');
    const failedTools = progress => (progress.toolStats || []).filter(tool => tool.failedCalls > 0)
      .slice().sort((a, b) => b.failedCalls - a.failedCalls || a.name.localeCompare(b.name));

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
    const taskSummaryTitle = (task) => {
      const lines = [];
      const title = task?.title || task?.id || '';
      const command = shellTaskCommand(task);
      if (title) lines.push(`${$t('yeaft.sessionStatus.task.title')}: ${title}`);
      if (command) lines.push(`${$t('yeaft.sessionStatus.task.command')}: ${command}`);
      return lines.join('\n');
    };
    const taskStopKey = (task) => `${task?.agentId || ''}\u001f${task?.sessionId || ''}::${task?.id || ''}`;
    const isTaskCancellable = (task) => task?.status === 'running' && (
      (task.kind === 'shell' && !!task.runtime?.pid)
      || (task.kind === 'sub_agent' && !!task.runtime?.subAgentId)
    );
    const isTaskStopping = (task) => !!(task?.id && props.stoppingTasksById?.[taskStopKey(task)]);

    const taskDetailLines = (task) => createSubAgentTaskDetailLines(task, $t);
    const subAgentTaskStreamText = (task) => createSubAgentTaskStreamText(task, $t);

    const statusLabel = row => row.isStopping || row.status === 'cancelling'
      ? $t('chat.concurrent.cancelling')
      : ['routing', 'queued', 'running', 'waiting'].includes(row.status)
        ? $t('chat.concurrent.' + (row.status === 'routing' ? 'waiting' : row.status))
        : $t('yeaft.vpTimeline.status.' + row.status);
    const turnLabel = (row, index) => row.label || $t('yeaft.sessionStatus.turnNumber', { count: index + 1 });
    const canTime = row => row.startedAt > 0 && LIVE_SESSION_TURN_STATES.has(row.status);
    const now = Vue.ref(0);
    Vue.watch(() => props.visible && props.rows.some(canTime), (running, _, onCleanup) => {
      if (!running) return;
      const tick = () => { now.value = Date.now(); };
      tick();
      const timer = setInterval(tick, 1000);
      onCleanup(() => clearInterval(timer));
    }, { immediate: true });
    const elapsed = row => canTime(row) ? formatElapsed(Math.max(0, now.value - row.startedAt)) : '';

    return {
      hasAnnouncement,
      announcementPreview,
      statusLabel,
      isErrorExpanded,
      toggleError,
      formatErrorTime,
      turnLabel,
      elapsed,
      areFailuresExpanded,
      toggleFailures,
      visibleExecutions,
      activitySection,
      focusActivity,
      formatCount,
      formatTokenCount,
      failedTools,
      expandedTasks,
      toggleTaskExpanded,
      formatTaskTime,
      taskKindLabel,
      shellTaskCommand,
      taskSummaryTitle,
      isTaskCancellable,
      isTaskStopping,
      taskDetailLines,
      subAgentTaskStreamText,
      setTaskLogRef,
      onTaskLogScroll,
    };
  },
};
