import ToolLine from './ToolLine.js';
import AskCard from './AskCard.js';
import VpSpeakerHeader from './VpSpeakerHeader.js';
import { getTodoDisplayState } from '../utils/todo-display-state.js';

export default {
  name: 'AssistantTurn',
  components: { ToolLine, AskCard, VpSpeakerHeader },
  emits: ['open-vp-detail'],
  props: {
    turn: {
      type: Object,
      required: true
    },
    conversationId: {
      type: String,
      default: null
    },
    // When true, suppresses the VpSpeakerHeader regardless of
    // turn.showSpeakerHeader. Used by VpTurnBlock, which renders its own
    // header in the right-column grid layout and would otherwise double the
    // attribution. Default false keeps the legacy MessageList path
    // unchanged.
    hideSpeakerHeader: {
      type: Boolean,
      default: false
    }
  },
  template: `
    <div class="assistant-turn" ref="turnRef" :class="{ streaming: turn.isStreaming, 'has-vp-speaker': !!turn.speakerVpId }">
      <!-- 0. task-334-ui-b: VP speaker header — only when a speakerVpId is
           bound AND the upstream consecutive-collapse decided this turn
           should show the attribution. Legacy 1:1 chat turns leave
           speakerVpId null → showSpeakerHeader stays false → inert. -->
      <VpSpeakerHeader
        v-if="turn.showSpeakerHeader && turn.speakerVpId && !hideSpeakerHeader"
        :vp-id="turn.speakerVpId"
        :timestamp="turn.speakerTimestamp || 0"
        :state-cause="turn.speakerStateCause || ''"
        :turn-id="turn.turnId || ''"
        :show-stop="turn.isStreaming && !!turn.turnId"
        @open-detail="onOpenVpDetail"
        @stop-turn="onStopTurn"
      />

      <!-- 1. Text content -->
      <div v-if="turn.textContent" class="turn-content">
        <div class="turn-header">
          <!-- H2.f.4: ThreadPill removed (multi-thread retired). -->
          <button class="copy-btn" @click="copyContent" :title="copied ? $t('message.copied') : $t('message.copy')">
            <svg v-if="!copied" viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          </button>
        </div>
        <div class="turn-text markdown-body" v-html="renderedContent"></div>
        <span v-if="turn.isStreaming" class="cursor-blink"></span>
      </div>

      <!-- 2. Todo progress (TodoWrite) -->
      <div v-if="turn.todoMsg" class="turn-todos">
        <div v-for="todo in displayedTodos" :key="todo.content"
             class="todo-item" :class="todo.displayStatus">
          <span class="todo-checkbox">
            <span v-if="todo.displayStatus === 'completed'">✓</span>
            <span v-else-if="todo.displayStatus === 'in_progress'" class="todo-spinner"></span>
          </span>
          <span class="todo-text">{{ todo.displayText }}</span>
        </div>
      </div>

      <!-- 3. Tool actions -->
      <div v-if="showToolActions" class="turn-actions">
        <div v-if="expanded" class="turn-actions-history">
          <template v-for="(tool, i) in historyTools" :key="i">
            <ToolLine :tool-name="tool.toolName" :tool-input="tool.toolInput"
                      :tool-result="tool.toolResult" :has-result="!!tool.hasResult" :start-time="tool.startTime" />
          </template>
        </div>
        <div class="turn-actions-latest">
          <button v-if="turn.toolMsgs.length > 1" class="turn-expand-btn" @click="toggleExpand">
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path v-if="expanded" fill="currentColor" d="M7 14l5-5 5 5z"/>
              <path v-else fill="currentColor" d="M7 10l5 5 5-5z"/>
            </svg>
            <span>{{ turn.toolMsgs.length - 1 }} more</span>
          </button>
          <ToolLine :tool-name="latestTool.toolName" :tool-input="latestTool.toolInput"
                    :tool-result="latestTool.toolResult" :has-result="!!latestTool.hasResult" :start-time="latestTool.startTime" />
        </div>
      </div>

      <!-- 4. Images from Claude response (screenshots, etc.) -->
      <div v-if="turn.imageMsgs && turn.imageMsgs.length > 0" class="turn-images">
        <div v-for="img in turn.imageMsgs" :key="img.id" class="turn-image-item">
          <img v-if="img.fileId" :src="getImageUrl(img)" class="chat-screenshot"
               @error="handleImageError($event)"
               @click="openImagePreview(getImageUrl(img))" />
        </div>
      </div>

      <!-- 5. AskUserQuestion interactive card -->
      <div v-if="turn.askMsg" class="turn-ask">
        <AskCard :ask-msg="turn.askMsg" @submit="onAskSubmit" />
      </div>

      <!-- 6. Copy full response button (visible on hover) -->
      <div class="turn-footer" v-if="turn.textContent && !turn.isStreaming">
        <span
          v-if="turnTime"
          class="turn-time"
          :title="turnTimeFull"
          :aria-label="$t('unify.message.timeAria', { time: turnTimeFull })"
        >{{ turnTime }}</span>
        <button class="screenshot-btn" @click="screenshotContent" :title="screenshotting ? $t('message.screenshotting') : $t('message.screenshot')">
          <svg v-if="!screenshotting" viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
          </svg>
          <svg v-else class="screenshot-spinner" viewBox="0 0 24 24" width="14" height="14">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30 70" />
          </svg>
          <span class="screenshot-label">{{ screenshotting ? $t('message.screenshotting') : $t('message.screenshot') }}</span>
        </button>
        <button class="export-md-btn" @click="exportMarkdown" :title="$t('message.exportMd')">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          <span class="export-md-label">{{ $t('message.exportMd') }}</span>
        </button>
        <button class="copy-full-btn" @click="copyFullResponse" :title="fullCopied ? $t('message.copied') : $t('message.copyAll')">
          <svg v-if="!fullCopied" viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          <span class="copy-full-label">{{ fullCopied ? $t('message.copied') : $t('message.copyAll') }}</span>
        </button>
        <!-- H2.f.6: Fork-from-here button removed (single-conversation model). -->
      </div>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const copied = Vue.ref(false);
    const fullCopied = Vue.ref(false);
    const expanded = Vue.ref(false);
    const screenshotting = Vue.ref(false);
    const turnRef = Vue.ref(null);
    const t = Vue.inject('t');

    // AskUserQuestion — delegate to AskCard component
    const onAskSubmit = (requestId, answers) => {
      store.answerUserQuestion(requestId, answers, props.conversationId || undefined);
    };

    const showToolActions = Vue.computed(() => {
      return props.turn.toolMsgs.length > 0;
    });

    const latestTool = Vue.computed(() => {
      const tools = props.turn.toolMsgs;
      return tools[tools.length - 1];
    });

    const historyTools = Vue.computed(() => {
      return props.turn.toolMsgs.slice(0, -1);
    });

    const displayedTodos = Vue.computed(() => {
      const todos = props.turn?.todoMsg?.toolInput?.todos;
      if (!Array.isArray(todos)) return [];
      return todos.map((todo) => getTodoDisplayState(props.turn, todo));
    });

    // H2.f.6: threadDisplayName computed removed (single-conversation model).

    const toggleExpand = () => {
      expanded.value = !expanded.value;
    };

    // Markdown rendering
    const configureMarked = () => {
      if (typeof marked !== 'undefined') {
        marked.setOptions({
          highlight: function(code, lang) {
            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
              try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
            }
            return code;
          },
          breaks: true,
          gfm: true
        });
      }
    };
    configureMarked();

    const renderedContent = Vue.computed(() => {
      if (!props.turn.textContent) return '';
      let content = props.turn.textContent;
      if (typeof content !== 'string') {
        if (Array.isArray(content)) {
          content = content.map(block => {
            if (typeof block === 'string') return block;
            if (block && block.type === 'text') return block.text || '';
            return '';
          }).join('');
        } else {
          content = String(content);
        }
      }
      if (!content) return '';
      try {
        if (typeof marked !== 'undefined') {
          const html = marked.parse(content);
          return wrapTables(addCodeBlockCopyButtons(html));
        }
      } catch (e) {
        console.error('Markdown parsing error:', e);
      }
      return simpleMarkdown(content);
    });

    const addCodeBlockCopyButtons = (html) => {
      return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
        (match, attrs, code) => {
          const langMatch = attrs.match(/class="language-(\w+)"/);
          const lang = langMatch ? langMatch[1] : '';
          return `<div class="code-block-wrapper">
            <div class="code-block-header">
              <span class="code-lang">${lang}</span>
              <button class="code-copy-btn" onclick="window.copyCodeBlock(this)" title="Copy">
                <svg viewBox="0 0 24 24" width="14" height="14">
                  <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                </svg>
              </button>
            </div>
            <pre><code${attrs}>${code}</code></pre>
          </div>`;
        });
    };

    const wrapTables = (html) => {
      return html.replace(/<table>([\s\S]*?)<\/table>/g,
        (match) => `<div class="table-scroll-wrapper">${match}</div>`);
    };

    const simpleMarkdown = (text) => {
      if (!text) return '';
      if (typeof text !== 'string') text = String(text);
      const esc = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      };
      return text
        .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
          `<div class="code-block-wrapper"><pre><code class="language-${lang}">${esc(code.trim())}</code></pre></div>`)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\n/g, '<br>');
    };

    const copyContent = async () => {
      try {
        await navigator.clipboard.writeText(props.turn.textContent || '');
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
    };

    const copyFullResponse = async () => {
      try {
        await navigator.clipboard.writeText(props.turn.textContent || '');
        fullCopied.value = true;
        setTimeout(() => { fullCopied.value = false; }, 2000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
    };

    const exportMarkdown = () => {
      const text = props.turn.textContent || '';
      if (!text) return;
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `response-${Date.now()}.md`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    };

    const screenshotContent = async () => {
      if (screenshotting.value || !window.htmlToImage) return;
      screenshotting.value = true;
      try {
        const el = turnRef.value;
        if (!el) return;
        const contentEl = el.querySelector('.turn-content');
        if (!contentEl) return;

        const bgColor = getComputedStyle(document.body).getPropertyValue('--bg-main').trim() || '#ffffff';
        contentEl.classList.add('screenshot-mode');
        try {
          const pad = 32;
          const rect = contentEl.getBoundingClientRect();
          const dataUrl = await window.htmlToImage.toPng(contentEl, {
            backgroundColor: bgColor,
            pixelRatio: 3,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            style: {
              padding: `${pad}px`,
            },
            filter: (node) => {
              if (node.classList && (node.classList.contains('turn-header') || node.classList.contains('screenshot-btn'))) return false;
              return true;
            }
          });

          const link = document.createElement('a');
          link.download = `response-${Date.now()}.png`;
          link.href = dataUrl;
          link.click();
        } finally {
          contentEl.classList.remove('screenshot-mode');
        }
      } catch (e) {
        console.error('Screenshot failed:', e);
      } finally {
        screenshotting.value = false;
      }
    };

    // Syntax highlighting
    Vue.onMounted(() => {
      if (!window.copyCodeBlock) {
        window.copyCodeBlock = async function(btn) {
          const wrapper = btn.closest('.code-block-wrapper');
          const code = wrapper.querySelector('code');
          if (code) {
            try {
              await navigator.clipboard.writeText(code.textContent);
              btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
              setTimeout(() => {
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
              }, 2000);
            } catch (e) { console.error('Copy failed:', e); }
          }
        };
      }
      Vue.nextTick(() => {
        if (typeof hljs !== 'undefined') {
          document.querySelectorAll('pre code:not([data-highlighted])').forEach(block => {
            hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
          });
        }
      });
    });

    Vue.watch(() => props.turn.textContent, () => {
      Vue.nextTick(() => {
        if (typeof hljs !== 'undefined') {
          document.querySelectorAll('pre code:not([data-highlighted])').forEach(block => {
            hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
          });
        }
      });
    });

    // Image helpers (reuse crew pattern)
    const getImageUrl = (msg) => {
      if (!msg.fileId) return '';
      const token = msg.previewToken || '';
      return `/api/preview/${msg.fileId}?token=${token}`;
    };

    const handleImageError = (event) => {
      event.target.style.display = 'none';
    };

    const openImagePreview = (url) => {
      window.open(url, '_blank');
    };

    // H2.f.6: canFork / forkFromHere removed alongside the multi-thread engine.

    // task-334-ui-c: forward VP speaker click → parent (MessageList →
    // UnifyPage → chatStore.enterVpDetailView). Kept opt-in via the
    // speaker header's `clickable` path so legacy 1:1 turns are unaffected.
    const onOpenVpDetail = (vpId) => {
      if (!vpId) return;
      // Emit for MessageList/UnifyPage to handle; fall back to direct store
      // call if the enclosing page did not wire the listener.
      try {
        if (typeof store.enterVpDetailView === 'function') {
          store.enterVpDetailView(vpId);
        }
      } catch (e) {
        console.error('[AssistantTurn] enterVpDetailView failed:', e);
      }
    };

    const onStopTurn = (turnId) => {
      if (!turnId) return;
      try {
        if (typeof store.cancelVpTurn === 'function') {
          store.cancelVpTurn(turnId);
        }
      } catch (e) {
        console.error('[AssistantTurn] cancelVpTurn failed:', e);
      }
    };

    // task-334-ui-c (C): per-message hover timestamp — mirrors MessageItem's
    // messageTime / messageTimeFull pattern. Hidden by default via CSS; the
    // `.turn-footer:hover .turn-time` rule reveals it on hover.
    const _turnTimeSource = () => {
      const t = props.turn;
      if (!t) return null;
      if (typeof t.timestamp === 'number' && t.timestamp > 0) return t.timestamp;
      if (typeof t.createdAt === 'number' && t.createdAt > 0) return t.createdAt;
      if (typeof t.speakerTimestamp === 'number' && t.speakerTimestamp > 0) return t.speakerTimestamp;
      return null;
    };
    const turnTime = Vue.computed(() => {
      const ts = _turnTimeSource();
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    });
    const turnTimeFull = Vue.computed(() => {
      const ts = _turnTimeSource();
      if (!ts) return '';
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    });

    return {
      onOpenVpDetail,
      onStopTurn,
      turnTime,
      turnTimeFull,
      copied,
      fullCopied,
      expanded,
      screenshotting,
      turnRef,
      showToolActions,
      latestTool,
      historyTools,
      toggleExpand,
      renderedContent,
      copyContent,
      copyFullResponse,
      exportMarkdown,
      screenshotContent,
      onAskSubmit,
      getImageUrl,
      handleImageError,
      openImagePreview,
      displayedTodos
    };
  }
};
