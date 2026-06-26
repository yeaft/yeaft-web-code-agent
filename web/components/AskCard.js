/**
 * AskCard — Shared interactive card for AskUserQuestion tool.
 * Used by Chat mode (AssistantTurn).
 *
 * Props:
 *   askMsg   — the ask message object (askRequestId, askQuestions, toolInput, askAnswered, selectedAnswers)
 *  *
 * Events:
 *   submit(requestId, answers) — user submitted answers
 */
export default {
  name: 'AskCard',
  props: {
    askMsg: { type: Object, required: true },
    compact: { type: Boolean, default: false }
  },
  emits: ['submit'],
  template: `
    <div class="ask-card-wrapper">
      <!-- Collapsed summary for answered questions -->
      <div v-if="isAnswered" class="ask-summary">
        <span class="ask-summary-icon">✓</span>
        <span class="ask-summary-text">{{ summaryText }}</span>
      </div>

      <!-- Expired card (no requestId, not answered, not actively waiting) -->
      <div v-else-if="isExpired" class="ask-card ask-expired" :class="{ 'ask-compact': compact }">
        <div class="ask-icon-row">
          <span class="ask-icon">❓</span>
          <span class="ask-label">{{ $t('message.askInput') }}</span>
        </div>
        <div v-for="(q, qIdx) in questions" :key="qIdx" class="ask-question">
          <div class="ask-q-text">
            <span class="ask-q-chip" v-if="q.header">{{ q.header }}</span>
            {{ q.question }}
          </div>
          <div class="ask-options">
            <button v-for="opt in q.options" :key="opt.label" class="ask-opt" disabled>
              <span class="ask-opt-radio"></span>
              <span class="ask-opt-body">
                <span class="ask-opt-label">{{ opt.label }}</span>
                <span class="ask-opt-desc" v-if="opt.description">{{ opt.description }}</span>
              </span>
            </button>
          </div>
        </div>
        <div class="ask-expired-hint">
          <span>{{ $t('message.askExpired') }}</span>
        </div>
      </div>

      <!-- Full interactive card -->
      <div v-else class="ask-card" :class="{ 'ask-waiting': !askMsg.askRequestId, 'ask-compact': compact }">
        <div class="ask-icon-row">
          <span class="ask-icon">❓</span>
          <span class="ask-label">{{ $t('message.askInput') }}</span>
        </div>
        <div v-for="(q, qIdx) in questions" :key="qIdx" class="ask-question">
          <div class="ask-q-text">
            <span class="ask-q-chip" v-if="q.header">{{ q.header }}</span>
            {{ q.question }}
          </div>
          <div class="ask-options">
            <button
              v-for="opt in q.options"
              :key="opt.label"
              class="ask-opt"
              :class="{ selected: isOptionSelected(q.question, opt.label) }"
              :disabled="!askMsg.askRequestId"
              @click="selectOption(q, opt)"
            >
              <span class="ask-opt-radio" :class="{ checked: isOptionSelected(q.question, opt.label) }"></span>
              <span class="ask-opt-body">
                <span class="ask-opt-label">{{ opt.label }}</span>
                <span class="ask-opt-desc" v-if="opt.description">{{ opt.description }}</span>
              </span>
            </button>
          </div>
          <div class="ask-custom" v-if="askMsg.askRequestId">
            <input
              type="text"
              :placeholder="$t('message.askCustomPlaceholder')"
              :value="customAnswers[q.question] || ''"
              @input="setCustomAnswer(q.question, $event.target.value)"
              @keyup.enter="submitAnswers"
            />
          </div>
        </div>
        <div class="ask-actions" v-if="askMsg.askRequestId">
          <button class="ask-submit" @click="submitAnswers" :disabled="!hasAnySelection">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            {{ $t('message.askSubmit') }}
          </button>
        </div>
        <div class="ask-waiting-hint" v-if="!askMsg.askRequestId">
          <span class="ask-waiting-spinner"></span>
          {{ $t('message.askWaiting') }}
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const selectedOptions = Vue.reactive({});
    const customAnswers = Vue.reactive({});
    const localAnswered = Vue.ref(false);
    const localAnswers = Vue.ref(null);

    const isAnswered = Vue.computed(() => {
      if (localAnswered.value) return true;
      const ask = props.askMsg;
      return ask && (!!ask.askAnswered || !!ask.selectedAnswers);
    });

    const isExpired = Vue.computed(() => {
      const ask = props.askMsg;
      if (!ask) return false;
      // Expired: no requestId, not answered, and has been loaded from history (isHistory flag)
      // or simply no requestId and not waiting (page already loaded)
      return !ask.askRequestId && !ask.askAnswered && !ask.selectedAnswers && !!ask.isHistory;
    });

    const questions = Vue.computed(() => {
      const ask = props.askMsg;
      return ask?.askQuestions || ask?.toolInput?.questions || [];
    });

    const isOptionSelected = (questionText, label) => {
      const sel = selectedOptions[questionText];
      if (Array.isArray(sel)) return sel.includes(label);
      return sel === label;
    };

    const selectOption = (q, opt) => {
      if (isAnswered.value) return;
      customAnswers[q.question] = '';
      if (q.multiSelect) {
        const arr = selectedOptions[q.question] || [];
        const newArr = Array.isArray(arr) ? [...arr] : [];
        const idx = newArr.indexOf(opt.label);
        if (idx >= 0) newArr.splice(idx, 1);
        else newArr.push(opt.label);
        selectedOptions[q.question] = newArr;
      } else {
        selectedOptions[q.question] = opt.label;
      }
    };

    const setCustomAnswer = (questionText, value) => {
      customAnswers[questionText] = value;
      if (value) delete selectedOptions[questionText];
    };

    const hasAnySelection = Vue.computed(() => {
      const qs = questions.value;
      if (!qs || qs.length === 0) return false;
      return qs.some(q => {
        const sel = selectedOptions[q.question];
        const custom = customAnswers[q.question];
        if (custom) return true;
        if (Array.isArray(sel)) return sel.length > 0;
        return !!sel;
      });
    });

    const submitAnswers = () => {
      if (isAnswered.value || !hasAnySelection.value) return;
      const qs = questions.value;
      const answers = {};
      for (const q of qs) {
        const custom = customAnswers[q.question];
        if (custom) {
          answers[q.question] = custom;
        } else {
          const sel = selectedOptions[q.question];
          if (Array.isArray(sel) && sel.length > 0) {
            answers[q.question] = sel.join(', ');
          } else if (sel) {
            answers[q.question] = sel;
          }
        }
      }
      const requestId = props.askMsg.askRequestId;
      if (!requestId) return;
      emit('submit', requestId, answers);
      localAnswered.value = true;
      localAnswers.value = answers;
    };

    const summaryText = Vue.computed(() => {
      const answers = localAnswers.value || props.askMsg?.selectedAnswers;
      if (!answers) return '';
      const values = Object.values(answers).filter(v => v && v !== '-');
      return values.join(', ');
    });

    return {
      isAnswered,
      isExpired,
      questions,
      isOptionSelected,
      selectOption,
      setCustomAnswer,
      customAnswers,
      hasAnySelection,
      submitAnswers,
      summaryText
    };
  }
};
