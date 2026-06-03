/**
 * ModernSelect — a styled dropdown that replaces native `<select>` for cases
 * where we want richer rows (model name + vendor badge, search filter, etc.)
 * and consistent rounded styling across light/dark themes.
 *
 * Pure presentational: emits `update:modelValue` like v-model. Closes on
 * outside-click / Escape. Falls back gracefully to keyboard arrow navigation.
 */
const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

export default {
  name: 'ModernSelect',
  props: {
    modelValue: { type: [String, Number, null], default: null },
    options: { type: Array, default: () => [] }, // [{value, label, sublabel?, badge?}]
    placeholder: { type: String, default: '' },
    searchable: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    emptyText: { type: String, default: '—' },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const open = ref(false);
    const search = ref('');
    const triggerEl = ref(null);
    const menuEl = ref(null);
    const activeIdx = ref(-1);

    const selected = computed(() => props.options.find(o => o.value === props.modelValue) || null);
    const filtered = computed(() => {
      if (!props.searchable || !search.value.trim()) return props.options;
      const q = search.value.trim().toLowerCase();
      return props.options.filter(o =>
        String(o.label || '').toLowerCase().includes(q) ||
        String(o.sublabel || '').toLowerCase().includes(q) ||
        String(o.value || '').toLowerCase().includes(q)
      );
    });

    function toggle() {
      if (props.disabled) return;
      open.value = !open.value;
      if (open.value) {
        search.value = '';
        activeIdx.value = filtered.value.findIndex(o => o.value === props.modelValue);
        nextTick(() => {
          if (menuEl.value) {
            const el = menuEl.value.querySelector('.modern-select-option.is-active');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
        });
      }
    }
    function close() { open.value = false; }
    function pick(opt) {
      emit('update:modelValue', opt.value);
      emit('change', opt.value);
      close();
    }
    function onKey(e) {
      if (!open.value) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); toggle(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx.value = Math.min(filtered.value.length - 1, activeIdx.value + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx.value = Math.max(0, activeIdx.value - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = filtered.value[activeIdx.value];
        if (opt) pick(opt);
      }
    }
    function onDocClick(e) {
      if (!open.value) return;
      if (triggerEl.value && triggerEl.value.contains(e.target)) return;
      if (menuEl.value && menuEl.value.contains(e.target)) return;
      close();
    }
    onMounted(() => document.addEventListener('mousedown', onDocClick));
    onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));
    watch(() => props.modelValue, () => { /* re-sync handled by computed */ });

    return { open, search, triggerEl, menuEl, activeIdx, selected, filtered, toggle, close, pick, onKey };
  },
  template: `
    <div class="modern-select" :class="{ 'is-open': open, 'is-disabled': disabled }">
      <button
        type="button"
        class="modern-select-trigger"
        ref="triggerEl"
        :disabled="disabled"
        @click="toggle"
        @keydown="onKey"
      >
        <span class="modern-select-value" v-if="selected">
          <span class="modern-select-label">{{ selected.label }}</span>
          <span v-if="selected.badge" class="modern-select-badge">{{ selected.badge }}</span>
        </span>
        <span class="modern-select-value placeholder" v-else>{{ placeholder || emptyText }}</span>
        <svg class="modern-select-caret" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M5.25 7.5l4.75 4.75L14.75 7.5z"/>
        </svg>
      </button>
      <transition name="ms-pop">
        <div v-if="open" class="modern-select-menu" ref="menuEl" role="listbox">
          <div v-if="searchable" class="modern-select-search">
            <input
              type="text"
              v-model="search"
              :placeholder="$t ? $t('common.search') || 'Search…' : 'Search…'"
              @keydown="onKey"
              autofocus
            >
          </div>
          <div class="modern-select-list">
            <div v-if="loading" class="modern-select-empty">…</div>
            <div v-else-if="!filtered.length" class="modern-select-empty">{{ emptyText }}</div>
            <div
              v-for="(opt, i) in filtered"
              :key="opt.value"
              class="modern-select-option"
              :class="{ 'is-active': i === activeIdx, 'is-selected': opt.value === modelValue }"
              role="option"
              @mouseenter="activeIdx = i"
              @click="pick(opt)"
            >
              <div class="modern-select-option-main">
                <span class="modern-select-option-label">{{ opt.label }}</span>
                <span v-if="opt.badge" class="modern-select-badge">{{ opt.badge }}</span>
              </div>
              <div v-if="opt.sublabel" class="modern-select-option-sub">{{ opt.sublabel }}</div>
              <svg v-if="opt.value === modelValue" class="modern-select-check" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M7.629 13.514L3.886 9.77 2.471 11.186l5.158 5.158L17.385 6.586l-1.414-1.414z"/>
              </svg>
            </div>
          </div>
        </div>
      </transition>
    </div>
  `,
};
