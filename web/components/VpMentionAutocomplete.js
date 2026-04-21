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
 * Pure filter: prefer vpId-prefix hits, then displayName-substring hits.
 * Exported so the test suite can exercise without mounting Vue.
 *
 * @param {object[]} vps — store.vpList (each has {vpId, displayName, role?})
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
  const prefix = [];
  const substring = [];
  for (const vp of list) {
    if (!vp || !vp.vpId || vp.vpId === 'user') continue;
    const idLower = String(vp.vpId).toLowerCase();
    if (idLower.startsWith(q)) { prefix.push(vp); continue; }
    const dn = String(vp.displayName || '').toLowerCase();
    if (dn.includes(q)) { substring.push(vp); }
  }
  return [...prefix, ...substring].slice(0, VP_MENTION_MAX_RESULTS);
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
        <span class="slash-cmd-name">{{ vp.displayName || vp.vpId }}</span>
        <span class="slash-cmd-desc vp-mention-id">@{{ vp.vpId }}</span>
        <span v-if="vp.role" class="vp-mention-role">{{ vp.role }}</span>
      </div>
    </div>
  `,
  setup(props) {
    const filteredList = Vue.computed(() => filterVpMentions(props.vps, props.query));
    return { filteredList };
  },
};
