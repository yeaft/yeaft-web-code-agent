/**
 * Yeaft Cosmos — Interstellar Signal Stream (Top-Right Unified Notification & Unread Reply Feed)
 *
 * Unifies AskUser prompts (waiting), unread finished replies, scheduled task notifications,
 * and lightweight 1-line active turns into a single non-intrusive floating stream:
 * - Desktop free stage: up to 3 borderless atmospheric glass cards floating directly below
 *   top-right micro-actions (expandable in place, zero outer chrome box, zero obstruction when empty).
 * - Desktop with drawer open: collapses cleanly into the top-right signal capsule beside the
 *   drawer's left edge; clicking opens a popover to chain-read remaining unread sessions without
 *   closing the drawer.
 * - Mobile portrait (<=768px): compact top-right capsule + optional 1-card arrival toast banner
 *   and slide-down translucent sheet so the Solar System stays completely unobstructed.
 */

const MAX_FLOATING_CARDS = 3;

export default {
  name: 'CosmosSignalStream',
  props: {
    items: { type: Array, default: () => [] },
    waitingCount: { type: Number, default: 0 },
    unreadCount: { type: Number, default: 0 },
    runningCount: { type: Number, default: 0 },
    badgeCount: { type: Number, default: 0 },
    dismissibleCount: { type: Number, default: 0 },
    drawerOpen: { type: Boolean, default: false },
    isCompact: { type: Boolean, default: false },
    /** '2' | '3' | 'collapsed' */
    previewMode: { type: String, default: '2' },
    /** Controlled popover/drawer-sheet open state (used when drawerOpen, isCompact, or default-collapsed). */
    popoverOpen: { type: Boolean, default: false },
    /** Desktop free-stage user collapse toggle (overrides default visible float). */
    streamHidden: { type: Boolean, default: false },
    /** Suppress overlapping when Cosmic Constants popover or telescope observation is active. */
    suppressed: { type: Boolean, default: false },
    /** Suppress floating cards & mobile banner (e.g. in Galaxy band or Creation interior) while keeping popover accessible. */
    suppressFloating: { type: Boolean, default: false },
  },
  emits: ['open-signal', 'dismiss-signal', 'mark-all-read', 'close-popover'],
  template: `
    <!-- Quiet screen-reader announcement strictly on newly arrived waiting/unread signals -->
    <div class="cosmos-sr-only" role="status" aria-live="polite" aria-atomic="true">{{ srAnnouncement }}</div>

    <!-- 1. Desktop Free-Stage Floating Signal Stream (Frameless Atmospheric Cards) -->
    <aside
      v-if="showFreeFloatingStream"
      class="cosmos-signal-stream"
      :class="{ 'is-expanded': expanded }"
      :aria-label="$t('cosmos.signals.title')"
      @pointerdown.stop
      @wheel.stop
    >
      <TransitionGroup name="cosmos-sig" tag="div" class="cosmos-signal-stack">
        <article
          v-for="item in visibleFloatingItems"
          :key="item.signalKey"
          class="cosmos-signal-card"
          :class="[
            'is-' + item.kind,
            { 'is-error': item.isError, 'is-scheduled': Boolean(item.scheduledTask) }
          ]"
          :data-planet-theme="item.planetId"
          :data-signal-key="item.signalKey"
        >
          <button
            type="button"
            class="cosmos-signal-main"
            @click="$emit('open-signal', item)"
          >
            <div class="cosmos-signal-head">
              <span class="cosmos-signal-origin">
                <span class="cosmos-signal-dot" :class="item.kind" aria-hidden="true"></span>
                <span class="cosmos-signal-agent">{{ item.agentName }}</span>
                <span class="cosmos-signal-sep" aria-hidden="true">·</span>
                <span class="cosmos-signal-title">{{ item.sessionTitle }}</span>
              </span>
              <span class="cosmos-signal-meta">
                <span
                  v-if="item.kind === 'waiting'"
                  class="cosmos-signal-chip is-waiting"
                >{{ $t('cosmos.signals.waitingBadge') }}</span>
                <span
                  v-else-if="item.scheduledTask"
                  class="cosmos-signal-chip"
                  :class="item.isError ? 'is-error' : 'is-scheduled'"
                  :title="scheduledTooltip(item)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/></svg>
                  <span v-if="item.isError">{{ $t('cosmos.signals.failedBadge') }}</span>
                </span>
                <span v-if="item.timeLabel" class="cosmos-signal-time">{{ item.timeLabel }}</span>
              </span>
            </div>

            <div
              class="cosmos-signal-body"
              :class="item.kind === 'running' ? 'lines-1' : (previewLines === 3 ? 'lines-3' : 'lines-2')"
            >{{ item.preview }}</div>
          </button>

          <button
            v-if="item.dismissible"
            type="button"
            class="cosmos-signal-ack"
            :title="$t('cosmos.signals.markRead')"
            :aria-label="$t('cosmos.signals.markRead')"
            @click.stop="$emit('dismiss-signal', item)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
          </button>
        </article>
      </TransitionGroup>

      <!-- Subtle Overflow & Mark-All-Read Footer Bar -->
      <div v-if="showFooterBar" class="cosmos-signal-footer">
        <button
          v-if="hiddenCount > 0 || expanded"
          type="button"
          class="cosmos-signal-foot-btn"
          :aria-expanded="expanded ? 'true' : 'false'"
          @click="expanded = !expanded"
        >
          <span>{{ expanded ? $t('cosmos.signals.collapse') : $t('cosmos.signals.more', { count: hiddenCount }) }}</span>
          <svg class="cosmos-signal-chev" :class="{ 'is-open': expanded }" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <span v-else class="cosmos-signal-foot-spacer"></span>

        <button
          v-if="dismissibleCount > 0"
          type="button"
          class="cosmos-signal-foot-btn is-mark-all"
          @click="$emit('mark-all-read')"
        >{{ $t('cosmos.signals.markAllRead') }}</button>
      </div>
    </aside>

    <!-- 2. Mobile Compact Arrival Micro-Banner (1 latest unread/waiting card, non-blocking) -->
    <div
      v-if="showMobileBanner && mobileBannerItem"
      class="cosmos-signal-mobile-banner"
      :class="['is-' + mobileBannerItem.kind, { 'is-error': mobileBannerItem.isError }]"
      :data-planet-theme="mobileBannerItem.planetId"
      @pointerdown.stop
      @wheel.stop
    >
      <button
        type="button"
        class="cosmos-signal-main"
        @click="$emit('open-signal', mobileBannerItem)"
      >
        <div class="cosmos-signal-head">
          <span class="cosmos-signal-origin">
            <span class="cosmos-signal-dot" :class="mobileBannerItem.kind" aria-hidden="true"></span>
            <span class="cosmos-signal-agent">{{ mobileBannerItem.agentName }}</span>
            <span class="cosmos-signal-sep" aria-hidden="true">·</span>
            <span class="cosmos-signal-title">{{ mobileBannerItem.sessionTitle }}</span>
          </span>
          <span v-if="mobileBannerItem.timeLabel" class="cosmos-signal-time">{{ mobileBannerItem.timeLabel }}</span>
        </div>
        <div class="cosmos-signal-body lines-2">{{ mobileBannerItem.preview }}</div>
      </button>
      <button
        type="button"
        class="cosmos-signal-banner-close"
        :title="$t('cosmos.signals.dismissBanner')"
        :aria-label="$t('cosmos.signals.dismissBanner')"
        @click.stop="dismissMobileBanner"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>

    <!-- 3. Popover / Sheet Mode (Drawer-Open Chain-Reader, Mobile Sheet, or Collapsed-Mode Popover) -->
    <section
      v-if="popoverOpen"
      class="cosmos-signal-popover"
      :class="{ 'is-drawer-docked': drawerOpen && !isCompact, 'is-mobile': isCompact }"
      role="dialog"
      :aria-label="$t('cosmos.signals.title')"
      @pointerdown.stop
      @wheel.stop
    >
      <div class="cosmos-signal-pop-head">
        <div class="cosmos-signal-pop-title-group">
          <span class="cosmos-signal-pop-title">{{ $t('cosmos.signals.title') }}</span>
          <span v-if="badgeCount > 0" class="cosmos-signal-pop-count" :class="{ 'is-waiting': waitingCount > 0 }">{{ badgeCount }}</span>
        </div>
        <div class="cosmos-signal-pop-actions">
          <button
            v-if="dismissibleCount > 0"
            type="button"
            class="cosmos-signal-foot-btn is-mark-all"
            @click="$emit('mark-all-read')"
          >{{ $t('cosmos.signals.markAllRead') }}</button>
          <button
            type="button"
            class="cosmos-signal-pop-close"
            :aria-label="$t('cosmos.panel.close')"
            @click="$emit('close-popover')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </div>

      <div v-if="items.length === 0" class="cosmos-signal-empty">
        <span class="cosmos-signal-empty-star" aria-hidden="true">✦</span>
        <span>{{ $t('cosmos.signals.empty') }}</span>
      </div>

      <div v-else class="cosmos-signal-pop-list">
        <article
          v-for="item in items"
          :key="item.signalKey"
          class="cosmos-signal-card"
          :class="[
            'is-' + item.kind,
            { 'is-error': item.isError, 'is-scheduled': Boolean(item.scheduledTask) }
          ]"
          :data-planet-theme="item.planetId"
          :data-signal-key="item.signalKey"
        >
          <button
            type="button"
            class="cosmos-signal-main"
            @click="$emit('open-signal', item)"
          >
            <div class="cosmos-signal-head">
              <span class="cosmos-signal-origin">
                <span class="cosmos-signal-dot" :class="item.kind" aria-hidden="true"></span>
                <span class="cosmos-signal-agent">{{ item.agentName }}</span>
                <span class="cosmos-signal-sep" aria-hidden="true">·</span>
                <span class="cosmos-signal-title">{{ item.sessionTitle }}</span>
              </span>
              <span class="cosmos-signal-meta">
                <span
                  v-if="item.kind === 'waiting'"
                  class="cosmos-signal-chip is-waiting"
                >{{ $t('cosmos.signals.waitingBadge') }}</span>
                <span
                  v-else-if="item.scheduledTask"
                  class="cosmos-signal-chip"
                  :class="item.isError ? 'is-error' : 'is-scheduled'"
                  :title="scheduledTooltip(item)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/></svg>
                  <span v-if="item.isError">{{ $t('cosmos.signals.failedBadge') }}</span>
                </span>
                <span v-if="item.timeLabel" class="cosmos-signal-time">{{ item.timeLabel }}</span>
              </span>
            </div>

            <div
              class="cosmos-signal-body"
              :class="item.kind === 'running' ? 'lines-1' : (previewLines === 3 ? 'lines-3' : 'lines-2')"
            >{{ item.preview }}</div>
          </button>

          <button
            v-if="item.dismissible"
            type="button"
            class="cosmos-signal-ack"
            :title="$t('cosmos.signals.markRead')"
            :aria-label="$t('cosmos.signals.markRead')"
            @click.stop="$emit('dismiss-signal', item)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
          </button>
        </article>
      </div>
    </section>
  `,
  setup(props) {
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const expanded = Vue.ref(false);
    const dismissedBannerSignature = Vue.ref('');
    const srAnnouncement = Vue.ref('');
    let seenAttentionKeys = new Set();

    const previewLines = Vue.computed(() => (props.previewMode === '3' ? 3 : 2));
    const defaultCollapsed = Vue.computed(() => props.previewMode === 'collapsed');

    const showFreeFloatingStream = Vue.computed(() => (
      !props.drawerOpen
      && !props.isCompact
      && !props.suppressed
      && !props.suppressFloating
      && !props.popoverOpen
      && !defaultCollapsed.value
      && !props.streamHidden
      && props.items.length > 0
    ));

    const visibleFloatingItems = Vue.computed(() => (
      expanded.value ? props.items : props.items.slice(0, MAX_FLOATING_CARDS)
    ));

    const hiddenCount = Vue.computed(() => Math.max(0, props.items.length - MAX_FLOATING_CARDS));

    const showFooterBar = Vue.computed(() => (
      hiddenCount.value > 0
      || expanded.value
      || props.dismissibleCount >= 2
    ));

    const mobileBannerItem = Vue.computed(() => (
      props.items.find((item) => item.kind === 'waiting' || item.kind === 'unread') || null
    ));

    const mobileBannerSignature = Vue.computed(() => {
      const item = mobileBannerItem.value;
      return item ? `${item.signalKey}:${item.kind}:${item.activityAt}` : '';
    });

    const showMobileBanner = Vue.computed(() => (
      props.isCompact
      && !props.drawerOpen
      && !props.popoverOpen
      && !props.suppressed
      && !props.suppressFloating
      && !defaultCollapsed.value
      && Boolean(mobileBannerItem.value)
      && mobileBannerSignature.value !== dismissedBannerSignature.value
    ));

    Vue.watch(
      () => props.items.filter((i) => i.kind === 'waiting' || i.kind === 'unread').map((i) => `${i.signalKey}:${i.kind}`),
      (nextKeys, prevKeys) => {
        const currentSet = new Set(nextKeys);
        if (Array.isArray(prevKeys)) {
          const fresh = props.items.find((i) => (i.kind === 'waiting' || i.kind === 'unread')
            && !seenAttentionKeys.has(`${i.signalKey}:${i.kind}`));
          if (fresh) {
            srAnnouncement.value = `${fresh.agentName} · ${fresh.sessionTitle}: ${fresh.preview}`;
          }
        }
        seenAttentionKeys = currentSet;
      },
      { immediate: true },
    );

    Vue.watch(() => props.items.length, (len) => {
      if (len <= MAX_FLOATING_CARDS) expanded.value = false;
    });

    Vue.watch(() => props.drawerOpen, (open) => {
      if (open) expanded.value = false;
    });

    function dismissMobileBanner() {
      dismissedBannerSignature.value = mobileBannerSignature.value;
    }

    function scheduledTooltip(item) {
      if (!item?.scheduledTask) return '';
      const statusKey = `scheduledTasks.status.${item.scheduledTask.status || 'completed'}`;
      const statusText = $t(statusKey) === statusKey ? (item.scheduledTask.status || '') : $t(statusKey);
      return `${$t('cosmos.signals.scheduledTag')} · ${statusText}`;
    }

    return {
      expanded,
      srAnnouncement,
      previewLines,
      showFreeFloatingStream,
      visibleFloatingItems,
      hiddenCount,
      showFooterBar,
      mobileBannerItem,
      showMobileBanner,
      dismissMobileBanner,
      scheduledTooltip,
    };
  },
};
