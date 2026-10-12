import { normalizeBrowserAddress } from '../utils/browser-address.js';
import { projectPresentation, chartGeometry, diagramGeometry, mapGeometry, mapEmbedUrl, responseMarkdown } from '../utils/response-presentation.js';
import ResponseImage from './ResponseImage.js';
import ResponseMapEmbed from './ResponseMapEmbed.js';

// Tags/attributes come exclusively from our token adapter, never from model-provided HTML.
const ResponseMarkdownNode = {
  name: 'ResponseMarkdownNode',
  props: ['node'],
  template: `<component :is="node.tag" :class="node.className" :href="node.href || undefined"
    :target="node.href ? '_blank' : undefined" :rel="node.href ? 'noopener noreferrer' : undefined"
    :referrerpolicy="node.href ? 'no-referrer' : undefined" :scope="node.tag === 'th' ? 'col' : undefined"
    :tabindex="node.className === 'response-table-scroll' ? 0 : undefined">
    <template v-if="node.children"><ResponseMarkdownNode v-for="(child, i) in node.children" :key="i" :node="child" /></template>
    <template v-else>{{ node.text }}</template>
  </component><a v-if="node.href" class="response-external" data-response-external :href="node.href"
    target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
    :aria-label="$t('richResponse.newTab') + ': ' + node.href" :title="$t('richResponse.newTab')">↗</a>`,
};


/** Shared display-only v1 renderer. `presentation` is canonical JSON; no store or network ownership.
 * Summary stays selectable and copyable even when the version/blocks are unsupported.
 * Images load on mount without a referrer. The host owns in-app browser navigation.
 */
export default {
  name: 'ResponsePresentation',
  components: { ResponseMarkdownNode, ResponseImage, ResponseMapEmbed },
  props: { presentation: { type: Object, default: null }, fallbackText: { type: String, default: '' },
    openLink: { type: Function, default: null } },
  inject: { browserOpener: { from: 'workbench-browser-opener', default: null } },
  data: () => ({ copyState: '', linkState: '' }),
  computed: {
    view() {
      const projected = projectPresentation(this.presentation, this.fallbackText);
      return { ...projected, blocks: projected.blocks.map(b => ({ ...b,
        geometry: b.type === 'chart' ? chartGeometry(b) : b.type === 'diagram' ? diagramGeometry(b) : b.type === 'map' ? mapGeometry(b) : null,
        markdown: b.type === 'markdown' ? responseMarkdown(b.text) : null,
      })) };
    },
  },
  watch: { presentation() { this.copyState = ''; this.linkState = ''; } },
  methods: {
    openBrowserLink(event) {
      if (event.defaultPrevented || (event.button != null && event.button !== 0)
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || !event.currentTarget?.contains?.(anchor)
        || anchor.hasAttribute('data-response-external') || anchor.hasAttribute('download')) return;
      // All rendered anchors have already passed the HTTP(S) projection. Consume
      // normal clicks even when the owning browser rejects a control-plane URL.
      // New tabs require the external action or a native modifier/middle click.
      event.preventDefault();
      event.stopPropagation();
      const url = normalizeBrowserAddress(anchor.getAttribute('href'));
      const accepted = !!url && (this.openLink || this.browserOpener)?.(url) === true;
      this.linkState = accepted ? '' : 'richResponse.browserUnavailable';
    },
    async copySummary() {
      const current = this.presentation;
      try {
        await navigator.clipboard.writeText(this.view.summary);
        if (this.presentation === current) this.copyState = 'richResponse.copied';
      } catch {
        if (this.presentation !== current) return;
        const selection = globalThis.getSelection?.();
        if (selection && this.$refs.summary) {
          const range = document.createRange(); range.selectNodeContents(this.$refs.summary);
          selection.removeAllRanges(); selection.addRange(range);
        }
        this.copyState = 'richResponse.copyFallback';
      }
    },
    mapEmbedUrl,
    number(value) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value); },
    coordinates(point) { return `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`; },
  },
  template: `<article @click="openBrowserLink" class="response-presentation" :aria-label="view.title || $t('richResponse.response')">
    <header class="response-header">
      <span class="response-phase" :class="{ 'is-progress': view.phase === 'progress' }">{{ $t(view.phase === 'progress' ? 'richResponse.progress' : 'richResponse.response') }}</span>
      <button type="button" class="btn-ghost response-copy" :disabled="!view.summary" @click="copySummary">{{ $t('richResponse.copySummary') }}</button>
    </header>
    <h2 v-if="view.title" class="response-title">{{ view.title }}</h2>
    <p ref="summary" class="response-summary">{{ view.summary || $t('richResponse.empty') }}</p>
    <p v-if="copyState" class="response-status" role="status">{{ $t(copyState) }}</p>
    <p v-if="linkState" class="response-status" role="status">{{ $t(linkState) }}</p>
    <p v-if="view.invalid" class="response-notice">{{ $t('richResponse.invalid') }}</p>
    <section v-for="(block, index) in view.blocks" :key="index + ':' + block.type" class="response-block" :class="'response-block-' + block.type"
      :aria-label="block.title || $t('richResponse.' + block.type)">
      <h3 v-if="block.title" class="response-block-title">{{ block.title }}</h3>
      <div v-if="block.type === 'markdown'" class="response-markdown">
        <ResponseMarkdownNode v-for="(node, i) in block.markdown" :key="i" :node="node" />
      </div>
      <ul v-else-if="block.type === 'cards'" class="response-cards">
        <li v-for="(item, i) in block.items" :key="i">
          <ResponseImage v-if="item.image" :block="item.image" card />
          <span v-if="item.label" class="response-eyebrow">{{ item.label }}</span><h4>{{ item.title }}</h4><p>{{ item.text }}</p>
          <div v-if="item.url" class="response-card-source"><a :href="item.url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{{ $t('richResponse.viewSource') }}</a><a class="response-external" data-response-external :href="item.url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-label="$t('richResponse.newTab') + ': ' + item.title" :title="$t('richResponse.newTab')">↗</a></div>
        </li>
      </ul>
      <dl v-else-if="block.type === 'metrics'" class="response-metrics">
        <div v-for="(item, i) in block.items" :key="i"><dt>{{ item.label }}</dt><dd class="response-metric-value">{{ item.value }}</dd><dd v-if="item.detail" class="response-metric-detail">{{ item.detail }}</dd></div>
      </dl>
      <div v-else-if="block.type === 'table'" class="response-table-scroll" tabindex="0" role="region" :aria-label="block.title || $t('richResponse.table')">
        <table><caption class="response-sr-only">{{ block.title || $t('richResponse.table') }}</caption><thead><tr><th v-for="(col, i) in block.columns" :key="i" scope="col">{{ col }}</th></tr></thead>
          <tbody><tr v-for="(row, ri) in block.rows" :key="ri"><td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td></tr></tbody></table>
      </div>
      <figure v-else-if="block.type === 'chart'" class="response-chart">
        <figcaption class="response-chart-legend"><span v-for="(series, si) in block.series" :key="si" :class="'response-series-' + si"><i aria-hidden="true"></i>{{ series.label }}</span><span v-if="block.unit" class="response-unit">{{ block.unit }}</span></figcaption>
        <svg viewBox="0 0 600 250" role="img" :aria-label="block.title || $t('richResponse.chart')">
          <g v-for="(tick, ti) in block.geometry.ticks" :key="ti" class="response-axis"><line x1="64" x2="560" :y1="tick.y" :y2="tick.y" /><text x="54" :y="tick.y + 4" text-anchor="end">{{ number(tick.value) }}</text></g>
          <line class="response-zero" x1="64" x2="560" :y1="block.geometry.zero" :y2="block.geometry.zero" />
          <g v-for="(series, si) in block.geometry.series" :key="si" :class="'response-series-' + si">
            <template v-if="block.style === 'bar'"><rect v-for="(point, pi) in series.points" :key="pi" :x="point.barX" :y="point.barY" :width="point.width" :height="point.height" rx="2"><title>{{ block.labels[pi] }} · {{ series.label }}: {{ point.value }} {{ block.unit }}</title></rect></template>
            <template v-else><polyline :points="series.path" class="response-chart-line" :stroke-dasharray="si ? (si * 3 + 2) + ' 3' : undefined" /><circle v-for="(point, pi) in series.points" :key="pi" :cx="point.x" :cy="point.y" r="3"><title>{{ block.labels[pi] }} · {{ series.label }}: {{ point.value }} {{ block.unit }}</title></circle></template>
          </g>
          <g class="response-axis"><template v-for="(label, li) in block.geometry.labels" :key="li"><text v-if="label.show" :x="label.x" y="232" text-anchor="middle">{{ label.label.length > 12 ? label.label.slice(0, 11) + '…' : label.label }}</text></template></g>
        </svg>
        <details class="response-data"><summary>{{ $t('richResponse.viewData') }}</summary><div class="response-table-scroll" tabindex="0" role="region" :aria-label="$t('richResponse.chartData')">
          <table><caption>{{ $t('richResponse.chartData') }}<template v-if="block.unit"> · {{ block.unit }}</template></caption><thead><tr><th scope="col">{{ $t('richResponse.label') }}</th><th v-for="(s, si) in block.series" :key="si" scope="col">{{ s.label }}</th></tr></thead>
          <tbody><tr v-for="(label, li) in block.labels" :key="li"><th scope="row">{{ label }}</th><td v-for="(s, si) in block.series" :key="si">{{ s.values[li] }}</td></tr></tbody></table>
        </div></details>
      </figure>
      <ol v-else-if="block.type === 'timeline'" class="response-timeline"><li v-for="(item, i) in block.items" :key="i"><span class="response-eyebrow">{{ item.label }}</span><h4>{{ item.title }}</h4><p>{{ item.text }}</p></li></ol>
      <figure v-else-if="block.type === 'diagram'" class="response-diagram">
        <div class="response-diagram-scroll" tabindex="0" role="region" :aria-label="block.title || $t('richResponse.diagram')"><svg :viewBox="'0 0 600 ' + block.geometry.height" role="img" :aria-label="block.title || $t('richResponse.diagram')">
          <g v-for="(edge, ei) in block.geometry.edges" :key="ei" class="response-edge"><path v-if="edge.loop" :d="edge.loop" /><line v-else :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2" /><polygon :points="edge.arrow" /><title>{{ edge.from }} → {{ edge.to }} {{ edge.label }}</title></g>
          <g v-for="(node, ni) in block.geometry.nodes" :key="ni" class="response-node"><rect :x="node.x - 82" :y="node.y - 24" width="164" height="48" rx="10" /><text :x="node.x" :y="node.y + 4" text-anchor="middle">{{ node.label.length > 20 ? node.label.slice(0, 19) + '…' : node.label }}</text><title>{{ node.label }}</title></g>
        </svg></div>
        <details class="response-data"><summary>{{ $t('richResponse.relationships') }}</summary>
          <ul class="response-node-list"><li v-for="node in block.nodes" :key="node.id"><strong>{{ node.label }}</strong><span class="response-node-id">{{ node.id }}</span></li></ul>
          <ul class="response-edge-list"><li v-for="(edge, ei) in block.edges" :key="ei">{{ block.nodes.find(n => n.id === edge.from).label }} → {{ block.nodes.find(n => n.id === edge.to).label }}<template v-if="edge.label"> · {{ edge.label }}</template></li></ul>
        </details>
      </figure>
      <ResponseImage v-else-if="block.type === 'image'" :block="block" />
      <div v-else-if="block.type === 'link'" class="response-link-row">
        <a class="response-link" :href="block.url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
          :title="$t('richResponse.openBrowser')"><strong>{{ block.text }}</strong><span>{{ block.url }}</span></a>
        <a class="btn-ghost response-external" data-response-external :href="block.url" target="_blank"
          rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-label="$t('richResponse.newTab') + ': ' + block.text"
          :title="$t('richResponse.newTab')">↗</a>
      </div>
      <figure v-else-if="block.type === 'map'" class="response-map">
        <ResponseMapEmbed v-if="mapEmbedUrl(block)" :block="block" />
        <template v-else>
        <figcaption><strong>{{ $t('richResponse.coordinateSketch') }}</strong><span>{{ $t('richResponse.mapNotice') }}</span></figcaption>
        <svg viewBox="0 0 600 290" role="img" :aria-label="$t('richResponse.coordinateSketch')">
          <g class="response-map-grid"><line v-for="x in [60, 180, 300, 420, 540]" :key="'x' + x" :x1="x" :x2="x" y1="44" y2="236" /><line v-for="y in [44, 92, 140, 188, 236]" :key="'y' + y" x1="60" x2="540" :y1="y" :y2="y" /></g>
          <g class="response-axis"><text x="60" y="260">{{ number(block.geometry.west) }}°</text><text x="540" y="260" text-anchor="end">{{ number(block.geometry.east) }}°</text><text x="52" y="48" text-anchor="end">{{ number(block.geometry.north) }}°</text><text x="52" y="236" text-anchor="end">{{ number(block.geometry.south) }}°</text><text x="300" y="280" text-anchor="middle">{{ $t('richResponse.longitude') }} →</text><text x="60" y="22">{{ $t('richResponse.latitude') }} ↑</text></g>
          <g v-for="point in block.geometry.points" :key="point.number" class="response-map-point"><circle :cx="point.x" :cy="point.y" r="12" /><text :x="point.x" :y="point.y + 4" text-anchor="middle">{{ point.number }}</text><title>{{ point.label }} · {{ coordinates(point) }}</title></g>
        </svg>
        <ol class="response-map-list"><li v-for="(point, pi) in block.points" :key="pi"><div><strong>{{ point.label }}</strong><span>{{ coordinates(point) }}</span></div><p v-if="point.detail">{{ point.detail }}</p></li></ol>
        </template>
      </figure>
      <p v-else class="response-notice">{{ $t('richResponse.unsupported') }}</p>
    </section>
  </article>`,
};
