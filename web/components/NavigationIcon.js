/** Shared Session / Work Center navigation glyphs. Buttons own labels and state. */
export default {
  name: 'NavigationIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 16 },
  },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path v-if="name === 'back'" fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
      <path v-else-if="name === 'menu'" fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
      <path v-else-if="name === 'collapse'" fill="currentColor" d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/>
      <path v-else-if="name === 'workbench'" fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/>
      <g v-else fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <template v-if="name === 'activity'"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 14h5"/></template>
        <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></template>
        <template v-else-if="name === 'refresh'"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></template>
        <path v-else-if="name === 'add'" d="M12 5v14M5 12h14"/>
        <path v-else-if="name === 'close'" d="m6 6 12 12M18 6 6 18"/>
        <path v-else-if="name === 'chevron'" d="m9 5 7 7-7 7"/>
      </g>
    </svg>
  `,
};
