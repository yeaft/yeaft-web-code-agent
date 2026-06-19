import { tokenizeTerminalOutput } from '../utils/terminal-output.js';

export default {
  name: 'TerminalOutput',
  props: {
    content: { default: '' },
  },
  template: `
    <pre class="terminal-output"><code><template v-for="(token, index) in tokens" :key="index"><span v-if="token.className" :class="token.className">{{ token.text }}</span><template v-else>{{ token.text }}</template></template></code></pre>
  `,
  setup(props) {
    const tokens = Vue.computed(() => tokenizeTerminalOutput(props.content));
    return { tokens };
  },
};
