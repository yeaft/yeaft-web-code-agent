/**
 * VpTimelinePane — PR-3 of the feature-pill double-track redesign.
 *
 * Left-of-conversation pane that surfaces, for the active Unify
 * conversation, one row per VP showing avatar + name + live status +
 * (when in-feature) feature title / trigger label / elapsed timer +
 * most-recent assistant snippet. Originally rendered to the right of the
 * conversation; the Unify layout realignment moved it inside
 * `unify-main` to match Crew's members-left shape. The component itself
 * is placement-agnostic — only its parent container + the resize handle
 * direction in CSS reflect the side it's on. Clicking a row drills into
 * that VP's detail view via the existing `open-vp-detail` event
 * (UnifyPage maps it onto `store.enterVpDetailView(vpId)` — same as
 * MessageList does today).
 *
 * Architecture: presentational only. Props down, emit up. Does NOT
 * import the chat store (mirroring the cleaner pattern Fowler I3 flagged
 * on FeaturePill in the PR-2 review). All data arrives via `rows` and
 * `nowMs`, both computed by UnifyPage.
 *
 * Props:
 *   rows  — TimelineRow[] (see web/stores/helpers/vp-timeline.js for shape).
 *   nowMs — current timestamp; ticked by UnifyPage every 1 s so the
 *           in-feature elapsed string updates without making the helper
 *           itself depend on time. The Vue.computed that builds `rows`
 *           does NOT consume `nowMs`, so the row list is only
 *           recomputed on real state change.
 *
 * Emits:
 *   open-vp-detail (vpId)  — single click or Enter / Space on a row.
 *   start-resize  (event)  — mousedown on the resize handle; UnifyPage
 *                            owns the drag bookkeeping (matches the
 *                            .unify-detail pattern).
 *   cancel-vp-turn (vpId)  — PR-4: user clicked the row's abort button.
 *                            Parent reverse-looks-up the most recently
 *                            started turnId for that VP via
 *                            `store.activeVpTurns` and calls
 *                            `store.cancelVpTurn(turnId)`.
 */
import VpAvatar from './VpAvatar.js';

export default {
  name: 'VpTimelinePane',
  components: { VpAvatar },
  emits: ['open-vp-detail', 'start-resize', 'cancel-vp-turn'],
  props: {
    rows: { type: Array, required: true },
    nowMs: { type: Number, default: 0 },
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
          @click="$emit('open-vp-detail', row.vpId)"
          @keydown.enter.prevent="$emit('open-vp-detail', row.vpId)"
          @keydown.space.prevent="$emit('open-vp-detail', row.vpId)"
        >
          <VpAvatar
            :vp-id="row.vpId"
            :size="24"
            :typing="row.status === 'typing'"
          />
          <div class="unify-vp-timeline-row-body">
            <div class="unify-vp-timeline-row-name">{{ row.displayName }}</div>
            <div class="unify-vp-timeline-row-status">
              <template v-if="row.status === 'in-feature'">
                <span class="unify-vp-timeline-feature-title">
                  {{ row.featureTitle || $t('unify.vpTimeline.untitledFeature') }}
                </span>
                <span v-if="row.featureTrigger" class="unify-vp-timeline-trigger">
                  {{ triggerLabel(row) }}
                </span>
                <span v-if="elapsedFor(row)" class="unify-vp-timeline-elapsed">
                  {{ elapsedFor(row) }}
                </span>
              </template>
              <span v-else>{{ statusLabel(row) }}</span>
            </div>
            <div v-if="row.lastSnippet" class="unify-vp-timeline-row-snippet">
              {{ row.lastSnippet }}
            </div>
          </div>
          <!--
            PR-4: per-row abort. Visible whenever the VP is still doing
            something (in-feature / streaming / typing). Idle rows have
            nothing to abort. role="button" + .stop modifiers keep the
            click from bubbling up to the row's drill-into-detail handler.
          -->
          <span
            v-if="row.status !== 'idle'"
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
        </li>
      </ul>
    </aside>
  `,
  setup(props) {
    // Resize handle bubbles a `start-resize` event that UnifyPage wires
    // to its mousedown handler. Keeping the drag bookkeeping in the
    // parent (matching the .unify-detail pattern at UnifyPage.js:312)
    // avoids re-implementing localStorage / clamp logic per pane. The
    // template's $emit fires the event directly — we don't need to
    // destructure `emit` from setup's context here.

    const i18nFor = (key) => {
      // Vue 3's globalProperties.$t is available via the component's
      // proxy. We keep this thin wrapper so the setup-side functions
      // below have a consistent way to look up labels.
      const app = Vue.getCurrentInstance();
      return app && app.appContext.config.globalProperties.$t
        ? app.appContext.config.globalProperties.$t(key)
        : key;
    };

    const statusLabel = (row) => {
      switch (row.status) {
        case 'idle':       return i18nFor('unify.vpTimeline.status.idle');
        case 'typing':     return i18nFor('unify.vpTimeline.status.typing');
        case 'streaming':  return i18nFor('unify.vpTimeline.status.streaming');
        case 'in-feature': {
          // For aria-label only; the visible row uses the title + trigger.
          const t = row.featureTitle || i18nFor('unify.vpTimeline.untitledFeature');
          return i18nFor('unify.vpTimeline.status.inFeature') + ' — ' + t;
        }
        default: return row.status;
      }
    };

    const triggerLabel = (row) => {
      switch (row.featureTrigger) {
        case 'quick': return i18nFor('unify.vpTimeline.trigger.quick');
        case 'turns': return i18nFor('unify.vpTimeline.trigger.turns');
        case 'tool':  return row.featureToolName || i18nFor('unify.vpTimeline.trigger.tool');
        default:      return row.featureTrigger || '';
      }
    };

    // Elapsed timer for an active feature. nowMs is ticked by the parent
    // every 1 s; the function reads `props.nowMs` (reactive) so the cell
    // re-renders without recomputing the row list.
    const elapsedFor = (row) => {
      if (row.featureStatus !== 'active') return '';
      if (!row.featureStartedAt) return '';
      if (!props.nowMs) return '';
      const diffSec = Math.max(0, Math.floor((props.nowMs - row.featureStartedAt) / 1000));
      if (diffSec < 60) return diffSec + 's';
      const m = Math.floor(diffSec / 60);
      const s = diffSec % 60;
      return s === 0 ? m + 'm' : m + 'm' + s + 's';
    };

    return { statusLabel, triggerLabel, elapsedFor };
  },
};
