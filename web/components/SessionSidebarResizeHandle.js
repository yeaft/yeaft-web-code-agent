import PaneResizeHandle from './PaneResizeHandle.js';
import { SESSION_SIDEBAR_WIDTH } from '../stores/helpers/session-sidebar-width.js';

/**
 * Width divider placed right after a desktop sidebar. Every host (Chat, Yeaft,
 * Work Center) binds the same store width, so resizing one sidebar resizes
 * them all. Hosts render it only while the sidebar is expanded and inline.
 */
export default {
  name: 'SessionSidebarResizeHandle',
  components: { PaneResizeHandle },
  props: {
    controls: { type: String, required: true },
  },
  data() { return { limits: SESSION_SIDEBAR_WIDTH }; },
  computed: {
    store() { return Pinia.useChatStore(); },
  },
  template: `
    <PaneResizeHandle class="session-sidebar-resize-handle" pane="previous"
                      :model-value="store.sessionSidebarWidth"
                      @update:model-value="store.setSessionSidebarWidth"
                      :label="$t('sidebar.widthResize.label')" :controls="controls"
                      :min-size="limits.min" :max-limit="limits.max" :min-remaining="480"
                      :default-size="limits.default" />
  `,
};
