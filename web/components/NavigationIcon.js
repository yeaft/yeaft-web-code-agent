/**
 * Shared Session / Work Center navigation glyphs. Buttons own labels and state.
 * Every glyph is drawn on the same 24px grid with a 1.8 round stroke so chrome
 * icons match the sidebar's primary actions; no filled variants.
 */
export default {
  name: 'NavigationIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 16 },
  },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <template v-if="name === 'back'"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></template>
        <path v-else-if="name === 'menu'" d="M4 6h16M4 12h16M4 18h16"/>
        <template v-else-if="name === 'collapse'"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d="m16 9-3 3 3 3"/></template>
        <template v-else-if="name === 'workbench'"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></template>
        <template v-else-if="name === 'settings'"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></template>
        <template v-else-if="name === 'eye'"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></template>
        <template v-else-if="name === 'activity'"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 14h5"/></template>
        <template v-else-if="name === 'file'"><path d="M14 2H5v20h14V7Z"/><path d="M14 2v5h5M8 12h8M8 16h6"/></template>
        <template v-else-if="name === 'globe'"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></template>
        <template v-else-if="name === 'external'"><path d="M14 3h7v7M21 3l-9 9M10 3H3v18h18v-7"/></template>
        <template v-else-if="name === 'download'"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></template>
        <template v-else-if="name === 'expand'"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></template>
        <template v-else-if="name === 'restore'"><path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/></template>
        <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></template>
        <template v-else-if="name === 'refresh'"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></template>
        <template v-else-if="name === 'more'"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></template>
        <path v-else-if="name === 'add'" d="M12 5v14M5 12h14"/>
        <path v-else-if="name === 'close'" d="m6 6 12 12M18 6 6 18"/>
        <path v-else-if="name === 'chevron'" d="m9 5 7 7-7 7"/>
      </g>
    </svg>
  `,
};
