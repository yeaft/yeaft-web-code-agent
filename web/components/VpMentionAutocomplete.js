/**
 * VpMentionAutocomplete — task-334j §B.
 *
 * `@` autocomplete dropdown that sources Virtual Person records from the
 * global VP store (`web/stores/vp.js#vpList`). Mounted alongside the
 * existing slash + expert autocompletes in `ChatInput.js`. Gated by the
 * parent (ChatInput decides when to show based on task/group context);
 * this component is pure presentation + selection emission.
 *
 * Keyboard navigation is owned by the PARENT (ChatInput) via the exposed
 * `selectedIndex` ref — mirrors the existing slash/expert autocomplete
 * pattern (↑↓ cycle, Enter/Tab select, Esc close, Backspace past `@`
 * close). We expose `filteredList` + the selection helper so the parent
 * can drive without duplicating filter logic.
 *
 * Props:
 *   vps: the reactive VP array (e.g. store.vpList)
 *   query: current text after `@` (lowercased). '' → show all (up to 12).
 *   selectedIndex: 0-based cursor into filteredList.
 *
 * Emits:
 *   select (vp) — the VP record the user chose.
 *   hover-index (idx) — on mouseenter; parent mirrors into selectedIndex.
 */
import VpAvatar from './VpAvatar.js';

/** Max results shown in the dropdown (aligned with existing expert autocomplete). */
export const VP_MENTION_MAX_RESULTS = 12;

/**
 * Pure filter: prefer vpId-prefix hits, then alias-prefix (pinyin), then
 * displayName / displayNameZh substring hits.
 *
 * task-fix (5-bugs): aliases typically include pinyin transliterations
 * (e.g. `qiaobusi` for 乔布斯). Typing "qi" or "qiao" picks up the seed
 * VP Steve Jobs even though his canonical id is `steve`.
 *
 * Exported so the test suite can exercise without mounting Vue.
 *
 * @param {object[]} vps — store.vpList (each has {vpId, displayName, displayNameZh?, aliases?, role?})
 * @param {string} query — raw query text (not yet lowercased)
 * @returns {object[]} up to VP_MENTION_MAX_RESULTS matches.
 */
export function filterVpMentions(vps, query) {
  const list = Array.isArray(vps) ? vps : [];
  const q = typeof query === 'string' ? query.toLowerCase() : '';
  if (!q) {
    return list
      .filter(v => v && v.vpId && v.vpId !== 'user')
      .slice(0, VP_MENTION_MAX_RESULTS);
  }
  const idPrefix = [];
  const aliasPrefix = [];
  const nameSubstring = [];
  const seen = new Set();
  const take = (vp, bucket) => {
    if (seen.has(vp.vpId)) return;
    seen.add(vp.vpId);
    bucket.push(vp);
  };
  for (const vp of list) {
    if (!vp || !vp.vpId || vp.vpId === 'user') continue;
    const idLower = String(vp.vpId).toLowerCase();
    if (idLower.startsWith(q)) { take(vp, idPrefix); continue; }

    const aliases = Array.isArray(vp.aliases) ? vp.aliases : [];
    let aliasHit = false;
    for (const alias of aliases) {
      const al = String(alias || '').toLowerCase();
      if (al && al.startsWith(q)) { aliasHit = true; break; }
    }
    if (aliasHit) { take(vp, aliasPrefix); continue; }

    const dn = String(vp.displayName || '').toLowerCase();
    const dnZh = String(vp.displayNameZh || ''); // Chinese — do not lowercase
    if (dn.includes(q) || dnZh.includes(query || '')) {
      take(vp, nameSubstring);
    }
  }
  return [...idPrefix, ...aliasPrefix, ...nameSubstring].slice(0, VP_MENTION_MAX_RESULTS);
}

/**
 * Pure helper: pick the VP records that should appear in the `@` dropdown
 * given the full library and the active group (if any).
 *
 * Rules:
 *   - No active group (single-agent / no group context): return the full
 *     library. This preserves the legacy single-agent autocomplete.
 *   - Active group: return ONLY the VPs that are on the group's roster.
 *     Off-roster VPs are hidden entirely — you can't @-mention someone
 *     who isn't in the conversation, and the dropdown shouldn't tempt
 *     the user to try. An empty roster means an empty dropdown; this
 *     matches the VP timeline (`selectGroupRosterVpList` in
 *     `web/stores/helpers/vp-timeline.js`) and the autocomplete's
 *     `v-if="filteredList.length > 0"` then hides the popover entirely.
 *
 * See also: `selectGroupRosterVpList` is a deliberately-different sibling
 *   — it preserves roster order and stubs ghost ids for the timeline,
 *   whereas this helper preserves library order and drops ghosts so the
 *   mention dropdown never offers something we can't render.
 *
 * @param {object[]|null|undefined} vpList — the full VP library (typically vpStore.vpList).
 * @param {{ roster?: string[] }|null|undefined} group — the active group's record.
 * @returns {object[]} the candidate list (NOT yet filtered by query).
 */
export function selectMentionCandidates(vpList, group) {
  const full = Array.isArray(vpList) ? vpList : [];
  if (!group) return full;
  const roster = Array.isArray(group.roster) ? group.roster : [];
  if (roster.length === 0) return [];
  const allowed = new Set(roster);
  return full.filter((vp) => vp && vp.vpId && allowed.has(vp.vpId));
}

/**
 * Pure text-edit helper: given the current textarea value and a chosen
 * vpId, replace the active `@query` token with `@vpId ` and return the
 * new text. Exported for unit-test coverage of the replacement math.
 *
 * The active token runs from the last `@` (inclusive) to `endOfToken`,
 * which is the index of the first whitespace/punctuation after `@` or
 * end-of-string.
 */
export function applyMentionSelection(text, vpId) {
  if (typeof text !== 'string' || !vpId) return text;
  const atIdx = text.lastIndexOf('@');
  if (atIdx < 0) return text;
  // Find end of the token (first whitespace after @)
  let end = atIdx + 1;
  while (end < text.length && !/[\s]/.test(text[end])) end++;
  return text.slice(0, atIdx) + '@' + vpId + ' ' + text.slice(end);
}

export default {
  name: 'VpMentionAutocomplete',
  components: { VpAvatar },
  emits: ['select', 'hover-index'],
  props: {
    vps: { type: Array, default: () => [] },
    query: { type: String, default: '' },
    selectedIndex: { type: Number, default: 0 },
  },
  template: `
    <div class="slash-autocomplete vp-mention-autocomplete" v-if="filteredList.length > 0">
      <div class="slash-group-label">{{ $t('unify.vp.mention.placeholder') }}</div>
      <div
        v-for="(vp, idx) in filteredList"
        :key="vp.vpId"
        class="slash-autocomplete-item"
        :class="{ active: idx === selectedIndex }"
        @mousedown.prevent="$emit('select', vp)"
        @mouseenter="$emit('hover-index', idx)"
      >
        <VpAvatar :vp-id="vp.vpId" :size="20" />
        <span class="slash-cmd-name">{{ displayNameFor(vp) }}</span>
        <span class="slash-cmd-desc vp-mention-id">@{{ vp.vpId }}</span>
        <span v-if="vp.role" class="vp-mention-role">{{ vp.role }}</span>
      </div>
    </div>
  `,
  setup(props) {
    const filteredList = Vue.computed(() => filterVpMentions(props.vps, props.query));
    // task-fix (5-bugs): locale-aware display name. zh-* prefers displayNameZh.
    //
    // Locale must be read reactively: previously this read
    // `localStorage.getItem('locale')` directly, which is not reactive and
    // left the mention list stale across language switches. Read from the
    // chat store's Pinia-reactive `locale` field instead so the template
    // re-renders when the user flips the dropdown.
    const chatStore = (typeof window !== 'undefined' && window.Pinia && window.Pinia.useChatStore)
      ? window.Pinia.useChatStore()
      : null;
    function displayNameFor(vp) {
      if (!vp) return '';
      const locale = (chatStore && typeof chatStore.locale === 'string')
        ? chatStore.locale
        : ((typeof localStorage !== 'undefined' && localStorage.getItem('locale')) || '');
      if (locale.startsWith('zh') && vp.displayNameZh) return vp.displayNameZh;
      return vp.displayName || vp.vpId || '';
    }
    return { filteredList, displayNameFor };
  },
};
