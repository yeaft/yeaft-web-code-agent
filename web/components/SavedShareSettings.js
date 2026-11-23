import { useAuthStore } from '../stores/auth.js';
import { requestSessionDiscovery, supportsSessionDiscovery } from '../stores/helpers/session-discovery.js';
import { confirmDialog } from '../utils/dialog.js';
import ModernSelect from './ModernSelect.js';

export default {
  name: 'SavedShareSettings',
  components: { ModernSelect },
  props: { store: { type: Object, required: true } },
  setup(props) {
    const auth = useAuthStore();
    const { computed, onBeforeUnmount, ref, watch } = Vue;
    const open = ref(false);
    const selected = ref('');
    const items = ref([]);
    const busy = ref(false);
    const error = ref('');
    const agents = computed(() => props.store.agents.filter(agent => agent.online && supportsSessionDiscovery(agent))
      .map(agent => ({ value: agent.id, label: agent.name || agent.id })));
    const target = computed(() => {
      const preferred = props.store.activeSessionRoute?.agentId || props.store.currentAgent;
      return [selected.value, preferred, agents.value[0]?.value].find(id => agents.value.some(agent => agent.value === id));
    });
    let controller;
    function reset() {
      controller?.abort();
      controller = null;
      items.value = [];
      error.value = '';
      busy.value = false;
    }
    async function request(op, payload, onSuccess) {
      const agentId = target.value;
      const request = new AbortController();
      controller?.abort();
      controller = request;
      busy.value = true;
      error.value = '';
      try {
        const data = await requestSessionDiscovery(props.store, agentId, op, payload, request.signal);
        if (!request.signal.aborted) onSuccess(data);
      } catch {
        if (!request.signal.aborted) error.value = op === 'share_list' ? 'failed' : 'removeFailed';
      } finally {
        if (!request.signal.aborted) busy.value = false;
      }
    }
    function load() {
      reset();
      if (!open.value || !target.value || props.store.connectionState !== 'connected') return;
      return request('share_list', {}, data => {
        if (!Array.isArray(data?.items)) throw new Error('Invalid Share response');
        items.value = data.items.filter(item => item.status === 'published');
      });
    }
    async function remove(item, prompt) {
      const previous = controller;
      const ownerGeneration = auth.authGeneration;
      if (!await confirmDialog(prompt, { destructive: true })) return;
      if (auth.authGeneration !== ownerGeneration || !open.value || controller !== previous || !items.value.includes(item)) return;
      return request('share_delete', { id: item.id, expectedUpdatedAt: item.updatedAt }, () => {
        items.value = items.value.filter(row => row.id !== item.id);
      });
    }
    watch([open, target, () => props.store.ws, () => props.store.connectionState], load);
    watch(() => auth.authGeneration, () => { open.value = false; reset(); }, { flush: 'sync' });
    onBeforeUnmount(reset);
    return { open, selected, agents, target, busy, error, items, load, remove };
  },
  template: `
    <details class="sp-group saved-share-settings" :open="open" @toggle="open = $event.currentTarget.open">
      <summary class="sp-group-title">{{ $t('savedShare.title') }}</summary>
      <p class="sp-desc">{{ $t('savedShare.hint') }}</p>
      <ModernSelect v-if="open && agents.length > 1" :model-value="target" :options="agents"
                    :aria-label="$t('savedShare.agent')" @update:model-value="selected = $event" />
      <p v-if="open && (!target || store.connectionState !== 'connected')" class="sp-desc" role="status">{{ $t('savedShare.unavailable') }}</p>
      <p v-else-if="busy" class="sp-desc" role="status">{{ $t('common.loading') }}</p>
      <p v-else-if="error" class="sp-desc" role="alert">
        {{ $t('savedShare.' + error) }}
        <button type="button" class="btn-ghost" @click="load">{{ $t('common.retry') }}</button>
      </p>
      <p v-else-if="open && !items.length" class="sp-desc" role="status">{{ $t('savedShare.empty') }}</p>
      <div v-for="item in items" :key="item.id" class="sp-row sp-setting-row">
        <details class="sp-row-left sp-setting-copy saved-share-item">
          <summary class="sp-label">{{ item.title }}</summary>
          <p class="sp-desc">{{ $t('savedShare.' + item.kind) }} · {{ item.body }}</p>
        </details>
        <button type="button" class="btn-ghost" :disabled="busy || !!error"
                @click="remove(item, $t('savedShare.removePrompt', { title: item.title }))">{{ $t('savedShare.remove') }}</button>
      </div>
    </details>
  `,
};
