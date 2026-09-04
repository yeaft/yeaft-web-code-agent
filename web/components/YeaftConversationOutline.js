function parseHistoryTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function historyResultIdentity(result) {
  return result?.entryId || result?.messageId || null;
}

function formatOutlineTime(value) {
  const timestamp = parseHistoryTime(value);
  if (timestamp === null) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export function sortHistoryResultsNewest(results) {
  return (Array.isArray(results) ? results : [])
    .map((result, index) => ({
      result,
      index,
      time: parseHistoryTime(result?.timestamp),
      seq: Number.isFinite(result?.entryEndSeq)
        ? result.entryEndSeq
        : (Number.isFinite(result?.seq) ? result.seq : null),
      messageId: String(result?.messageId || ''),
    }))
    .sort((a, b) => {
      if (a.seq === null && b.seq !== null) return -1;
      if (a.seq !== null && b.seq === null) return 1;
      if (a.seq !== null && a.seq !== b.seq) return b.seq - a.seq;
      if (a.time !== null && b.time === null) return -1;
      if (a.time === null && b.time !== null) return 1;
      if (a.time !== null && a.time !== b.time) return b.time - a.time;
      const idComparison = b.messageId.localeCompare(a.messageId);
      return idComparison || a.index - b.index;
    })
    .map(({ result }) => result);
}

export default {
  name: 'YeaftConversationOutline',
  props: {
    outlineState: { type: Object, required: true },
    searchState: { type: Object, required: true },
    activeMessageId: { type: String, default: null },
  },
  emits: ['query', 'select', 'move', 'preview', 'load-older', 'load-more-search', 'retry', 'close'],
  template: `
    <section id="yeaft-conversation-outline" class="yeaft-conversation-outline" :aria-label="$t('yeaft.outline.label')">
      <div class="yeaft-conversation-outline-header">
        <div>
          <strong>{{ $t('yeaft.outline.title') }}</strong>
          <span class="yeaft-conversation-outline-count">{{ countLabel }}</span>
        </div>
        <button type="button" class="yeaft-conversation-outline-close" @click="$emit('close')" :aria-label="$t('common.close')">×</button>
      </div>
      <div class="yeaft-conversation-outline-toolbar">
        <div class="yeaft-conversation-outline-search">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input
            ref="inputRef"
            type="search"
            :value="searchState.query"
            :placeholder="$t('yeaft.outline.placeholder')"
            :aria-label="$t('yeaft.outline.placeholder')"
            @input="$emit('query', $event.target.value)"
            @keydown="onKeyDown"
          />
          <span v-if="searchState.loading" class="yeaft-conversation-outline-status">{{ $t('yeaft.outline.searching') }}</span>
        </div>
      </div>
      <div
        ref="listRef"
        class="yeaft-conversation-outline-list"
        role="listbox"
        @scroll="onScroll"
      >
        <div v-if="errorKey" class="yeaft-conversation-outline-empty is-error" role="alert">
          <span>{{ $t(errorKey) }}</span>
          <button v-if="canRetry" type="button" class="btn-secondary" @click="$emit('retry')">{{ $t('common.retry') }}</button>
        </div>
        <div v-else-if="!visibleResults.length && !isLoading" class="yeaft-conversation-outline-empty">{{ $t(isSearching ? 'yeaft.outline.noMatches' : 'yeaft.outline.empty') }}</div>
        <button
          v-for="(result, index) in visibleResults"
          :key="historyResultIdentity(result)"
          type="button"
          class="yeaft-conversation-outline-item"
          :class="{ active: index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex ? 'true' : 'false'"
          @mouseenter="previewResult(result)"
          @focus="previewResult(result)"
          @click="$emit('select', result)"
        >
          <span class="yeaft-conversation-outline-meta">
            <span>{{ result.role === 'user' ? $t('yeaft.outline.you') : (result.speakerVpId || $t('yeaft.outline.assistant')) }}</span>
            <time v-if="result.timestamp">{{ formatOutlineTime(result.timestamp) }}</time>
          </span>
          <span class="yeaft-conversation-outline-snippet">{{ result.snippet || $t('yeaft.outline.nonText') }}</span>
        </button>
        <button
          v-if="!isSearching && outlineState.hasMore"
          type="button"
          class="yeaft-conversation-outline-more"
          :disabled="outlineState.loading"
          @click="loadOlder"
        >{{ outlineState.loading ? $t('yeaft.outline.loading') : $t('yeaft.outline.older') }}</button>
        <button
          v-if="isSearching && searchState.hasMore"
          type="button"
          class="yeaft-conversation-outline-more"
          :disabled="searchState.loading"
          @click="$emit('load-more-search')"
        >{{ $t('yeaft.outline.moreMatches') }}</button>
      </div>
    </section>
  `,
  setup(props, { emit, expose }) {
    const inputRef = Vue.ref(null);
    const listRef = Vue.ref(null);
    const isSearching = Vue.computed(() => (
      Array.from(String(props.searchState.query || '').trim()).length > 0
      || !!props.searchState.senderKey
    ));
    const visibleResults = Vue.computed(() => sortHistoryResultsNewest(
      isSearching.value ? props.searchState.results : props.outlineState.results,
    ));
    const activeIndex = Vue.computed(() => {
      const index = visibleResults.value.findIndex(result => historyResultIdentity(result) === props.activeMessageId);
      return index >= 0 ? index : 0;
    });
    const isLoading = Vue.computed(() => isSearching.value ? props.searchState.loading : props.outlineState.loading);
    const activeError = Vue.computed(() => (
      isSearching.value ? props.searchState.error : props.outlineState.error
    ));
    const countLabel = Vue.computed(() => {
      if (activeError.value) return '—';
      if (isSearching.value) return `${props.searchState.results.length}${props.searchState.hasMore ? '+' : ''}`;
      const total = props.outlineState.totalCount;
      return Number.isFinite(total) ? String(total) : String(props.outlineState.results.length || '');
    });
    const errorKey = Vue.computed(() => {
      const error = activeError.value;
      if (!error) return '';
      if (error === 'unsupported') return 'yeaft.outline.unsupported';
      if (error === 'timeout') return 'yeaft.outline.timeout';
      if (error === 'index_unavailable') return 'yeaft.outline.indexUnavailable';
      return 'yeaft.outline.error';
    });
    const canRetry = Vue.computed(() => !!activeError.value && activeError.value !== 'unsupported');
    const focus = () => Vue.nextTick(() => {
      inputRef.value?.focus?.();
      if (listRef.value) listRef.value.scrollTop = 0;
    });
    const loadOlder = () => {
      const list = listRef.value;
      emit('load-older', {
        scrollHeight: list?.scrollHeight || 0,
        scrollTop: list?.scrollTop || 0,
      });
    };
    const onScroll = () => {
      if (isSearching.value || props.outlineState.loading || !props.outlineState.hasMore) return;
      const list = listRef.value;
      if (list && list.scrollHeight - list.scrollTop - list.clientHeight <= 40) loadOlder();
    };
    const previewResult = (result) => {
      emit('move', historyResultIdentity(result));
      emit('preview', result);
    };
    const moveActive = (index) => {
      const nextIndex = Math.max(0, Math.min(visibleResults.value.length - 1, index));
      const result = visibleResults.value[nextIndex];
      emit('move', historyResultIdentity(result));
      if (result) emit('preview', result);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        emit('close');
      } else if (event.key === 'ArrowDown' && visibleResults.value.length) {
        event.preventDefault();
        moveActive(activeIndex.value + 1);
      } else if (event.key === 'ArrowUp' && visibleResults.value.length) {
        event.preventDefault();
        moveActive(activeIndex.value - 1);
      } else if (event.key === 'Enter' && visibleResults.value.length) {
        event.preventDefault();
        emit('select', visibleResults.value[activeIndex.value] || visibleResults.value[0]);
      }
    };
    Vue.watch([visibleResults, () => props.activeMessageId], ([results, activeMessageId]) => {
      if (results.some(result => historyResultIdentity(result) === activeMessageId)) return;
      emit('move', historyResultIdentity(results[0]));
    }, { immediate: true });
    const restoreOlderScroll = ({ scrollTop = 0 } = {}) => Vue.nextTick(() => {
      if (listRef.value) listRef.value.scrollTop = scrollTop;
    });
    expose({ focus, restoreOlderScroll });
    Vue.onMounted(focus);
    return { inputRef, listRef, isSearching, visibleResults, activeIndex, isLoading, countLabel, errorKey, canRetry, focus, loadOlder, onScroll, onKeyDown, previewResult, formatOutlineTime, historyResultIdentity };
  },
};
