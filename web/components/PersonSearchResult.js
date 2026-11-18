import ResponsePresentation from './ResponsePresentation.js';
import { personSearchSnippet } from '../utils/person-search-snippet.js';

export default {
  name: 'PersonSearchResult',
  components: { ResponsePresentation },
  props: { message: { type: Object, required: true }, query: String, personName: String, openLink: Function },
  data: () => ({ expanded: false }),
  computed: {
    snippet() { return personSearchSnippet(this.message.text || '', this.query || ''); },
  },
  methods: {
    time(value) { return value ? new Date(value).toLocaleString() : ''; },
  },
  template: `
    <article class="person-search-result">
      <header class="person-message-meta"><strong>{{ message.role === 'user' ? $t('person.you') : (personName || $t('person.title')) }}</strong><span v-if="message.role === 'assistant' && message.replyKind === 'progress'" class="person-reply-kind">{{ $t('person.progressReply') }}</span><time>{{ time(message.createdAt) }}</time></header>
      <p class="person-search-snippet"><span v-if="snippet.leading">…</span><template v-for="(part, index) in snippet.parts" :key="index"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template><span v-if="snippet.trailing">…</span></p>
      <button type="button" class="btn-ghost person-search-details" :aria-expanded="expanded" @click="expanded = !expanded">{{ $t(expanded ? 'person.hideFullMessage' : 'person.viewFullMessage') }}</button>
      <template v-if="expanded">
        <ResponsePresentation v-if="message.presentation" :presentation="message.presentation" :open-link="openLink" />
        <p v-else class="person-prose">{{ message.text }}</p>
      </template>
    </article>
  `,
};
