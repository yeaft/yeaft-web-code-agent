/**
 * McpTab.js — Yeaft Settings → MCP tab.
 *
 * CRUD UI for the user's Model Context Protocol (MCP) server list. The
 * agent owns `~/.yeaft/config.json` `mcpServers`; this tab only sends
 * the four `yeaft_mcp_*` wire ops via the store actions and renders
 * what the agent broadcasts back.
 *
 * Why a dedicated tab (vs. extending Tools): MCP is configuration that
 * survives session restart and replaces tool surfaces (the LLM sees
 * `mcp__<server>__<tool>` directly after we flatten — see
 * `agent/yeaft/tools/mcp-tools.js`). The Tools tab is a read-only
 * runtime view; this tab is the write surface.
 *
 * UX:
 *   - One "Add server" form at the bottom (name, command, args, env)
 *   - One row per configured server with a "connected · N tools" badge
 *     and a Remove button. Reload is per-row (small ↻ glyph) for when
 *     a server crashed but its config is still valid.
 *   - The list is server-pushed: `yeaft_mcp_updated` keeps this view in
 *     sync if a sibling tab (or another web client) mutates the list.
 */
export default {
  name: 'McpTab',
  emits: ['message'],
  template: `
    <div class="mcp-settings-tab">
      <div class="settings-section">
        <h3 class="settings-section-title">
          {{ $t('settings.mcp.title') }}
          <button class="search-link-btn" @click="reloadAll" :disabled="loading || !servers.length">
            {{ loading ? $t('settings.mcp.loading') : $t('settings.mcp.reloadAll') }}
          </button>
        </h3>
        <p class="settings-section-desc">{{ $t('settings.mcp.description') }}</p>
      </div>

      <div class="settings-section" v-if="servers.length">
        <div class="mcp-server-list">
          <div v-for="srv in serversWithStatus" :key="srv.name" class="mcp-server-row">
            <div class="mcp-server-main">
              <div class="mcp-server-name">{{ srv.name }}</div>
              <div class="mcp-server-cmd">
                <code>{{ srv.command }}<span v-if="srv.args && srv.args.length"> {{ srv.args.join(' ') }}</span></code>
              </div>
              <div class="mcp-server-status">
                <span class="mcp-status-dot" :class="srv.ready ? 'mcp-status-on' : 'mcp-status-off'"></span>
                <span v-if="srv.ready">
                  {{ $t('settings.mcp.connected') }} · {{ srv.toolCount }} {{ $t('settings.mcp.tools') }}
                </span>
                <span v-else>{{ $t('settings.mcp.disconnected') }}</span>
              </div>
            </div>
            <div class="mcp-server-actions">
              <button class="search-btn-secondary mcp-btn-sm"
                      @click="reloadOne(srv.name)"
                      :disabled="loading"
                      :title="$t('settings.mcp.reloadOne')">
                ↻
              </button>
              <button class="search-btn-secondary mcp-btn-sm mcp-btn-danger"
                      @click="removeOne(srv.name)"
                      :disabled="loading">
                {{ $t('settings.mcp.remove') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section" v-else>
        <div class="mcp-empty">{{ $t('settings.mcp.empty') }}</div>
      </div>

      <div class="settings-section">
        <h3 class="settings-section-title">{{ $t('settings.mcp.addServer') }}</h3>
        <p class="settings-section-desc">{{ $t('settings.mcp.addServerDesc') }}</p>

        <div class="mcp-form-row">
          <label class="mcp-form-label">{{ $t('settings.mcp.serverName') }}</label>
          <input type="text"
                 class="mcp-form-input"
                 v-model="form.name"
                 placeholder="e.g. filesystem"
                 :disabled="loading" />
        </div>

        <div class="mcp-form-row">
          <label class="mcp-form-label">{{ $t('settings.mcp.command') }}</label>
          <input type="text"
                 class="mcp-form-input"
                 v-model="form.command"
                 placeholder="e.g. npx"
                 :disabled="loading" />
        </div>

        <div class="mcp-form-row">
          <label class="mcp-form-label">{{ $t('settings.mcp.args') }}</label>
          <input type="text"
                 class="mcp-form-input"
                 v-model="form.argsRaw"
                 :placeholder="$t('settings.mcp.argsPlaceholder')"
                 :disabled="loading" />
        </div>

        <div class="mcp-form-row">
          <label class="mcp-form-label">{{ $t('settings.mcp.env') }}</label>
          <textarea class="mcp-form-input mcp-form-textarea"
                    v-model="form.envRaw"
                    :placeholder="$t('settings.mcp.envPlaceholder')"
                    :disabled="loading"
                    rows="3"></textarea>
        </div>

        <div v-if="formError" class="mcp-form-error">{{ formError }}</div>

        <div class="settings-section-actions">
          <button class="search-btn-primary"
                  @click="addServer"
                  :disabled="loading || !form.name || !form.command">
            {{ loading ? $t('settings.mcp.saving') : $t('settings.mcp.add') }}
          </button>
          <button class="search-btn-secondary" @click="resetForm" :disabled="loading">
            {{ $t('settings.mcp.cancel') }}
          </button>
        </div>
      </div>
    </div>
  `,
  setup(_, { emit }) {
    const store = Pinia.useChatStore();
    const instance = Vue.getCurrentInstance();
    const $t = (key) => instance?.proxy?.$t?.(key) ?? key;

    const servers = Vue.computed(() => store.yeaftMcpServers || []);
    const runtime = Vue.computed(() => store.yeaftMcpRuntime || { connected: false, toolCount: 0, perServer: [] });
    const loading = Vue.computed(() => !!store.yeaftMcpLoading);

    // Cross-join configured list with live runtime so the row shows
    // "connected · N tools" inline. Runtime entries for servers no longer
    // in the config (e.g. mid-disconnect race) are dropped.
    const serversWithStatus = Vue.computed(() => {
      const live = new Map(
        (runtime.value.perServer || []).map(s => [s.name, s])
      );
      return servers.value.map(s => {
        const r = live.get(s.name);
        return {
          ...s,
          ready: !!(r && r.ready),
          toolCount: r ? r.toolCount : 0,
        };
      });
    });

    const form = Vue.reactive({
      name: '',
      command: '',
      argsRaw: '',
      envRaw: '',
    });
    const formError = Vue.ref('');

    function resetForm() {
      form.name = '';
      form.command = '';
      form.argsRaw = '';
      form.envRaw = '';
      formError.value = '';
    }

    // Parse a one-line, space-separated arg string. Quoted segments are
    // honoured ("foo bar" → single arg "foo bar") so users can paste a
    // shell-ish command line. Empty input → []. This matches what a
    // typical user pastes from MCP server docs.
    function parseArgs(raw) {
      if (!raw) return [];
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(raw)) !== null) {
        out.push(m[1] ?? m[2] ?? m[3]);
      }
      return out;
    }

    // Parse newline-separated KEY=VALUE pairs. Lines without `=` are
    // ignored silently; trailing whitespace on the value is preserved
    // (some MCP servers expect trailing slashes in URLs etc.).
    function parseEnv(raw) {
      if (!raw) return {};
      /** @type {Record<string,string>} */
      const out = {};
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1);
        if (k) out[k] = v;
      }
      return out;
    }

    function validateForm() {
      formError.value = '';
      const name = (form.name || '').trim();
      const command = (form.command || '').trim();
      if (!name) { formError.value = $t('settings.mcp.errors.nameRequired'); return null; }
      if (!/^[a-z0-9_-]+$/.test(name)) {
        formError.value = $t('settings.mcp.errors.nameFormat');
        return null;
      }
      if (!command) { formError.value = $t('settings.mcp.errors.commandRequired'); return null; }
      let args = [];
      let env = {};
      try { args = parseArgs(form.argsRaw); }
      catch { formError.value = $t('settings.mcp.errors.argsParse'); return null; }
      try { env = parseEnv(form.envRaw); }
      catch { formError.value = $t('settings.mcp.errors.envParse'); return null; }
      return { name, command, args, env };
    }

    async function addServer() {
      const payload = validateForm();
      if (!payload) return;
      const res = await store.addYeaftMcpServer(payload);
      if (res?.error) {
        emit('message', res.error, true);
        return;
      }
      if (res?.connectError) {
        emit('message', $t('settings.mcp.connectFailed') + ': ' + res.connectError, true);
      } else {
        emit('message', $t('settings.mcp.addSuccess'), false);
      }
      resetForm();
    }

    async function removeOne(name) {
      if (!name) return;
      if (!confirm($t('settings.mcp.confirmRemove').replace('{name}', name))) return;
      const res = await store.removeYeaftMcpServer(name);
      if (res?.error) {
        emit('message', res.error, true);
      } else {
        emit('message', $t('settings.mcp.removeSuccess'), false);
      }
    }

    async function reloadOne(name) {
      const res = await store.reloadYeaftMcpServer(name);
      if (res?.error) emit('message', res.error, true);
      else emit('message', $t('settings.mcp.reloadSuccess'), false);
    }

    async function reloadAll() {
      const res = await store.reloadYeaftMcpServer(null);
      if (res?.error) emit('message', res.error, true);
      else emit('message', $t('settings.mcp.reloadSuccess'), false);
    }

    Vue.onMounted(() => {
      store.loadYeaftMcpServers();
    });

    return {
      servers, runtime, loading, serversWithStatus,
      form, formError,
      resetForm, addServer, removeOne, reloadOne, reloadAll,
    };
  },
};
