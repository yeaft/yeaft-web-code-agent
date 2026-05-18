/**
 * VpTimelinePane — left-of-conversation VP list.
 *
 * Originally introduced in PR-3 of the feature-pill double-track
 * redesign. PR #767 ("remove feature system, add TodoWrite + tool
 * usage stats") deleted this component along with the Feature system,
 * but conflated the VP list (a roster-driven left pane that is part
 * of the core group conversation UI) with feature-specific surfaces.
 * v0.1.767 restored the pane WITHOUT the feature-aware row branch.
 *
 * Surfaces, for the active Unify conversation, one row per VP showing
 * avatar + name + live status (typing / streaming / idle). Pane sits
 * inside `unify-main` to the LEFT of the conversation, matching Crew's
 * members-left shape. The component itself is placement-agnostic —
 * only its parent container + the resize handle direction in CSS
 * reflect the side it's on.
 *
 * UI polish (feat-vp-list-ui-polish): the row is a single line —
 * name + inline status. The row's primary click action @-mentions
 * the VP into the chat input; opening the detail view is a
 * hover-revealed "info" affordance on the right side, sitting next
 * to the abort button (visible only while a turn is active).
 *
 * Props:
 *   rows — TimelineRow[] (see web/stores/helpers/vp-timeline.js for shape).
 *
 * Emits:
 *   mention-vp (vpId)      — primary row click / Enter / Space. UnifyPage
 *                            forwards to the chat input which appends
 *                            `@<vpId> ` to the current draft.
 *   open-vp-detail (vpId)  — hover-revealed info button on the row.
 *   start-resize  (event)  — mousedown on the resize handle; UnifyPage
 *                            owns the drag bookkeeping (matches the
 *                            .unify-detail pattern).
 *   cancel-vp-turn (vpId)  — abort button click for an active turn.
 */
import VpAvatar from './VpAvatar.js';

export default {
  name: 'VpTimelinePane',
  components: { VpAvatar },
  emits: ['mention-vp', 'open-vp-detail', 'start-resize', 'cancel-vp-turn'],
  props: {
    rows: { type: Array, required: true },
  },
  template: `
    <aside class="unify-vp-timeline" :aria-label="$t('unify.vpTimeline.aria')">
      <div
        class="unify-vp-timeline-resize-handle"
        @mousedown.prevent="$emit('start-resize', $event)"
        :title="$t('unify.vpTimeline.resizeTitle')"
        aria-hidden="true"
      ></div>
      <header class="unify-vp-timeline-header">
        <span class="unify-vp-timeline-title">{{ $t('unify.vpTimeline.title') }}</span>
        <span class="unify-vp-timeline-count" v-if="rows.length">{{ rows.length }}</span>
      </header>

      <div v-if="!rows.length" class="unify-vp-timeline-empty">
        {{ $t('unify.vpTimeline.empty') }}
      </div>

      <ul v-else class="unify-vp-timeline-list">
        <li
          v-for="row in rows"
          :key="row.vpId"
          class="unify-vp-timeline-row"
          :class="['is-status-' + row.status]"
          tabindex="0"
          role="button"
          :aria-label="row.displayName + ' — ' + statusLabel(row)"
          :title="$t('unify.vpTimeline.mention')"
          @click="$emit('mention-vp', row.vpId)"
          @keydown.enter.prevent="$emit('mention-vp', row.vpId)"
          @keydown.space.prevent="$emit('mention-vp', row.vpId)"
        >
          <VpAvatar
            :vp-id="row.vpId"
            :size="24"
            :typing="row.status === 'typing'"
          />
          <div class="unify-vp-timeline-row-body">
            <span class="unify-vp-timeline-row-name">{{ row.displayName }}</span>
            <span class="unify-vp-timeline-row-status">{{ statusLabel(row) }}</span>
            <span
              v-if="row.runningThreadCount > 1"
              class="unify-vp-timeline-thread-count"
              :title="threadCountTitle(row)"
            >{{ row.runningThreadCount }} threads</span>
          </div>
          <!--
            Right-side affordance cluster. Both buttons stop click
            propagation so they don't fall through to the row's primary
            mention action. The abort button is only visible while the VP
            is actually doing something; the info button is hover-revealed
            (CSS) so the row stays visually quiet at rest.
          -->
          <span class="unify-vp-timeline-row-actions">
            <span
              v-if="isActiveStatus(row.status)"
              class="unify-vp-timeline-abort"
              role="button"
              tabindex="0"
              :aria-label="$t('unify.vpTimeline.abort')"
              :title="$t('unify.vpTimeline.abort')"
              @click.stop="$emit('cancel-vp-turn', row.vpId)"
              @keydown.enter.stop.prevent="$emit('cancel-vp-turn', row.vpId)"
              @keydown.space.stop.prevent="$emit('cancel-vp-turn', row.vpId)"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
              </svg>
            </span>
            <span
              class="unify-vp-timeline-info"
              role="button"
              tabindex="0"
              :aria-label="$t('unify.vpTimeline.info')"
              :title="$t('unify.vpTimeline.info')"
              @click.stop="$emit('open-vp-detail', row.vpId)"
              @keydown.enter.stop.prevent="$emit('open-vp-detail', row.vpId)"
              @keydown.space.stop.prevent="$emit('open-vp-detail', row.vpId)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </span>
          </span>
        </li>
      </ul>
    </aside>
  `,
  setup() {
    // Capture $t ONCE at mount via getCurrentInstance(); reusing the
    // same reference for every status label avoids re-walking
    // appContext on every render (40 lookups for 20 rows otherwise).
    const inst = Vue.getCurrentInstance();
    const $t = (inst && inst.appContext.config.globalProperties.$t) || ((k) => k);

    const statusLabel = (row) => {
      switch (row.status) {
        case 'idle':      return $t('unify.vpTimeline.status.idle');
        case 'typing':    return $t('unify.vpTimeline.status.typing');
        case 'thinking':  return $t('unify.vpTimeline.status.thinking');
        case 'streaming': return $t('unify.vpTimeline.status.streaming');
        case 'tool':      return $t('unify.vpTimeline.status.tool');
        case 'error':     return $t('unify.vpTimeline.status.error');
        case 'offline':   return $t('unify.vpTimeline.status.offline');
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

    return { statusLabel, isActiveStatus, threadCountTitle };
  },
};
