import ToolLine from './ToolLine.js';
import AskCard from './AskCard.js';
import VpSpeakerHeader from './VpSpeakerHeader.js';
import { normalizeTerminalOutput } from '../utils/terminal-output.js';
import { normalizeRouteForwardDisplay } from '../utils/route-forward-display.js';
import { getTodoDisplayState } from '../utils/todo-display-state.js';
import { renderMermaidIn } from '../utils/markdown.js';
import { openImagePreview } from '../utils/imagePreview.js';
import { formatSessionMessageDateTime, quoteFromAssistantTurn } from '../utils/session-message-quote.js';
import {
  collectMessageFileReferences,
  decorateMessageFileReferences,
  resolveMessageFileReference,
} from '../utils/message-file-reference.js';

export default {
  name: 'AssistantTurn',
  components: { ToolLine, AskCard, VpSpeakerHeader },
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
    },
    actionsExpanded: {
      type: Boolean,
      default: null
    },
    toolExpandStates: {
      type: Object,
      default: null
    },
    toolStatePrefix: {
      type: String,
      default: ''
    },
    responseCollapsible: {
      type: Boolean,
      default: false
    },
    responseCollapsed: {
      type: Boolean,
      default: false
    },
    responseToggleLabel: {
      type: String,
      default: ''
    },
    sessionActions: { type: Boolean, default: false },
    quoteAuthor: { type: String, default: '' },
    // VpTurnBlock opts into the turn-scoped debug action. Keeping this
    // opt-in preserves the legacy Chat footer unchanged.
    showDebugAction: { type: Boolean, default: false },
    debugActionTitle: { type: String, default: '' }
  },
  emits: ['update-actions-expanded', 'update-tool-expanded', 'toggle-response-collapse', 'quote', 'open-debug'],
  template: `
    <div class="assistant-turn" ref="turnRef" :class="{ streaming: turn.isStreaming, 'has-vp-speaker': !!turn.speakerVpId, 'has-turn-debug-action': showDebugAction }">
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
        @stop-turn="onStopTurn"
      />

      <div class="turn-message-block" :data-turn-id="turn.turnId || ''">
        <!-- 1. Text content -->
        <div v-if="textSegments.length > 0" class="turn-content">
          <div class="turn-header">
            <!-- Session message blocks are keyed by turn/message identity; no thread pill is rendered. -->
            <button class="copy-btn" @click="copyContent" :title="copied ? $t('message.copied') : $t('message.copy')">
              <svg v-if="!copied" viewBox="0 0 24 24" width="16" height="16">
                <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="16" height="16">
                <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </button>
          </div>
          <div v-if="progressSegments.length > 0" class="turn-progress-group">
            <div class="turn-progress-list">
              <div
                v-for="segment in progressSegments"
                :key="segment.key"
                class="turn-response-segment turn-response-progress"
              >
                <div class="turn-text markdown-body" v-html="renderSegment(segment.content)" @click="onMarkdownClick"></div>
                <span v-if="segment.isStreaming" class="cursor-blink"></span>
              </div>
            </div>
          </div>
          <div
            v-for="segment in resultSegments"
            :key="segment.key"
            class="turn-response-segment turn-response-result"
          >
            <div class="turn-text markdown-body" v-html="renderSegment(segment.content)" @click="onMarkdownClick"></div>
            <span v-if="segment.isStreaming" class="cursor-blink"></span>
          </div>
        </div>

      <!-- 2. VP hand-off messages (RouteForward) -->
      <div v-if="routeMessages.length > 0" class="turn-route-messages">
        <div v-for="(route, i) in routeMessages" :key="route.key || i" class="turn-route-message">
          <div class="turn-route-body">
            <div class="turn-route-target">{{ route.target }}</div>
            <div v-if="route.text" class="turn-route-text">{{ route.text }}</div>
            <div v-if="route.reason" class="turn-route-reason">{{ route.reason }}</div>
          </div>
        </div>
      </div>

      <!-- 3. Todo progress (TodoWrite) -->
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
            <ToolLine
              :tool-name="tool.toolName"
              :tool-input="tool.toolInput"
              :tool-result="tool.toolResult"
              :has-result="!!tool.hasResult"
              :start-time="tool.startTime"
              :expanded="toolExpandedValue(tool, i, 'history')"
              @update:expanded="value => updateToolExpanded(tool, i, 'history', value)"
            />
          </template>
        </div>
        <div v-if="latestTool" class="turn-actions-latest">
          <button v-if="actionTools.length > 1" class="turn-expand-btn" @click="toggleExpand">
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path v-if="expanded" fill="currentColor" d="M7 14l5-5 5 5z"/>
              <path v-else fill="currentColor" d="M7 10l5 5 5-5z"/>
            </svg>
            <span>{{ actionTools.length - 1 }} more</span>
          </button>
          <ToolLine
            :tool-name="latestTool.toolName"
            :tool-input="latestTool.toolInput"
            :tool-result="latestTool.toolResult"
            :has-result="!!latestTool.hasResult"
            :start-time="latestTool.startTime"
            :expanded="toolExpandedValue(latestTool, latestToolIndex, 'latest')"
            @update:expanded="value => updateToolExpanded(latestTool, latestToolIndex, 'latest', value)"
          />
        </div>
      </div>

      <!-- 4. Images from Claude response (screenshots, etc.) -->
      <div v-if="turn.imageMsgs && turn.imageMsgs.length > 0" class="turn-images">
        <button v-for="img in turn.imageMsgs" :key="img.assetId || img.id" type="button"
                class="turn-image-item" @click="previewImage(img, $event.currentTarget)">
          <img v-if="imageSrc(img) && !failedImages.has(img.assetId || img.id)"
               :src="imageSrc(img)" :alt="img.filename || $t('message.imagePreview')"
               class="chat-screenshot" loading="lazy" decoding="async"
               @error="handleImageError(img)" />
          <span v-else class="turn-image-fallback">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
            <span>{{ $t('message.imageUnavailable') }}</span>
          </span>
        </button>
      </div>

      <!-- 5. AskUserQuestion interactive card -->
      <div v-if="turn.askMsg" class="turn-ask">
        <AskCard :ask-msg="turn.askMsg" @submit="onAskSubmit" />
      </div>

      </div>

      <!-- 6. Response footer actions (visible on hover) -->
      <div class="turn-footer" v-if="(turn.textContent || responseCollapsible || showDebugAction || (sessionActions && (turn.todoMsg || turn.toolMsgs?.length))) && !turn.isStreaming">
        <span
          v-if="turnTime && !turn.speakerVpId"
          class="turn-time"
          :title="turnTimeFull"
          :aria-label="$t('yeaft.message.timeAria', { time: turnTimeFull })"
        >{{ turnTime }}</span>
        <span v-if="turn.llmCallCount > 0" class="turn-time">{{ $t(turn.llmCallCount === 1 ? 'yeaft.message.llmCall' : 'yeaft.message.llmCalls', { count: turn.llmCallCount }) }}</span>
        <button
          v-if="showDebugAction"
          type="button"
          class="message-action-btn debug-turn-action-btn"
          @click="$emit('open-debug')"
          :title="debugActionTitle"
          :aria-label="debugActionTitle"
        >
          <svg class="debug-turn-action-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>
        </button>
        <button v-if="sessionActions" type="button" class="message-action-btn" @click="$emit('quote', assistantQuote)" :title="$t('message.quote')" :aria-label="$t('message.quote')">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
        </button>
        <button v-if="turn.textContent" class="screenshot-btn" @click="screenshotContent" :title="screenshotting ? $t('message.screenshotting') : $t('message.screenshot')" :aria-label="screenshotting ? $t('message.screenshotting') : $t('message.screenshot')">
          <svg v-if="!screenshotting" viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
          </svg>
          <svg v-else class="screenshot-spinner" viewBox="0 0 24 24" width="14" height="14">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30 70" />
          </svg>
        </button>
        <button v-if="turn.textContent" class="export-md-btn" @click="exportMarkdown" :title="$t('message.exportMd')" :aria-label="$t('message.exportMd')">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
        </button>
        <button v-if="turn.textContent" class="copy-full-btn" @click="copyFullResponse" :title="fullCopied ? $t('message.copied') : $t('message.copyAll')" :aria-label="fullCopied ? $t('message.copied') : $t('message.copyAll')">
          <svg v-if="!fullCopied" viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        </button>
        <button
          v-if="responseCollapsible"
          class="response-collapse-btn"
          :class="{ 'is-collapsed': responseCollapsed }"
          @click="$emit('toggle-response-collapse')"
          :title="responseToggleLabel"
          :aria-label="responseToggleLabel"
          :aria-expanded="String(!responseCollapsed)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path v-if="responseCollapsed" fill="currentColor" d="M7 10l5 5 5-5z"/>
            <path v-else fill="currentColor" d="M7 14l5-5 5 5z"/>
          </svg>
        </button>
        <!-- H2.f.6: Fork-from-here button removed (single-conversation model). -->
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const copied = Vue.ref(false);
    const fullCopied = Vue.ref(false);
    const internalExpanded = Vue.ref(false);
    const expanded = Vue.computed(() => props.actionsExpanded === null ? internalExpanded.value : !!props.actionsExpanded);
    const setExpanded = (value) => {
      internalExpanded.value = !!value;
      emit('update-actions-expanded', !!value);
    };
    const screenshotting = Vue.ref(false);
    const turnRef = Vue.ref(null);
    const failedImages = Vue.reactive(new Set());
    const resolvedFileReferences = Vue.reactive(new Map());
    let fileReferenceRequestId = null;
    const t = Vue.inject('t');

    // AskUserQuestion — delegate to AskCard component
    const onAskSubmit = (requestId, answers) => {
      store.answerUserQuestion(requestId, answers, props.conversationId || undefined);
    };

    const routeMessages = Vue.computed(() => {
      const tools = Array.isArray(props.turn?.toolMsgs) ? props.turn.toolMsgs : [];
      return tools
        .filter(tool => tool?.toolName === 'RouteForward')
        .map((tool, index) => ({
          ...normalizeRouteForwardDisplay(tool.toolInput || {}),
          key: tool.toolId || `${tool.startTime || 0}:${index}`,
        }));
    });

    const actionTools = Vue.computed(() => {
      const tools = Array.isArray(props.turn?.toolMsgs) ? props.turn.toolMsgs : [];
      return tools.filter(tool => tool?.toolName !== 'RouteForward');
    });

    const showToolActions = Vue.computed(() => actionTools.value.length > 0);

    const latestTool = Vue.computed(() => {
      const tools = actionTools.value;
      return tools[tools.length - 1];
    });

    const historyTools = Vue.computed(() => {
      return actionTools.value.slice(0, -1);
    });

    const latestToolIndex = Vue.computed(() => Math.max(0, actionTools.value.length - 1));

    const displayedTodos = Vue.computed(() => {
      const todos = props.turn?.todoMsg?.toolInput?.todos;
      if (!Array.isArray(todos)) return [];
      return todos.map((todo) => getTodoDisplayState(props.turn, todo));
    });

    // H2.f.6: threadDisplayName computed removed (single-conversation model).

    const toggleExpand = () => {
      setExpanded(!expanded.value);
    };

    const toolKey = (tool, index, bucket) => {
      const prefix = props.toolStatePrefix || props.turn.id || props.turn.turnId || 'assistant-turn';
      const name = tool?.toolName || 'tool';
      const start = tool?.startTime || index;
      return `${prefix}:tool:${bucket}:${index}:${name}:${start}`;
    };

    const toolExpandedValue = (tool, index, bucket) => {
      const key = toolKey(tool, index, bucket);
      return props.toolExpandStates && Object.prototype.hasOwnProperty.call(props.toolExpandStates, key)
        ? !!props.toolExpandStates[key]
        : null;
    };

    const updateToolExpanded = (tool, index, bucket, value) => {
      emit('update-tool-expanded', { key: toolKey(tool, index, bucket), value: !!value });
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

    const renderSegment = (value) => {
      let content = value;
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
      content = normalizeTerminalOutput(content);
      if (!content) return '';
      try {
        if (typeof marked !== 'undefined') {
          const html = marked.parse(content);
          return decorateMessageFileReferences(
            wrapTables(addCodeBlockCopyButtons(html)),
            resolvedFileReferences,
          );
        }
      } catch (e) {
        console.error('Markdown parsing error:', e);
      }
      return simpleMarkdown(content);
    };

    const onMarkdownClick = (event) => {
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || !event.currentTarget?.contains?.(anchor)) return;
      const reference = resolveMessageFileReference(anchor.getAttribute('href'));
      const resolvedPath = anchor.dataset?.resolvedFilePath;
      if (!reference || !resolvedPath) return;
      event.preventDefault();
      event.stopPropagation();
      store.openFileInExplorer(resolvedPath, { hideTree: true, line: reference.line });
    };

    const textSegments = Vue.computed(() => {
      if (Array.isArray(props.turn?.textSegments) && props.turn.textSegments.length > 0) {
        return props.turn.textSegments;
      }
      return props.turn?.textContent
        ? [{ key: 'legacy-result', content: props.turn.textContent, kind: 'result', isStreaming: props.turn.isStreaming === true }]
        : [];
    });
    const progressSegments = Vue.computed(() => textSegments.value.filter(segment => segment.kind !== 'result'));
    const resultSegments = Vue.computed(() => textSegments.value.filter(segment => segment.kind === 'result'));

    const fileReferenceSourceSignature = Vue.computed(() => textSegments.value.map(segment => {
      if (typeof segment?.content === 'string') return segment.content;
      return segment?.content == null ? '' : JSON.stringify(segment.content);
    }).join('\u0000'));
    const requestFileReferenceResolution = () => {
      if (props.turn?.isStreaming) return;
      const references = new Set();
      for (const segment of textSegments.value) {
        if (!segment?.content || typeof marked === 'undefined') continue;
        try {
          const html = marked.parse(typeof segment.content === 'string' ? segment.content : String(segment.content));
          for (const path of collectMessageFileReferences(html)) references.add(path);
        } catch (_) {}
      }
      resolvedFileReferences.clear();
      fileReferenceRequestId = store.resolveMessageFileReferences?.([...references]) || null;
    };
    const handleFileReferenceResolution = event => {
      const msg = event.detail;
      if (!fileReferenceRequestId || msg?.type !== 'file_references_resolved'
          || msg.requestId !== fileReferenceRequestId) return;
      fileReferenceRequestId = null;
      resolvedFileReferences.clear();
      for (const entry of msg.references || []) {
        if (entry?.requestedPath && entry?.resolvedPath) {
          resolvedFileReferences.set(entry.requestedPath, entry.resolvedPath);
        }
      }
    };
    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleFileReferenceResolution);
      requestFileReferenceResolution();
    });
    Vue.onBeforeUnmount(() => window.removeEventListener('workbench-message', handleFileReferenceResolution));
    Vue.watch(
      [() => props.turn?.isStreaming, fileReferenceSourceSignature, () => store.fileReferenceResolutionContextKey],
      ([streaming, signature, contextKey], [previousStreaming, previousSignature, previousContextKey]) => {
        if (!streaming
            && (previousStreaming || signature !== previousSignature || contextKey !== previousContextKey)) {
          requestFileReferenceResolution();
        }
      },
      { flush: 'post' },
    );

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
        renderMermaidIn(turnRef.value);
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
        renderMermaidIn(turnRef.value);
      });
    });

    // Image helpers
    const imageSrc = (msg) => {
      if (msg?.src) return msg.src;
      if (!msg?.fileId) return '';
      const token = msg.previewToken || '';
      return `/api/preview/${msg.fileId}?token=${token}`;
    };

    const handleImageError = (image) => {
      failedImages.add(image?.assetId || image?.id);
    };

    const previewableImages = Vue.computed(() => (
      (Array.isArray(props.turn?.imageMsgs) ? props.turn.imageMsgs : [])
        .map(image => ({
          image,
          src: imageSrc(image),
          alt: image?.filename || t('message.imagePreview'),
        }))
        .filter(entry => entry.src && !failedImages.has(entry.image?.assetId || entry.image?.id))
    ));

    const previewImage = (image, trigger) => {
      const images = previewableImages.value;
      const initialIndex = images.findIndex(entry => entry.image === image);
      if (initialIndex < 0) return;
      openImagePreview(images[initialIndex].src, {
        alt: images[initialIndex].alt,
        closeLabel: t('common.close'),
        previousLabel: t('message.previousImage'),
        nextLabel: t('message.nextImage'),
        positionLabel: (current, total) => t('message.imagePosition', { current, total }),
        gallery: images.map(({ src, alt }) => ({ src, alt })),
        initialIndex,
        trigger,
      });
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
    const turnTime = Vue.computed(() => formatSessionMessageDateTime(_turnTimeSource()));
    const turnTimeFull = Vue.computed(() => {
      const ts = _turnTimeSource();
      if (!ts) return '';
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    });
    const assistantQuote = Vue.computed(() => quoteFromAssistantTurn(
      props.turn,
      props.quoteAuthor || t('message.assistant')
    ));

    return {
      onStopTurn,
      turnTime,
      turnTimeFull,
      assistantQuote,
      copied,
      fullCopied,
      expanded,
      screenshotting,
      turnRef,
      showToolActions,
      latestTool,
      historyTools,
      latestToolIndex,
      actionTools,
      routeMessages,
      toggleExpand,
      toolExpandedValue,
      updateToolExpanded,
      textSegments,
      progressSegments,
      resultSegments,
      renderSegment,
      onMarkdownClick,
      copyContent,
      copyFullResponse,
      exportMarkdown,
      screenshotContent,
      onAskSubmit,
      imageSrc,
      failedImages,
      handleImageError,
      previewImage,
      displayedTodos
    };
  }
};
