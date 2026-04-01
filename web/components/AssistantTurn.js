import ToolLine from './ToolLine.js';
import AskCard from './AskCard.js';

export default {
  name: 'AssistantTurn',
  components: { ToolLine, AskCard },
  props: {
    turn: {
      type: Object,
      required: true
    },
    conversationId: {
      type: String,
      default: null
    }
  },
  template: `
    <div class="assistant-turn" ref="turnRef" :class="{ streaming: turn.isStreaming }">
      <!-- 1. Text content -->
      <div v-if="turn.textContent" class="turn-content">
        <div class="turn-header">
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
        <div v-for="todo in turn.todoMsg.toolInput.todos" :key="todo.content"
             class="todo-item" :class="todo.status">
          <span class="todo-checkbox">
            <span v-if="todo.status === 'completed'">✓</span>
            <span v-else-if="todo.status === 'in_progress'" class="todo-spinner"></span>
          </span>
          <span class="todo-text">{{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}</span>
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

      <!-- 4. AskUserQuestion interactive card -->
      <div v-if="turn.askMsg" class="turn-ask">
        <AskCard :ask-msg="turn.askMsg" @submit="onAskSubmit" />
      </div>

      <!-- 5. Copy full response button (visible on hover) -->
      <div class="turn-footer" v-if="turn.textContent && !turn.isStreaming">
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
        const dataUrl = await window.htmlToImage.toPng(contentEl, {
          backgroundColor: bgColor,
          pixelRatio: 2,
          style: {
            padding: '24px 32px',
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

    return {
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
      onAskSubmit
    };
  }
};
