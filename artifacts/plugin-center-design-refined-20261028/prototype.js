// Design-only prototype. No API, credentials, real configuration writes or runtime changes.
import SessionSidebarShell from '../../web/components/SessionSidebarShell.js';
import SidebarAgentHeader from '../../web/components/SidebarAgentHeader.js';
import NavigationIcon from '../../web/components/NavigationIcon.js';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';
import zh from '../../web/i18n/zh-CN.js';

// Keep the real Session list, spacing and interaction. Only insert the requested entry.
const SessionListPreview = {
  ...UnifiedSessionList,
  name: 'SessionListPreview',
  emits: [...UnifiedSessionList.emits, 'open-plugins'],
  props: { ...UnifiedSessionList.props, pluginsOpen: Boolean },
  template: UnifiedSessionList.template.replace(
    '      </div>\n\n      <div class="sidebar-session-results">',
    `        <button type="button" class="sidebar-primary-action preview-plugin-entry" :class="{ 'is-active': pluginsOpen }" :aria-current="pluginsOpen ? 'page' : null" @click="$emit('open-plugins')">
          <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M14 3.5a3 3 0 0 0-4.24 4.24L3.5 14l6.5 6.5 6.26-6.26A3 3 0 0 0 20.5 10L17 13.5l-2.5-2.5L18 7.5A3 3 0 0 0 14 3.5z"/></svg>
          <span>插件</span>
        </button>
      </div>\n\n      <div class="sidebar-session-results">`,
  ),
};

const entries = [
  { id: 'code-review', name: '代码审查', description: '检查代码变更、兼容性与相关回归', kind: 'skill', source: '内置', icon: 'review', content: '围绕完整 diff 进行审查，给出明确结论、有证据的发现与验证结果。' },
  { id: 'software-omni', name: '软件全能助手', description: '从产品探索、实现与调试，到测试和交付', kind: 'skill', source: 'Agent', icon: 'code', content: '将产品意图和技术问题转化为可靠、可维护的软件成果。' },
  { id: 'frontend-design', name: '前端设计', description: '设计清晰、克制、可访问的 Web 界面', kind: 'skill', source: '内置', icon: 'layout', content: '结合现有组件与设计规范，优化界面布局、信息层级和交互。' },
  { id: 'browser-testing', name: '浏览器测试', description: '用真实浏览器验证关键用户路径', kind: 'skill', source: '内置', icon: 'browser', content: '检查主要路径、窄屏、主题和键盘交互，保留验证证据。' },
  { id: 'release-check', name: '发布检查', description: '整理版本、回归验证与发布证据', kind: 'skill', source: '项目', icon: 'release', content: '检查待发布提交和验证记录；不自动获得部署或重启授权。' },
  { id: 'technical-research', name: '技术研究', description: '查阅权威资料，核对方案与技术取舍', kind: 'skill', source: 'Agent', icon: 'search', content: '保留资料来源，区分已知事实、推断和仍需验证的部分。' },
  { id: 'FileRead', name: 'FileRead', description: '读取文件内容，支持按行定位', kind: 'tool', source: '内置', icon: 'file', content: '读取执行目录中可访问的文本文件；原有路径和所有权边界不变。' },
  { id: 'Bash', name: 'Bash', description: '执行 Shell 命令与后台任务', kind: 'tool', source: '内置', icon: 'terminal', content: '调用本机 Shell；启用不代表允许部署、删除数据或重启在线服务。' },
];
const mcp = { id: 'mcp:github', name: 'GitHub', description: '访问代码仓库与 Pull Request', kind: 'mcp', source: '已连接', icon: 'plugin', content: '查看仓库、Issue 和 Pull Request。', tools: ['search_repositories', 'get_pull_request', 'list_issues'] };
const agents = [{ id: 'server', name: 'server', online: true }, { id: 'C1', name: 'C1', online: true }, { id: 'server-2', name: 'server-2', online: false }];
const session = (title, id, agentId = 'server', index = 0) => ({ title, catalogKey: `${agentId}:${id}`, runtimeProvider: 'yeaft', availability: 'online', metadataUpdatedAt: 1000 - index, routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: id } });
const sessions = [session('插件中心体验优化', 'plugins'), session('Turn 内上下文压缩', 'compact', 'server', 1), session('执行状态与工具失败统计', 'status', 'server', 2), session('Workbench SVG 预览', 'svg', 'server', 3), session('发布链路检查', 'release', 'C1', 4), session('Session 重连回归', 'reconnect', 'C1', 5), session('文件工作台交互', 'files', 'server', 6)];
const { createApp } = window.Vue;
const app = createApp({
  components: { SessionSidebarShell, SidebarAgentHeader, NavigationIcon, SessionListPreview },
  data() {
    return {
      agents, sessions,
      projects: [{ id: 'yeaft', name: 'Yeaft', sortOrder: 0, members: sessions.slice(0, 3).map(s => ({ agentId: s.routeRef.agentId, sessionId: s.routeRef.sessionId })) }, { id: 'workbench', name: 'Workbench', sortOrder: 1, members: [{ agentId: 'server', sessionId: 'svg' }] }],
      agentId: 'server', kind: 'all', query: '', enabledOnly: false,
      view: 'plugins', detailId: null, activeSession: sessions[0],
      menu: null, collapsed: false, mobileNav: false, searchOpen: false,
      state: { server: {}, C1: { 'software-omni': false, 'technical-research': false, Bash: false }, 'server-2': {} },
      saving: {}, saveTimers: {}, failNext: false, error: null, notice: '', noticeTimer: null,
      draftTheme: document.documentElement.dataset.theme || 'dark',
    };
  },
  computed: {
    agent() { return agents.find(a => a.id === this.agentId); },
    onlineAgents() { return agents.filter(a => a.online); },
    catalog() { return this.agentId === 'C1' ? [...entries.slice(0, 6), mcp, ...entries.slice(6)] : entries; },
    visibleEntries() { return this.catalog.filter(p => (this.kind === 'all' || this.kind === p.kind) && (!this.enabledOnly || this.enabled(p)) && `${p.name} ${p.description} ${p.id}`.toLowerCase().includes(this.query.toLowerCase())); },
    detail() { return this.catalog.find(p => p.id === this.detailId) || null; },
    kindLabel() { return { all: '全部', skill: '技能', mcp: 'MCP', tool: '内置工具' }[this.kind]; },
  },
  methods: {
    kindName(kind) { return { skill: '技能', mcp: 'MCP', tool: '内置工具' }[kind]; },
    enabled(p) { return this.state[this.agentId][p.id] !== false; },
    savingKey(p) { return `${this.agentId}:${p.id}`; },
    async toggle(p) {
      if (!this.agent.online) return;
      const target = this.agentId, key = `${target}:${p.id}`, previous = this.state[target][p.id] !== false;
      this.state[target][p.id] = !previous;
      this.saving[key] = true;
      clearTimeout(this.saveTimers[key]);
      const fail = this.failNext;
      this.failNext = false;
      this.saveTimers[key] = setTimeout(() => {
        delete this.saving[key];
        if (fail) {
          this.state[target][p.id] = previous;
          this.error = { agent: target, entry: p.id, name: p.name };
        }
      }, 500);
    },
    retry() {
      const { agent, entry } = this.error;
      this.error = null;
      this.state[agent][entry] = !(this.state[agent][entry] !== false);
      this.toast(`${agent} · 已重试保存`);
    },
    selectAgent(id) { this.agentId = id; this.detailId = null; this.menu = null; },
    openPlugins() { this.view = 'plugins'; this.detailId = null; this.mobileNav = false; this.menu = null; },
    openSession(row) { this.activeSession = row; this.view = 'session'; this.detailId = null; this.mobileNav = false; this.menu = null; },
    openDetail(p) { this.detailId = p.id; this.menu = null; },
    toggleMenu(name) { this.menu = this.menu === name ? null : name; },
    closePopups(e) { if (!e.target.closest('.menu-host, .preview-menu')) this.menu = null; },
    toggleTheme() { this.draftTheme = this.draftTheme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = this.draftTheme; this.menu = null; },
    toast(message) { this.notice = message; clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => this.notice = '', 2400); },
    resetFilters() { this.query = ''; this.kind = 'all'; this.enabledOnly = false; },
  },
  mounted() {
    document.addEventListener('pointerdown', this.closePopups);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { this.menu = null; this.mobileNav = false; this.searchOpen = false; } });
    window.designPreview = this;
  },
  template: `
    <div class="preview-app">
      <button v-if="mobileNav" class="preview-nav-backdrop" aria-label="收起侧栏" @click="mobileNav = false"></button>
      <SessionSidebarShell class="yeaft-sidebar preview-sidebar" :class="{ 'mobile-open': mobileNav }" :collapsed="collapsed">
        <template #collapsed><div v-if="collapsed" class="sidebar-collapsed-bar"><button class="collapsed-icon-btn" aria-label="展开侧栏" @click="collapsed = false"><NavigationIcon name="menu" :size="18" /></button></div></template>
        <div class="sidebar-top"><div class="sidebar-header-row">
          <SidebarAgentHeader :online-agents="onlineAgents" :online-agent-count="onlineAgents.length" @open-agent-settings="toast('设计演示：Agent 设置未连接')" />
          <div class="sidebar-header-actions">
            <button class="sidebar-icon-btn" aria-label="数字人" @click="toast('设计演示：保留现有入口')"><svg class="preview-icon"><use href="#p-person" /></svg></button>
            <button class="sidebar-icon-btn" aria-label="工作中心" @click="toast('设计演示：保留现有入口')"><svg class="preview-icon"><use href="#p-work" /></svg></button>
            <button class="sidebar-icon-btn" aria-label="收起侧栏" @click="collapsed = true; mobileNav = false"><NavigationIcon name="collapse" :size="18" /></button>
          </div>
        </div></div>
        <SessionListPreview :sessions="sessions" :projects="projects" :agents="agents" :active-route="view === 'session' ? activeSession.routeRef : null" :plugins-open="view === 'plugins'" @open-plugins="openPlugins" @select="openSession" @create="toast('设计演示：新建聊天未连接')" @action="toast('设计演示：不会修改真实会话')" />
        <div class="sidebar-bottom"><button class="sidebar-nav-item" @click="toast('设计演示：保留设置入口')"><svg class="preview-icon"><use href="#p-settings" /></svg><span>设置</span></button></div>
      </SessionSidebarShell>
      <main class="preview-main">
        <header class="preview-header" v-if="view === 'plugins'" aria-label="插件工具栏">
          <button class="preview-icon-button mobile-menu-button" aria-label="展开 Session 侧栏" @click="collapsed = false; mobileNav = true"><svg class="preview-icon"><use href="#p-menu" /></svg></button>
          <template v-if="!searchOpen">
            <div class="menu-host agent-menu-host">
              <button class="preview-agent-trigger" aria-label="选择 Agent" :aria-expanded="menu === 'agents'" @click="toggleMenu('agents')"><span class="agent-caption">Agent</span><span class="preview-dot" :class="{ offline: !agent.online }"></span><span class="agent-name">{{ agent.name }}</span><svg class="preview-icon chevron"><use href="#p-chevron" /></svg></button>
              <div v-if="menu === 'agents'" class="preview-menu agent-menu" role="menu"><button v-for="a in agents" :key="a.id" role="menuitemradio" :aria-checked="agentId === a.id" @click="selectAgent(a.id)"><span class="preview-dot" :class="{ offline: !a.online }"></span><span>{{ a.name }}</span><small v-if="!a.online">离线</small><svg v-if="agentId === a.id" class="preview-icon"><use href="#p-check" /></svg></button></div>
            </div>
            <nav class="preview-tabs" aria-label="插件类型"><button v-for="k in ['all', 'skill', 'mcp', 'tool']" :key="k" :class="{ active: kind === k }" :aria-pressed="kind === k" @click="kind = k; detailId = null">{{ { all: '全部', skill: '技能', mcp: 'MCP', tool: '内置工具' }[k] }}</button></nav>
            <select class="preview-category-select" aria-label="插件类型" v-model="kind" @change="detailId = null"><option value="all">全部</option><option value="skill">技能</option><option value="mcp">MCP</option><option value="tool">工具</option></select>
            <label class="preview-search"><svg class="preview-icon"><use href="#p-search" /></svg><input v-model="query" type="search" placeholder="搜索插件" aria-label="搜索插件" @input="detailId = null"></label>
            <button class="preview-icon-button compact-search" aria-label="搜索插件" @click="searchOpen = true; $nextTick(() => $refs.mobileSearch.focus())"><svg class="preview-icon"><use href="#p-search" /></svg></button>
            <button class="preview-create" :disabled="!agent.online" aria-label="创建技能" @click="toast('设计演示：创建表单待确认后实现')"><svg class="preview-icon"><use href="#p-plus" /></svg><span>创建技能</span></button>
            <div class="menu-host"><button class="preview-icon-button" aria-label="更多操作" :aria-expanded="menu === 'more'" @click="toggleMenu('more')"><svg class="preview-icon"><use href="#p-more" /></svg></button><div v-if="menu === 'more'" class="preview-menu more-menu" role="menu"><button class="preview-mobile-create" role="menuitem" :disabled="!agent.online" @click="toast('设计演示：创建表单待确认后实现'); menu = null">创建技能</button><button role="menuitemcheckbox" :aria-checked="enabledOnly" @click="enabledOnly = !enabledOnly; menu = null">{{ enabledOnly ? '✓ ' : '' }}只看已启用</button><button role="menuitem" @click="toast('设计演示：刷新当前 Agent 的目录'); menu = null">刷新列表</button><button role="menuitem" @click="toggleTheme">切换明 / 暗主题</button></div></div>
          </template>
          <template v-else><label class="preview-expanded-search"><svg class="preview-icon"><use href="#p-search" /></svg><input ref="mobileSearch" v-model="query" type="search" aria-label="搜索插件" placeholder="搜索插件" @input="detailId = null"></label><button class="preview-icon-button" aria-label="收起搜索" @click="searchOpen = false"><svg class="preview-icon"><use href="#p-close" /></svg></button></template>
        </header>
        <header v-else class="preview-header session-header"><button class="preview-icon-button mobile-menu-button" aria-label="展开 Session 侧栏" @click="collapsed = false; mobileNav = true"><svg class="preview-icon"><use href="#p-menu" /></svg></button><span>{{ activeSession.title }}</span></header>
        <div v-if="error" class="preview-alert" role="alert"><span>{{ error.agent }} · {{ error.name }} 保存失败，已恢复原状态</span><button @click="retry">重试</button><button aria-label="关闭错误提示" @click="error = null">×</button></div>
        <div v-if="view === 'plugins' && !agent.online" class="preview-offline" role="status">{{ agent.name }} 离线 · 上次配置，只读</div>
        <div class="preview-content" v-if="view === 'plugins'">
          <div v-if="!detail" class="preview-catalog">
            <div v-if="enabledOnly" class="preview-filter-label">已启用<button @click="enabledOnly = false" aria-label="取消已启用筛选">×</button></div>
            <article v-for="p in visibleEntries" :key="p.id" class="preview-plugin" :data-entry="p.id">
              <button class="preview-plugin-main" @click="openDetail(p)" :aria-label="'查看 ' + p.name + ' 详情'"><span class="preview-plugin-icon"><svg class="preview-icon"><use :href="'#p-' + p.icon" /></svg></span><span class="preview-plugin-copy"><span class="preview-plugin-name">{{ p.name }}</span><span class="preview-plugin-description">{{ p.description }}</span></span></button>
              <span class="preview-row-meta"><span>{{ kindName(p.kind) }}</span><span class="preview-origin" :class="{ connected: p.kind === 'mcp' }">{{ p.source }}</span></span>
              <span class="preview-save-indicator" :class="{ visible: saving[savingKey(p)] }" role="status" :aria-label="saving[savingKey(p)] ? '保存中' : ''"></span>
              <button class="preview-switch" role="switch" :aria-checked="enabled(p)" :aria-label="p.name + '启用状态'" :disabled="!agent.online" @click="toggle(p)"><span></span></button>
            </article>
            <div v-if="!visibleEntries.length" class="preview-empty"><svg class="preview-icon"><use href="#p-search" /></svg><p>{{ query ? '没有匹配的插件' : kind === 'mcp' ? '尚未配置 MCP' : '暂无插件' }}</p><button v-if="query || enabledOnly" @click="resetFilters">清除筛选</button><button v-else-if="kind === 'mcp'" :disabled="!agent.online" @click="toast('设计演示：配置入口不连接真实 Agent')">查看配置</button></div>
          </div>
          <section v-else class="preview-detail">
            <button class="preview-back" @click="detailId = null"><svg class="preview-icon"><use href="#p-back" /></svg>所有插件</button>
            <div class="preview-detail-title"><span class="preview-plugin-icon"><svg class="preview-icon"><use :href="'#p-' + detail.icon" /></svg></span><div><h1>{{ detail.name }}</h1><p>{{ kindName(detail.kind) }} · {{ detail.source }}</p></div><span class="preview-save-indicator" :class="{ visible: saving[savingKey(detail)] }" role="status" :aria-label="saving[savingKey(detail)] ? '保存中' : ''"></span><button class="preview-switch" role="switch" :aria-checked="enabled(detail)" :aria-label="detail.name + '启用状态'" :disabled="!agent.online" @click="toggle(detail)"><span></span></button></div>
            <p class="preview-detail-description">{{ detail.description }}</p>
            <h2>{{ detail.kind === 'skill' ? '技能内容' : '功能' }}</h2><div class="preview-content-panel">{{ detail.content }}</div>
            <h2>{{ detail.kind === 'mcp' ? '可用工具' : '信息' }}</h2>
            <ul v-if="detail.kind === 'mcp'" class="preview-mcp-tools"><li v-for="tool in detail.tools">{{ tool }}</li></ul>
            <dl v-else class="preview-properties"><dt>标识</dt><dd>{{ detail.id }}</dd><dt>来源</dt><dd>{{ detail.source }}{{ detail.source === '内置' ? ' · 只读' : '' }}</dd><dt>Agent</dt><dd>{{ agent.name }}</dd></dl>
            <button v-if="detail.kind === 'skill' && detail.source !== '内置'" class="preview-edit" :disabled="!agent.online" @click="toast('设计演示：编辑表单未连接')">编辑技能</button>
          </section>
        </div>
        <div v-else class="preview-chat"><div class="preview-chat-user">插件中心的布局再收简一些。</div><p>保留现有 Session 侧栏，插件入口放在新建聊天下方。</p><p>点击 Session 后，直接回到对话。</p></div>
      </main>
      <div v-if="notice" class="preview-toast" role="status">{{ notice }}</div>
    </div>`,
});
app.config.globalProperties.$t = (key, params = {}) => {
  let value = zh[key] || key;
  for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, v);
  return value;
};
app.mount('#app');
