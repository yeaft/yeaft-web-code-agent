/**
 * ModernSelect — a styled dropdown that replaces native `<select>` for cases
 * where we want richer rows (model name + vendor badge, search filter, etc.)
 * and consistent rounded styling across light/dark themes.
 *
 * Pure presentational: emits `update:modelValue` like v-model. Closes on
 * outside-click / Escape. Falls back gracefully to keyboard arrow navigation.
 */
let modernSelectId = 0;

export default {
  name: 'ModernSelect',
  props: {
    modelValue: { type: [String, Number], default: null },
    options: { type: Array, default: () => [] }, // [{value, label, sublabel?, badge?}]
    placeholder: { type: String, default: '' },
    searchable: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    emptyText: { type: String, default: '—' },
    ariaLabel: { type: String, default: '' },
    menuMinWidth: { type: Number, default: 0 },
    menuClass: { type: String, default: '' },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const open = Vue.ref(false);
    const search = Vue.ref('');
    const triggerEl = Vue.ref(null);
    const menuEl = Vue.ref(null);
    const listEl = Vue.ref(null);
    const searchEl = Vue.ref(null);
    const activeIdx = Vue.ref(-1);
    const instanceId = `modern-select-${++modernSelectId}`;
    const menuId = `${instanceId}-menu`;
    const menuStyle = Vue.ref({});

    const selected = Vue.computed(() => props.options.find(o => o.value === props.modelValue) || null);
    const filtered = Vue.computed(() => {
      if (!props.searchable || !search.value.trim()) return props.options;
      const q = search.value.trim().toLowerCase();
      return props.options.filter(o =>
        String(o.label || '').toLowerCase().includes(q) ||
        String(o.sublabel || '').toLowerCase().includes(q) ||
        String(o.value || '').toLowerCase().includes(q)
      );
    });
    const optionId = index => `${instanceId}-option-${index}`;
    const activeOptionId = Vue.computed(() => (
      open.value && activeIdx.value >= 0 && activeIdx.value < filtered.value.length
        ? optionId(activeIdx.value)
        : undefined
    ));

    function positionMenu() {
      const trigger = triggerEl.value;
      const menu = menuEl.value;
      const list = listEl.value;
      if (!trigger || !menu || !list) return;
      const gap = 6;
      const viewportPadding = 8;
      const triggerRect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const menuWidth = Math.min(
        Math.max(triggerRect.width, props.menuMinWidth),
        Math.max(0, viewportWidth - viewportPadding * 2),
      );
      // Measure immutable content height, not the menu box that the previous
      // positioning pass already constrained. Scroll events bubble from the
      // list into the window capture listener; reading menu.scrollHeight there
      // feeds the old max-height back into the next pass and shrinks repeatedly.
      const chromeHeight = props.searchable ? 58 : 12;
      const desiredHeight = Math.min(list.scrollHeight + chromeHeight, 304);
      const below = Math.max(0, viewportHeight - triggerRect.bottom - gap - viewportPadding);
      const above = Math.max(0, triggerRect.top - gap - viewportPadding);
      const placeAbove = below < desiredHeight && above > below;
      const maxHeight = Math.max(48, Math.min(desiredHeight, placeAbove ? above : below));
      const naturalLeft = triggerRect.right - menuWidth;
      const left = Math.min(
        Math.max(viewportPadding, naturalLeft),
        Math.max(viewportPadding, viewportWidth - viewportPadding - menuWidth),
      );
      menuStyle.value = {
        top: `${placeAbove ? triggerRect.top - gap - maxHeight : triggerRect.bottom + gap}px`,
        left: `${left}px`,
        width: `${menuWidth}px`,
        maxHeight: `${maxHeight}px`,
        '--modern-select-list-max-height': `${Math.max(36, maxHeight - (props.searchable ? 58 : 12))}px`,
      };
    }

    function toggle() {
      if (props.disabled) return;
      open.value = !open.value;
      if (open.value) {
        search.value = '';
        activeIdx.value = filtered.value.findIndex(o => o.value === props.modelValue);
        Vue.nextTick(() => {
          positionMenu();
          if (props.searchable && searchEl.value?.focus) searchEl.value.focus();
          const activeOption = menuEl.value?.querySelector('.modern-select-option.is-active');
          if (activeOption?.scrollIntoView) activeOption.scrollIntoView({ block: 'nearest' });
        });
      }
    }
    function close(restoreFocus = false) {
      open.value = false;
      if (restoreFocus) Vue.nextTick(() => triggerEl.value?.focus());
    }
    function pick(opt) {
      if (props.disabled || !opt || opt.disabled) return;
      emit('update:modelValue', opt.value);
      emit('change', opt.value);
      close(true);
    }
    function moveActive(step) {
      if (!filtered.value.length) return;
      let next = activeIdx.value;
      for (let count = 0; count < filtered.value.length; count += 1) {
        next = (next + step + filtered.value.length) % filtered.value.length;
        if (!filtered.value[next]?.disabled) {
          activeIdx.value = next;
          return;
        }
      }
    }
    function onKey(e) {
      if (!open.value) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); toggle(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key === 'Tab') {
        // Return to the form's tab order before the browser advances focus.
        if (searchEl.value === document.activeElement) triggerEl.value?.focus();
        close();
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = filtered.value[activeIdx.value];
        if (opt) pick(opt);
      }
    }
    function onDocClick(e) {
      if (!open.value) return;
      if (triggerEl.value?.contains(e.target)) return;
      if (menuEl.value?.contains(e.target)) return;
      close();
    }
    const onViewportChange = () => { if (open.value) positionMenu(); };
    Vue.onMounted(() => {
      document.addEventListener('mousedown', onDocClick);
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('scroll', onViewportChange, true);
    });
    Vue.onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    });
    Vue.watch(search, () => { activeIdx.value = filtered.value.findIndex(option => !option.disabled); });
    Vue.watch(() => props.disabled, value => { if (value) close(); });
    Vue.watch(() => props.modelValue, () => { /* re-sync handled by computed */ });

    return {
      open, search, triggerEl, menuEl, searchEl, activeIdx, selected, filtered,
      menuId, menuStyle, listEl, optionId, activeOptionId, toggle, close, pick, onKey,
    };
  },
  template: `
    <div class="modern-select" :class="{ 'is-open': open, 'is-disabled': disabled }">
      <button
        type="button"
        class="modern-select-trigger"
        ref="triggerEl"
        :disabled="disabled"
        :aria-label="ariaLabel || undefined"
        role="combobox"
        aria-haspopup="listbox"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="menuId"
        :aria-activedescendant="activeOptionId"
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
      <Teleport to="body">
        <transition name="ms-pop">
          <div
            v-if="open"
            class="modern-select-menu"
            :class="menuClass"
            :style="menuStyle"
            ref="menuEl"
          >
            <div v-if="searchable" class="modern-select-search">
              <input
                type="text"
                v-model="search"
                ref="searchEl"
                role="combobox"
                aria-autocomplete="list"
                :aria-label="ariaLabel || ($t ? $t('common.search') : 'Search')"
                aria-expanded="true"
                :aria-controls="menuId"
                :aria-activedescendant="activeOptionId"
                :placeholder="$t ? $t('common.search') || 'Search…' : 'Search…'"
                @keydown="onKey"
              >
            </div>
            <div class="modern-select-list" ref="listEl" :id="menuId" role="listbox" :aria-label="ariaLabel || undefined">
              <div v-if="loading" class="modern-select-empty">…</div>
              <div v-else-if="!filtered.length" class="modern-select-empty">{{ emptyText }}</div>
              <div
                v-for="(opt, i) in filtered"
                :key="opt.value"
                class="modern-select-option"
                :class="{ 'is-active': i === activeIdx, 'is-selected': opt.value === modelValue, 'is-disabled': opt.disabled }"
                role="option"
                :id="optionId(i)"
                :aria-selected="opt.value === modelValue ? 'true' : 'false'"
                :aria-disabled="opt.disabled ? 'true' : 'false'"
                @mouseenter="!opt.disabled && (activeIdx = i)"
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
      </Teleport>
    </div>
  `,
};
