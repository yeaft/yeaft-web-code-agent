/**
 * VpDetailView.js — task-334-ui-c.
 *
 * Read-only detail page for a single Virtual Person. Reached by clicking a
 * VpAvatar / VpBadge / VP library row. Shows displayName, role, traits,
 * modelHint, persona body (read-only), recent activity, and a personaHash
 * badge. Edit / CRUD is out of scope — entry point jumps to 334-ui-g.
 *
 * View state machine (aligns with task-315 + task-303):
 *   main  ──click VP badge──▶ vp-detail
 *   vp-detail ──Esc / breadcrumb ←──▶ main
 *
 * Reuses 334-ui-a components:
 *   • VpAvatar — large (48px) hero avatar
 *   • VpBadge is NOT reused here because the detail hero lays out
 *     name + role differently; using the raw VpAvatar keeps the
 *     "compose primitives, don't sub-route" rule.
 *
 * Accessibility: focusable back button, Esc handled at UnifyPage level
 * (shared cascade with task-detail / thread-filter).
 */
import VpAvatar from './VpAvatar.js';
import { reasonToI18nKey } from '../utils/vp-reason.js';

export default {
  name: 'VpDetailView',
  components: { VpAvatar },
  emits: ['back'],
  props: {
    vpId: { type: String, required: true },
  },
  template: `
    <div class="vp-detail-view" role="region" :aria-label="$t('unify.vp.detail.title')">
      <div class="vp-detail-breadcrumb">
        <button
          class="vp-detail-back"
          type="button"
          :aria-label="$t('unify.vp.detail.backAria')"
          :title="$t('unify.vp.detail.backAria')"
          @click="$emit('back')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
          <span>{{ $t('unify.vp.detail.back') }}</span>
        </button>
      </div>

      <div class="vp-detail-body" v-if="vp">
        <header class="vp-detail-hero">
          <VpAvatar :vp-id="vpId" :size="48" />
          <div class="vp-detail-hero-text">
            <h2 class="vp-detail-name">{{ vp.displayName || vpId }}</h2>
            <p class="vp-detail-role" v-if="vp.role">{{ vp.role }}</p>
            <span
              v-if="vp.personaHash"
              class="vp-detail-persona-hash"
              :title="personaHashTitle"
              :aria-label="personaHashTitle"
            >#{{ shortHash }}</span>
          </div>
        </header>

        <section class="vp-detail-section">
          <h3 class="vp-detail-section-title">{{ $t('unify.vp.detail.traits') }}</h3>
          <ul class="vp-detail-traits" v-if="traits.length">
            <li v-for="t in traits" :key="t" class="vp-detail-trait-chip">{{ t }}</li>
          </ul>
          <p v-else class="vp-detail-empty">{{ $t('unify.vp.detail.traitsEmpty') }}</p>
        </section>

        <section class="vp-detail-section">
          <h3 class="vp-detail-section-title">{{ $t('unify.vp.detail.modelHint') }}</h3>
          <p class="vp-detail-model-hint">
            <code v-if="vp.modelHint">{{ vp.modelHint }}</code>
            <span v-else class="vp-detail-empty">{{ $t('unify.vp.detail.modelHintEmpty') }}</span>
          </p>
        </section>

        <section class="vp-detail-section">
          <h3 class="vp-detail-section-title">{{ $t('unify.vp.detail.persona') }}</h3>
          <pre class="vp-detail-persona" v-if="personaBody">{{ personaBody }}</pre>
          <p v-else class="vp-detail-empty">{{ $t('unify.vp.detail.personaEmpty') }}</p>
        </section>

        <section class="vp-detail-section">
          <h3 class="vp-detail-section-title">{{ $t('unify.vp.detail.activity') }}</h3>
          <ul class="vp-detail-activity" v-if="activityRows.length">
            <li v-for="row in activityRows" :key="row.key" class="vp-detail-activity-row" :class="'kind-' + row.kind">
              <span class="vp-detail-activity-time">{{ row.timeLabel }}</span>
              <span class="vp-detail-activity-text">{{ row.text }}</span>
              <span v-if="row.reasonKey" class="vp-detail-activity-reason">{{ $t(row.reasonKey) }}</span>
            </li>
          </ul>
          <p v-else class="vp-detail-empty">{{ $t('unify.vp.detail.activityEmpty') }}</p>
          <p class="vp-detail-activity-hint">{{ $t('unify.vp.detail.activityPrivate') }}</p>
        </section>

        <p class="vp-detail-edit-hint">{{ $t('unify.vp.detail.editHint') }}</p>
      </div>

      <div class="vp-detail-missing" v-else>
        <p>{{ $t('unify.vp.detail.notFound') }}</p>
      </div>
    </div>
  `,
  setup(props) {
    const vpStore = (window.Pinia && window.Pinia.useVpStore)
      ? window.Pinia.useVpStore()
      : null;
    const chatStore = (window.Pinia && window.Pinia.useChatStore)
      ? window.Pinia.useChatStore()
      : null;

    const vp = Vue.computed(() => {
      if (!vpStore) return null;
      return vpStore.vpById(props.vpId);
    });

    const traits = Vue.computed(() => {
      const v = vp.value;
      return Array.isArray(v && v.traits) ? v.traits : [];
    });

    // Persona body is agent-sent (optional in wire payload). The snapshot
    // path doesn't always include it today — we surface whatever the store
    // has and leave the empty-state message when absent.
    const personaBody = Vue.computed(() => {
      const v = vp.value;
      return v && typeof v.persona === 'string' ? v.persona : '';
    });

    const shortHash = Vue.computed(() => {
      const h = vp.value && vp.value.personaHash;
      if (!h) return '';
      return String(h).slice(0, 8);
    });

    const personaHashTitle = Vue.computed(() => {
      const h = vp.value && vp.value.personaHash;
      if (!h) return '';
      // Pass the full hash — aria-label / title always give the whole value.
      return String(h);
    });

    // ── Recent activity ────────────────────────────────────────
    // Pull messages whose `speakerVpId` matches this VP from the current
    // conversation. Cheap O(n) filter on the visible log — the detail
    // view is only entered on user click so per-frame cost doesn't matter.
    // Merge in the one-shot `lastChange` live-diff row so the user sees
    // "Persona updated just now" without having to open the library.
    // task-private messages are a future R3 feature — stubbed with a hint.
    const activityRows = Vue.computed(() => {
      const rows = [];
      if (chatStore) {
        const convId = chatStore.unifyConversationId;
        const msgs = convId ? (chatStore.messagesMap[convId] || []) : [];
        // Limit to the 10 most recent VP-authored messages to keep the
        // detail view skim-able.
        const matches = [];
        for (let i = msgs.length - 1; i >= 0 && matches.length < 10; i--) {
          const m = msgs[i];
          if (m && m.speakerVpId === props.vpId) matches.push(m);
        }
        for (const m of matches) {
          const ts = m.timestamp || m.createdAt || 0;
          rows.push({
            key: 'msg-' + (m.id || ts),
            kind: 'message',
            timeLabel: ts ? formatTime(ts) : '',
            text: excerpt(m),
            reasonKey: null,
          });
        }
      }
      if (vpStore && vpStore.lastChange && vpStore.lastChange.vpId === props.vpId) {
        const ch = vpStore.lastChange;
        rows.unshift({
          key: 'diff-' + ch.at,
          kind: 'diff-' + (ch.kind || 'updated'),
          timeLabel: ch.at ? formatTime(ch.at) : '',
          text: ch.kind === 'removed'
            ? '' // reason carries the label
            : '',
          reasonKey: reasonToI18nKey(ch.reason),
        });
      }
      return rows;
    });

    return {
      vp,
      traits,
      personaBody,
      shortHash,
      personaHashTitle,
      activityRows,
    };
  },
};

// ── Helpers (module-local) ─────────────────────────────────────
function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

function excerpt(m) {
  if (!m) return '';
  // Messages may be a string (legacy) or structured AssistantTurn blob.
  if (typeof m.content === 'string') {
    const s = m.content.trim();
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }
  if (m.textContent && typeof m.textContent === 'string') {
    const s = m.textContent.trim();
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }
  return '';
}
