/**
 * ToolLine — Shared tool call display component
 * Used by both CrewChatView and MessageItem
 *
 * Props:
 *   toolName   — String, tool name (Read, Edit, Bash, etc.)
 *   toolInput  — Object, tool input parameters
 *   toolResult — Any, tool result content (optional)
 *   hasResult  — Boolean, whether result has arrived
 *   compact    — Boolean, compact mode for crew view
 *   startTime  — Number, timestamp when tool execution started (optional)
 */
import { formatRouteForwardToolLine } from '../utils/route-forward-display.js';
import { normalizeTerminalOutput } from '../utils/terminal-output.js';

export default {
  name: 'ToolLine',
  props: {
    toolName: { type: String, required: true },
    toolInput: { type: Object, default: null },
    toolResult: { default: null },
    hasResult: { type: Boolean, default: false },
    compact: { type: Boolean, default: false },
    startTime: { type: Number, default: 0 },
    expanded: { type: Boolean, default: null }
  },
  emits: ['update:expanded'],
  template: `
    <div class="crew-msg-tool">
      <div class="tool-line" :class="{ expandable: hasExpandableContent, expanded: isExpanded, completed: hasResult, running: !hasResult }" @click="toggle">
        <span class="tool-line-icon">{{ getToolIcon(toolName) }}</span>
        <span class="tool-line-text">{{ getToolOneLine(toolName, toolInput) }}</span>
        <span class="tool-line-status completed" v-if="hasResult">\u2713</span>
        <span class="tool-line-status running" v-else><span class="tool-dots"><span></span><span></span><span></span></span></span>
        <span class="tool-line-time" v-if="formattedTime">{{ formattedTime }}</span>
        <span class="tool-line-toggle" v-if="hasExpandableContent" @click.stop="toggle">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
        </span>
      </div>
      <div class="tool-expand" v-if="isExpanded && hasExpandableContent" @click.stop>
        <div v-if="isEditTool && hasDiff" v-html="renderDiff(toolInput)"></div>
        <div v-else-if="toolName === 'Write' && toolInput?.content" class="tool-expand-code">
          <pre><code>{{ toolInput.content }}</code></pre>
        </div>
        <div v-else-if="toolName === 'Bash' && toolInput?.command" class="tool-expand-code">
          <pre><code>{{ toolInput.command }}</code></pre>
          <div v-if="hasResult && bashOutput" class="bash-output">
            <div class="bash-output-header">Output</div>
            <pre class="bash-output-content"><code>{{ bashOutput }}</code></pre>
          </div>
        </div>
        <div v-else-if="toolName === '__SubagentResult'" class="tool-expand-code">
          <pre><code>{{ syntheticResultOutput }}</code></pre>
        </div>
        <div v-else-if="toolName === '__CompactSummary'" class="tool-expand-code">
          <pre><code>{{ compactSummaryOutput }}</code></pre>
        </div>
        <div v-else class="tool-expand-code">
          <pre><code>{{ formatInput(toolInput) }}</code></pre>
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const internalExpanded = Vue.ref(props.toolName === 'Edit');
    const isExpanded = Vue.computed(() => props.expanded === null ? internalExpanded.value : !!props.expanded);
    const setExpanded = (value) => {
      internalExpanded.value = !!value;
      emit('update:expanded', !!value);
    };

    const formattedTime = Vue.computed(() => {
      if (!props.startTime) return '';
      const d = new Date(props.startTime);
      const h = d.getHours().toString().padStart(2, '0');
      const m = d.getMinutes().toString().padStart(2, '0');
      const s = d.getSeconds().toString().padStart(2, '0');
      return `${h}:${m}:${s}`;
    });

    const isEditTool = Vue.computed(() => props.toolName === 'Edit');
    const hasDiff = Vue.computed(() => {
      const input = props.toolInput;
      return input && input.old_string !== undefined && input.new_string !== undefined;
    });

    const hasExpandableContent = Vue.computed(() => {
      const input = props.toolInput;
      if (!input) return false;
      if (props.toolName === 'Edit') return hasDiff.value;
      if (props.toolName === 'Bash') return !!(input.command?.length > 60 || props.hasResult);
      if (props.toolName === 'Read') return !!input.file_path;
      if (props.toolName === 'Write') return !!input.content;
      return Object.keys(input).length > 0;
    });

    const extractTextResult = (result) => {
      if (!result) return '';
      if (typeof result === 'string') return result;
      if (Array.isArray(result)) {
        return result.map(r => typeof r === 'string' ? r : r?.type === 'text' ? r.text : '').filter(Boolean).join('\n');
      }
      if (result?.type === 'text' && result?.text) return result.text;
      if (result?.content) {
        if (typeof result.content === 'string') return result.content;
        if (Array.isArray(result.content)) {
          return result.content.map(r => typeof r === 'string' ? r : r?.type === 'text' ? r.text : '').filter(Boolean).join('\n');
        }
      }
      return '';
    };

    const bashOutput = Vue.computed(() => {
      if (props.toolName !== 'Bash') return '';
      return normalizeTerminalOutput(extractTextResult(props.toolResult));
    });

    const syntheticResultOutput = Vue.computed(() => {
      if (props.toolName !== '__SubagentResult') return '';
      return normalizeTerminalOutput(props.toolInput?.result || props.toolInput?.summary || formatInput(props.toolInput));
    });

    const compactSummaryOutput = Vue.computed(() => {
      if (props.toolName !== '__CompactSummary') return '';
      return normalizeTerminalOutput(props.toolInput?.summary || formatInput(props.toolInput));
    });

    const toggle = () => {
      if (hasExpandableContent.value) setExpanded(!isExpanded.value);
    };

    const middleTruncate = (text, maxLen = 80) => {
      if (!text || text.length <= maxLen) return text || '';
      const headLen = Math.ceil(maxLen * 0.6);
      const tailLen = maxLen - headLen - 3;
      return text.slice(0, headLen) + '...' + text.slice(-tailLen);
    };

    const getToolIcon = (name) => {
      const icons = { Read: '\u{1F4D6}', Edit: '\u270F\uFE0F', Write: '\u{1F4DD}', Bash: '\u26A1', Glob: '\u{1F50D}', Grep: '\u{1F50E}', Task: '\u{1F4CB}', WebFetch: '\u{1F310}', WebSearch: '\u{1F50D}', TodoWrite: '\u2705', RouteForward: '@',
        // Synthetic tools \u2014 the agent (agent/claude.js) rewrites Claude
        // Code's "fake user messages" (<task-notification> sub-agent results
        // and post-compaction summaries) into tool_use blocks using these
        // names. Keep in sync with SYNTHETIC_TOOL_NAMES in
        // agent/synthetic-tools.js \u2014 that file is the source of truth.
        __SubagentResult: '\u{1F916}',  // robot
        __CompactSummary: '\u{1F4DA}',  // books
      };
      return icons[name] || '\u2699\uFE0F';
    };

    const cleanOneLine = (text) => normalizeTerminalOutput(text).replace(/\s+/g, ' ').trim();

    const getToolOneLine = (toolName, input) => {
      if (!input) return toolName;
      if (toolName === 'Read' && input.file_path) {
        let line = `Read ${input.file_path}`;
        if (input.offset || input.limit) {
          const start = (input.offset || 0) + 1;
          const end = input.limit ? start + input.limit - 1 : '\u221E';
          line += `:${start}-${end}`;
        }
        return line;
      }
      if (toolName === 'Edit' && input.file_path) return `Edit ${input.file_path}`;
      if (toolName === 'Write' && input.file_path) return `Write ${input.file_path}`;
      if (toolName === 'Bash' && input.command) {
        const cmd = input.command;
        return middleTruncate(cmd, 80);
      }
      if (toolName === 'Glob' && input.pattern) return `Glob ${input.pattern}` + (input.path ? ` in ${input.path}` : '');
      if (toolName === 'Grep' && input.pattern) {
        let line = `Grep "${input.pattern}"`;
        if (input.path) line += ` in ${input.path}`;
        if (input.glob) line += ` (${input.glob})`;
        return line;
      }
      if (toolName === 'Task') {
        const agent = input.subagent_type || 'agent';
        const desc = input.description || middleTruncate(input.prompt || '', 40);
        return `Task [${agent}]: ${desc}`;
      }
      if (toolName === 'WebFetch' && input.url) {
        try {
          const url = new URL(input.url);
          return `Fetch ${url.hostname}${url.pathname.length > 20 ? middleTruncate(url.pathname, 20) : url.pathname}`;
        } catch { return `Fetch ${input.url.slice(0, 50)}`; }
      }
      if (toolName === 'WebSearch' && input.query) return `Search "${input.query}"`;
      if (toolName === 'TodoWrite' && input.todos) {
        const completed = input.todos.filter(t => t.status === 'completed').length;
        return `Todo: ${completed}/${input.todos.length} done`;
      }
      if (toolName === 'RouteForward') {
        return formatRouteForwardToolLine(input, middleTruncate);
      }
      // Synthetic tools — agent rewrites Claude Code's fake-user messages
      // into these blocks (see agent/claude.js).
      if (toolName === '__SubagentResult') {
        const label = cleanOneLine(input.summary || input.status || 'completed');
        return `Sub-agent: ${middleTruncate(label, 80)}`;
      }
      if (toolName === '__CompactSummary') {
        const summary = normalizeTerminalOutput(input.summary || '');
        return `Context summarized (${summary.length} chars)`;
      }
      return toolName;
    };

    const escapeHtml = (str) => {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    const renderDiff = (input) => {
      if (!input || input.old_string === undefined || input.new_string === undefined) return '';
      let html = '<div class="diff-compact">';
      input.old_string.split('\n').forEach(line => { html += `<div class="diff-line del">- ${escapeHtml(line)}</div>`; });
      input.new_string.split('\n').forEach(line => { html += `<div class="diff-line add">+ ${escapeHtml(line)}</div>`; });
      html += '</div>';
      return html;
    };

    const formatInput = (input) => {
      try { return JSON.stringify(input, null, 2); } catch { return String(input); }
    };

    return {
      isExpanded, isEditTool, hasDiff, hasExpandableContent, bashOutput,
      syntheticResultOutput, compactSummaryOutput, formattedTime,
      toggle, getToolIcon, getToolOneLine, renderDiff, formatInput
    };
  }
};
