import UserTurnBlock from './UserTurnBlock.js';
import ResponsePresentation from './ResponsePresentation.js';
import PersonResponseLoading from './PersonResponseLoading.js';
import { renderSafeMessageMarkdown } from '../utils/safe-message-markdown.js';

// One rendering/security boundary for ordinary history and concurrent episodes.
export default {
  name: 'PersonConversationBlock',
  components: { UserTurnBlock, ResponsePresentation, PersonResponseLoading },
  props: { message: Object, personName: String, outputs: { type: Array, default: () => [] },
    disabled: Boolean, loading: Boolean, feedback: Object, openReplyBrowser: Function, previewReplyLink: Function },
  emits: ['output'],
  setup() {
    const asUserMessage = message => ({ id: message.messageId || message.id, type: 'user', content: message.text, createdAt: new Date(message.createdAt).getTime() });
    const time = value => value ? new Date(value).toLocaleString() : '';
    const datetime = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined;
    return { asUserMessage, time, datetime, renderSafeMessageMarkdown };
  },
  template: `
  <div v-if="message.role === 'user'">
    <UserTurnBlock :message="asUserMessage(message)" :session-actions="false" />
    <ul v-if="message.attachments?.length" class="person-sent-files" :aria-label="$t('person.attachedFiles')"><li v-for="(file, index) in message.attachments" :key="file.id || index">{{ file.name }}</li></ul>
    <p v-if="['queued', 'received', 'stopped'].includes(message.deliveryState)" class="person-delivery" :data-delivery-state="message.deliveryState">{{ $t('person.delivery.' + message.deliveryState) }}</p>
  </div>
  <article v-else-if="message.role === 'assistant'" class="person-message person-reply" :data-message-id="message.messageId" :data-episode-id="message.episodeId" :data-response-key="message.key">
    <div v-if="message.replyContext" class="person-reply-context">
      <span>{{ $t('person.replyContext', { count: message.replyContext.count }) }}</span>
      <blockquote v-for="excerpt in message.replyContext.excerpts" :key="excerpt.id">{{ excerpt.text }}</blockquote>
    </div>
    <header class="person-message-meta"><strong>{{ personName || $t('person.title') }}</strong></header>
    <section v-for="(part, index) in message.parts" :key="part.id" class="person-reply-part" :data-message-id="part.id">
      <div class="person-reply-part-meta" :class="{ 'person-reply-divider': index > 0 }">
        <span v-if="['progress', 'final', 'execution-final'].includes(part.replyKind)" class="person-reply-kind">{{ $t(part.replyKind === 'progress' ? 'person.progressReply' : 'person.finalReply') }}</span>
        <time :datetime="datetime(part.createdAt)">{{ time(part.createdAt) }}</time>
      </div>
      <ResponsePresentation v-if="part.presentation" :presentation="part.presentation" :open-link="openReplyBrowser" />
      <div v-else class="person-message-text markdown-body" @click="previewReplyLink" v-html="renderSafeMessageMarkdown(part.text)"></div>
    </section>
    <div v-if="outputs.length" class="person-delivered-outputs" :aria-label="$t('person.outputs')"><button v-for="output in outputs" :key="output.id" type="button" class="btn-secondary person-delivered-output" :disabled="disabled" @click="$emit('output', output)">{{ output.title }} · {{ $t('person.outputsPreview') }}</button></div>
    <PersonResponseLoading v-if="loading" :feedback="feedback" />
  </article>
  <article v-else class="person-message" :data-message-id="message.messageId">
    <header class="person-message-meta"><strong>{{ $t('person.system') }}</strong><time>{{ time(message.createdAt) }}</time></header>
    <div class="person-message-text markdown-body" v-html="renderSafeMessageMarkdown(message.text)"></div>
  </article>
  `,
};
