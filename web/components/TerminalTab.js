import { loadScript, generateTerminalId, collectLeaves, findFirstLeaf, replaceNode, removeNode } from './terminal/paneLayout.js';
import { createRouteBoundWorkbenchStore, isWorkbenchMessageForRoute, workbenchMessageScope } from '../utils/workbench-route.js';
import PaneTree from './terminal/PaneTree.js';

export default {
  name: 'TerminalTab',
  components: { PaneTree },
  props: {
    routeKey: { type: String, required: true },
    runtimeProvider: { type: String, required: true },
    agentId: { type: String, required: true },
    sessionId: { type: String, required: true },
    conversationId: { type: String, required: true },
    workDir: { type: String, default: '' },
    workspaceGeneration: { type: String, required: true },
  },
  template: `
    <div class="terminal-tab">
      <div class="terminal-toolbar">
        <button class="wb-btn" @click="splitPane('horizontal')" :disabled="!hasActivePane" :title="$t('terminal.splitH')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 3h8v18H3V3zm10 0h8v18h-8V3z"/></svg>
          <span>Split ─</span>
        </button>
        <button class="wb-btn" @click="splitPane('vertical')" :disabled="!hasActivePane" :title="$t('terminal.splitV')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 3h18v8H3V3zm0 10h18v8H3v-8z"/></svg>
          <span>Split │</span>
        </button>
        <button class="wb-btn" @click="closeActivePane" :disabled="!hasActivePane" :title="$t('terminal.close')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          <span>Close</span>
        </button>
        <span class="terminal-status-text" v-if="terminalError">{{ terminalError }}</span>
      </div>
      <div class="terminal-instances" v-if="currentTree">
        <PaneTree
          :node="currentTree"
          :terminals="terminals"
          :activePane="currentActivePane"
          :onActivate="activatePane"
          :onClosePane="closePane"
          :setMountRef="setMountRef"
        />
      </div>
      <div v-if="!currentTree" class="terminal-placeholder">
        <div class="placeholder-icon">
          <svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" opacity="0.3" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12z"/><path fill="currentColor" d="M7 17l4-4-4-4 1.4-1.4L13.8 13l-5.4 5.4L7 17zm5 0h6v-2h-6v2z"/></svg>
        </div>
        <div class="placeholder-text">{{ $t('terminal.autoCreate') }}</div>
      </div>
    </div>
  `,
  setup(props) {
    const store = createRouteBoundWorkbenchStore(Pinia.useChatStore(), props);
    const t = Vue.inject('t');

    const terminals = Vue.reactive({});
    const layoutTrees = Vue.reactive({});
    const activePanes = Vue.reactive({});

    const terminalError = Vue.ref('');
    const mountRefs = {};
    let xtermLoaded = false;

    const currentTree = Vue.computed(() => {
      const convId = store.currentConversation;
      return convId ? layoutTrees[convId] || null : null;
    });

    const currentActivePane = Vue.computed(() => {
      const convId = store.currentConversation;
      return convId ? activePanes[convId] || '' : '';
    });

    const hasActivePane = Vue.computed(() => !!currentActivePane.value);

    const setMountRef = (terminalId, el) => {
      if (el) {
        const oldEl = mountRefs[terminalId];
        mountRefs[terminalId] = el;

        if (oldEl && oldEl !== el) {
          const info = terminals[terminalId];
          if (info?.terminal?.element) {
            el.innerHTML = '';
            el.appendChild(info.terminal.element);
            Vue.nextTick(() => {
              try { info.fitAddon?.fit(); } catch {}
            });
          }
        }
      }
    };

    const activatePane = (terminalId) => {
      const convId = store.currentConversation;
      if (convId) activePanes[convId] = terminalId;
    };

    // xterm.js 加载
    async function ensureXterm() {
      if (xtermLoaded) return true;
      let TermClass = (typeof Terminal !== 'undefined') ? (Terminal.Terminal || Terminal) : null;
      let FitClass = (typeof FitAddon !== 'undefined') ? (FitAddon.FitAddon || FitAddon) : null;
      if (!TermClass || !FitClass) {
        try {
          await loadScript('vendor/xterm.min.js');
          await loadScript('vendor/xterm-addon-fit.min.js');
          TermClass = (typeof Terminal !== 'undefined') ? (Terminal.Terminal || Terminal) : null;
          FitClass = (typeof FitAddon !== 'undefined') ? (FitAddon.FitAddon || FitAddon) : null;
        } catch {}
      }
      if (!TermClass || !FitClass) {
        terminalError.value = t('terminal.xtermNotLoaded');
        return false;
      }
      xtermLoaded = true;
      return true;
    }

    function getTermTheme() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const s = getComputedStyle(document.documentElement);
      const bgMain = s.getPropertyValue('--bg-main').trim() || (isDark ? '#212121' : '#ffffff');
      return isDark ? {
        background: bgMain,
        foreground: '#d4d4d4',
        cursor: '#a0a0a0',
        selectionBackground: 'rgba(255,255,255,0.12)',
        black: '#3a3a3a', red: '#f48771', green: '#89d185', yellow: '#e5c07b',
        blue: '#6cb6ff', magenta: '#d670d6', cyan: '#56d4dd', white: '#cccccc',
        brightBlack: '#555555', brightRed: '#f48771', brightGreen: '#89d185', brightYellow: '#e5c07b',
        brightBlue: '#6cb6ff', brightMagenta: '#d670d6', brightCyan: '#56d4dd', brightWhite: '#e8e8e8'
      } : {
        background: bgMain,
        foreground: '#383a42',
        cursor: '#526fff',
        selectionBackground: 'rgba(0,0,0,0.07)',
        black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
        blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
        brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401',
        brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#fafafa'
      };
    }

    async function createPane(convId) {
      if (!convId || !store.currentAgent) return null;
      if (!(await ensureXterm())) return null;

      const terminalId = generateTerminalId(convId);
      const TermClass = Terminal.Terminal || Terminal;
      const FitClass = FitAddon.FitAddon || FitAddon;

      const term = new TermClass({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace, 'Symbols Nerd Font Mono', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'",
        theme: getTermTheme(),
        allowProposedApi: true
      });
      const fitAddon = new FitClass();
      term.loadAddon(fitAddon);

      term.attachCustomKeyEventHandler((e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') return false;
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) return false;
        return true;
      });

      terminals[terminalId] = {
        created: true,
        connected: false,
        terminal: term,
        fitAddon: fitAddon
      };

      term.onData((data) => {
        store.sendWsMessage({
          type: 'terminal_input',
          agentId: store.currentAgent,
          conversationId: convId,
          terminalId,
          data,
          _clientId: store.clientId
        });
      });

      return terminalId;
    }

    async function mountPane(convId, terminalId) {
      const info = terminals[terminalId];
      if (!info) return false;

      let el = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await Vue.nextTick();
        el = mountRefs[terminalId];
        if (el) break;
        if (attempt >= 2) {
          await new Promise(r => setTimeout(r, 50));
          el = mountRefs[terminalId];
          if (el) break;
        }
      }

      if (el) {
        info.terminal.open(el);
        info.fitAddon.fit();
        store.sendWsMessage({
          type: 'terminal_create',
          agentId: store.currentAgent,
          conversationId: convId,
          terminalId,
          workDir: props.workDir,
          cols: info.terminal.cols,
          rows: info.terminal.rows,
          _clientId: store.clientId
        });
        return true;
      } else {
        terminalError.value = t('terminal.mountFailed');
        info.terminal.dispose();
        delete terminals[terminalId];
        return false;
      }
    }

    let autoCreatePending = false;

    async function autoCreateIfNeeded() {
      const convId = store.currentConversation;
      if (!convId || !store.currentAgent) return;
      if (layoutTrees[convId]) return;
      if (autoCreatePending) return;

      autoCreatePending = true;
      terminalError.value = '';

      const terminalId = await createPane(convId);
      if (!terminalId) { autoCreatePending = false; return; }

      layoutTrees[convId] = Vue.reactive({ type: 'pane', terminalId });
      activePanes[convId] = terminalId;

      const ok = await mountPane(convId, terminalId);
      if (!ok) {
        delete layoutTrees[convId];
        delete activePanes[convId];
      }
      autoCreatePending = false;
    }

    async function splitPane(direction) {
      const convId = store.currentConversation;
      if (!convId || !activePanes[convId]) return;

      const activeId = activePanes[convId];
      const newTerminalId = await createPane(convId);
      if (!newTerminalId) return;

      const splitNode = Vue.reactive({
        type: 'split',
        direction,
        ratio: 0.5,
        first: { type: 'pane', terminalId: activeId },
        second: { type: 'pane', terminalId: newTerminalId }
      });

      const newTree = replaceNode(layoutTrees[convId], activeId, splitNode);
      layoutTrees[convId] = Vue.reactive(newTree);
      activePanes[convId] = newTerminalId;

      const ok = await mountPane(convId, newTerminalId);
      if (!ok) {
        const rollbackTree = removeNode(layoutTrees[convId], newTerminalId);
        if (rollbackTree) {
          layoutTrees[convId] = Vue.reactive(rollbackTree);
        }
        activePanes[convId] = activeId;
        return;
      }

      await Vue.nextTick();
      fitAllPanes(convId);
    }

    function closePane(terminalId) {
      const convId = store.currentConversation;
      if (!convId) return;

      const info = terminals[terminalId];
      if (info) {
        store.sendWsMessage({
          type: 'terminal_close',
          agentId: store.currentAgent,
          conversationId: convId,
          terminalId,
          _clientId: store.clientId
        });
        info.terminal?.dispose();
        delete terminals[terminalId];
        delete mountRefs[terminalId];
      }

      const newTree = removeNode(layoutTrees[convId], terminalId);
      if (newTree) {
        layoutTrees[convId] = Vue.reactive(newTree);
        if (activePanes[convId] === terminalId) {
          activePanes[convId] = findFirstLeaf(layoutTrees[convId]) || '';
        }
        Vue.nextTick(() => fitAllPanes(convId));
      } else {
        delete layoutTrees[convId];
        delete activePanes[convId];
        Vue.nextTick(() => autoCreateIfNeeded());
      }
    }

    function closeActivePane() {
      const convId = store.currentConversation;
      if (!convId || !activePanes[convId]) return;
      closePane(activePanes[convId]);
    }

    function fitAllPanes(convId) {
      if (!convId) convId = store.currentConversation;
      if (!convId || !layoutTrees[convId]) return;
      const leaves = collectLeaves(layoutTrees[convId]);
      for (const tid of leaves) {
        const info = terminals[tid];
        if (info?.fitAddon && info.connected) {
          try {
            info.fitAddon.fit();
            store.sendWsMessage({
              type: 'terminal_resize',
              agentId: store.currentAgent,
              conversationId: convId,
              terminalId: tid,
              cols: info.terminal.cols,
              rows: info.terminal.rows,
              _clientId: store.clientId
            });
          } catch {}
        }
      }
    }

    function handleWorkbenchMessage(event) {
      const msg = event.detail;
      if (!msg || !isWorkbenchMessageForRoute(msg, props.routeKey, props.workspaceGeneration)) return;
      if (props.routeKey && workbenchMessageScope(msg, props.routeKey) !== 'main') return;

      switch (msg.type) {
        case 'terminal_created': {
          const tid = msg.terminalId || msg.conversationId;
          const info = terminals[tid];
          if (info) {
            if (msg.success) {
              info.connected = true;
              terminalError.value = '';
            } else {
              terminalError.value = msg.error || t('terminal.createFailed');
              info.terminal?.dispose();
              delete terminals[tid];
              const convId = msg.conversationId;
              if (convId && layoutTrees[convId]) {
                const newTree = removeNode(layoutTrees[convId], tid);
                if (newTree) {
                  layoutTrees[convId] = Vue.reactive(newTree);
                } else {
                  delete layoutTrees[convId];
                  delete activePanes[convId];
                }
              }
            }
          }
          break;
        }
        case 'terminal_output': {
          const tid = msg.terminalId || msg.conversationId;
          const info = terminals[tid];
          if (info?.terminal) {
            info.terminal.write(msg.data);
          }
          break;
        }
        case 'terminal_closed': {
          const tid = msg.terminalId || msg.conversationId;
          const info = terminals[tid];
          if (info) {
            info.terminal?.dispose();
            delete terminals[tid];
            delete mountRefs[tid];
            const convId = msg.conversationId;
            if (convId && layoutTrees[convId]) {
              const newTree = removeNode(layoutTrees[convId], tid);
              if (newTree) {
                layoutTrees[convId] = Vue.reactive(newTree);
                if (activePanes[convId] === tid) {
                  activePanes[convId] = findFirstLeaf(layoutTrees[convId]) || '';
                }
              } else {
                delete layoutTrees[convId];
                delete activePanes[convId];
              }
            }
          }
          break;
        }
        case 'terminal_error': {
          terminalError.value = msg.message || t('terminal.error');
          const tid = msg.terminalId;
          if (tid && terminals[tid] && !terminals[tid].connected) {
            terminals[tid].terminal?.dispose();
            delete terminals[tid];
            const convId = msg.conversationId;
            if (convId && layoutTrees[convId]) {
              const newTree = removeNode(layoutTrees[convId], tid);
              if (newTree) {
                layoutTrees[convId] = Vue.reactive(newTree);
              } else {
                delete layoutTrees[convId];
                delete activePanes[convId];
              }
            }
          }
          break;
        }
      }
    }

    let resizeTimer = null;
    function handleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitAllPanes(), 100);
    }

    function handleFitAll() {
      fitAllPanes();
    }

    function handleConversationDeleted(event) {
      const { conversationId } = event.detail;
      if (!conversationId) return;
      if (layoutTrees[conversationId]) {
        const leaves = collectLeaves(layoutTrees[conversationId]);
        for (const tid of leaves) {
          const info = terminals[tid];
          if (info) {
            store.sendWsMessage({
              type: 'terminal_close',
              terminalId: tid,
              _clientId: store.clientId,
            });
            info.terminal?.dispose();
            delete terminals[tid];
            delete mountRefs[tid];
          }
        }
        delete layoutTrees[conversationId];
        delete activePanes[conversationId];
      }
    }

    const capabilityActive = Vue.ref(true);

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleWorkbenchMessage);
      window.addEventListener('resize', handleResize);
      window.addEventListener('terminal-fit-all', handleFitAll);
      window.addEventListener('conversation-deleted', handleConversationDeleted);
    });

    Vue.onActivated(() => {
      capabilityActive.value = true;
      Vue.nextTick(() => {
        autoCreateIfNeeded();
        fitAllPanes();
      });
    });

    Vue.onDeactivated(() => {
      capabilityActive.value = false;
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('workbench-message', handleWorkbenchMessage);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('terminal-fit-all', handleFitAll);
      window.removeEventListener('conversation-deleted', handleConversationDeleted);
      clearTimeout(resizeTimer);
      for (const tid of Object.keys(terminals)) {
        store.sendWsMessage({
          type: 'terminal_close',
          terminalId: tid,
          _clientId: store.clientId,
        });
        terminals[tid]?.terminal?.dispose();
      }
    });

    Vue.watch(
      () => [store.currentConversation, store.workbenchExpanded],
      () => {
        Vue.nextTick(() => {
          const convId = store.currentConversation;
          if (!convId || !store.workbenchExpanded || !capabilityActive.value) return;
          const tabEl = document.querySelector('.terminal-tab');
          if (tabEl && tabEl.offsetParent !== null) {
            autoCreateIfNeeded();
          }
        });
      },
      { immediate: true }
    );

    Vue.watch(
      () => store.connectionState,
      (newState, oldState) => {
        if (newState === 'connected' && oldState && oldState !== 'connected') {
          console.log('[Terminal] WebSocket reconnected, cleaning up stale terminals');
          for (const tid of Object.keys(terminals)) {
            terminals[tid]?.terminal?.dispose();
            delete terminals[tid];
            delete mountRefs[tid];
          }
          for (const convId of Object.keys(layoutTrees)) {
            delete layoutTrees[convId];
            delete activePanes[convId];
          }
          Vue.nextTick(() => autoCreateIfNeeded());
        }
      }
    );

    Vue.watch(() => store.currentConversation, () => {
      Vue.nextTick(() => fitAllPanes());
    });

    let visibilityObserver = null;
    Vue.onMounted(() => {
      const checkVisibility = () => {
        const tabEl = document.querySelector('.terminal-tab');
        if (capabilityActive.value && tabEl && tabEl.offsetParent !== null) {
          autoCreateIfNeeded();
          fitAllPanes();
        }
      };

      visibilityObserver = new MutationObserver(() => {
        setTimeout(checkVisibility, 50);
      });

      const workbenchContent = document.querySelector('.workbench-tab-content');
      if (workbenchContent) {
        visibilityObserver.observe(workbenchContent, { attributes: true, subtree: true, attributeFilter: ['style'] });
      }
    });

    Vue.onUnmounted(() => {
      if (visibilityObserver) visibilityObserver.disconnect();
    });

    return {
      store,
      terminals,
      currentTree,
      currentActivePane,
      hasActivePane,
      terminalError,
      setMountRef,
      activatePane,
      splitPane,
      closeActivePane,
      closePane
    };
  }
};
