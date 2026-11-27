/* Adapted source mappings from https://github.com/newsnext/newsnow
MIT License

Copyright (c) 2024 ourongxing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { createHash } from 'node:crypto';
import { BUILTIN_SOURCES } from './catalog.js';
import { safeFetch } from './safe-fetch.js';
import { cleanText, parseAttributes, parseFeedXml, parseTimestamp, resolveHttpUrl } from './rss-parser.js';
import { canonicalizeUrl } from './clusterer.js';

const record = (title, url, publishedAt, summaryExcerpt, hasHotMetric) => ({ title, url, publishedAt, summaryExcerpt, hasHotMetric });
const segment = value => encodeURIComponent(value ?? '');
const browser = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' };
const localTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value.trim())
  ? `${value.trim().replace(' ', 'T')}+08:00` : value;

function relativeTime(value, now) {
  const text = cleanText(value);
  if (/^(刚刚|刚才)$/.test(text)) return now;
  const relative = /^(\d+)\s*(秒钟?|分钟?|小时|天)前$/.exec(text);
  if (relative) return now - Number(relative[1]) * ({ 秒: 1000, 分: 60_000, 小: 3_600_000, 天: 86_400_000 })[relative[2][0]];
  const clock = /^(?:(今天|昨天|前天)\s*)?(\d\d?:\d\d(?::\d\d)?)$/.exec(text);
  if (clock) {
    const day = new Date(now + 8 * 3_600_000 - (({ 昨天: 1, 前天: 2 })[clock[1]] ?? 0) * 86_400_000);
    const date = parseTimestamp(`${day.toISOString().slice(0, 10)}T${clock[2].padStart(clock[2].length === 4 || clock[2].length === 7 ? clock[2].length + 1 : clock[2].length, '0')}+08:00`);
    return !clock[1] && date > now ? date - 86_400_000 : date;
  }
  return parseTimestamp(localTime(text));
}

async function combine(parts, load) {
  const results = await Promise.allSettled(parts.map(load));
  if (results.every(r => r.status === 'rejected')) throw results[0].reason;
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}
function anchors(html) {
  return Array.from(html.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi),
    ([, attrs, title]) => ({ ...parseAttributes(attrs), title: cleanText(title) }));
}
function tagged(html, tag) { return Array.from(html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')), m => m[1]); }

export function clsTelegraphUrl(base, now = Date.now()) {
  const url = new URL(base);
  const params = new URLSearchParams({ appName: 'CailianpressWeb', os: 'web', sv: '7.7.5', last_time: Math.floor(now / 1000), refresh_type: 1, rn: 30 });
  params.sort();
  const hash = createHash('sha1').update(params.toString()).digest('hex');
  params.set('sign', createHash('md5').update(hash).digest('hex'));
  url.search = params;
  return url.href;
}

const wallstreet = k => record(k.title || k.content_short || k.content_text, k.uri, k.display_time, k.content_short || k.content_text);
const adapters = {
  '36kr-quick': async ({ url, text, now }) => {
    const html = await text(url);
    return html.split(/<(?:div|li)\b[^>]*class=["'][^"']*\bnewsflash-item\b[^"']*["'][^>]*>/gi).slice(1).map(part => {
      const a = anchors(part).find(k => k.class?.split(/\s+/).includes('item-title'));
      const time = part.match(/class=["'][^"']*\btime\b[^"']*["'][^>]*>([^<]*)/i)?.[1];
      return a && record(a.title, a.href, relativeTime(time, now));
    });
  },
  github: async ({ url, text }) => tagged(await text(url), 'article').map(part => {
    const a = anchors(tagged(part, 'h2')[0] ?? '')[0];
    return a && /^\/[\w.-]+\/[\w.-]+\/?$/.test(a.href) &&
      record(a.title.replace(/\s*\/\s*/g, '/'), a.href, null, tagged(part, 'p')[0], true);
  }),
  juejin: async ({ url, json }) => (await json(url)).data.map(({ content: k }) =>
    k && record(k.title, `https://juejin.cn/post/${segment(k.content_id)}`, k.ctime, k.brief_content, true)),
  v2ex: ({ url, json }) => combine(['create', 'ideas', 'programmer', 'share'], async channel =>
    (await json(`${url}${channel}.json`)).items.map(k => record(k.title, k.url, k.date_published ?? k.date_modified, k.content_html))),
  linuxdo: async ({ url, json }) => (await json(url)).topic_list.topics.filter(k => k.visible !== false && !k.archived && !k.pinned)
    .map(k => record(k.title, `https://linux.do/t/topic/${segment(k.id)}`, k.created_at, k.excerpt)),
  'cls-telegraph': async ({ url, json, now }) => (await json(clsTelegraphUrl(url, now), { referer: 'https://www.cls.cn/telegraph' }))
    .data.roll_data.filter(k => !k.is_ad).map(k => record(k.title || k.brief, `https://www.cls.cn/detail/${segment(k.id)}`, k.ctime, k.brief)),
  'wallstreetcn-quick': async ({ url, json }) => (await json(url)).data.items.map(wallstreet),
  'wallstreetcn-news': async ({ url, json }) => (await json(url)).data.items
    .filter(k => !['theme', 'ad'].includes(k.resource_type) && k.resource?.type !== 'live' && k.resource?.uri)
    .map(k => wallstreet(k.resource)),
  jin10: async ({ url, text, now }) => JSON.parse((await text(`${url}?t=${now}`)).trim().replace(/^var\s+newest\s*=\s*/, '').replace(/;+$/, ''))
    .filter(k => (k.data?.title || k.data?.content) && !k.channel?.includes(5)).map(k => {
      const raw = cleanText(k.data.title || k.data.content);
      const match = /^【([^】]+)】\s*(.*)$/.exec(raw);
      return record(match?.[1] ?? raw, `https://flash.jin10.com/detail/${segment(k.id)}`, localTime(k.time), match?.[2], !!k.important);
    }),
  xueqiu: async ({ url, json, load }) => {
    const response = await load('https://xueqiu.com/hq', browser);
    // Cookies scoped to Xueqiu endpoints; never reuse remotely issued Set-Cookie attributes as outbound headers.
    const sameOrigin = !response.url || new URL(response.url).origin === 'https://xueqiu.com';
    const responseCookies = sameOrigin ? response.headers?.['set-cookie'] ?? [] : [];
    const cookie = (Array.isArray(responseCookies) ? responseCookies : [responseCookies]).map(s => s.split(';')[0])
      .filter(s => /^(?:xq_a_token|xq_r_token|xq_id_token)=/.test(s)).join('; ');
    return (await json(url, cookie ? { ...browser, cookie } : browser)).data.items.filter(k => !k.ad)
      .map(k => record(k.name, `https://xueqiu.com/s/${segment(k.code)}`, null, `${k.exchange ?? ''} ${k.percent ?? ''}%`, true));
  },
  ithome: async ({ url, text, now }) => tagged(await text(url), 'li').map(part => {
    const a = anchors(part).find(k => k.class?.split(/\s+/).includes('t'));
    if (a && !/lapin/.test(a.href) && !/神券|优惠|补贴|京东/.test(a.title)) return record(a.title, a.href, relativeTime(tagged(part, 'i')[0], now));
  }),
  sspai: async ({ url, json, now }) => (await json(`${url}&created_at=${now}`)).data
    .map(k => record(k.title, `https://sspai.com/post/${segment(k.id)}`, k.released_time ?? k.created_at, k.summary, true)),
  thepaper: async ({ url, json }) => (await json(url)).data.hotNews
    .map(k => record(k.name, `https://www.thepaper.cn/newsDetail_forward_${segment(k.contId)}`, k.pubTimeLong, null, true)),
  cankaoxiaoxi: ({ url, json }) => combine(['zhongguo', 'guandian', 'gj'], async channel =>
    (await json(`${url}${channel}/list.json`)).list.map(({ data: k }) => k && record(k.title, k.url, localTime(k.publishTime)))),
  toutiao: async ({ url, json }) => (await json(url, browser)).data.map(k =>
    record(k.Title, `https://www.toutiao.com/trending/${segment(k.ClusterIdStr)}/`, null, null, true)),
  zhihu: async ({ url, json }) => (await json(url, browser)).data.map(({ target: k }) =>
    k && record(k.title_area?.text, k.link?.url, null, k.excerpt_area?.text, true)),
  weibo: async ({ url, text }) => tagged(await text(url, { ...browser, referer: url }), 'tr').map(row => {
    const a = anchors(row).find(k => /^\/weibo\?/.test(k.href));
    return a && record(a.title, a.href, null, null, true);
  }),
  baidu: async ({ url, text }) => JSON.parse((await text(url, browser)).match(/<!--s-data:([\s\S]*?)-->/)?.[1] ?? '').data.cards
    .flatMap(k => k.content ?? []).filter(k => !k.isTop).map(k => record(k.word, k.rawUrl, null, k.desc, true)),
  bilibili: async ({ url, json }) => (await json(url)).data.list.map(k =>
    record(k.title, `https://www.bilibili.com/video/${segment(k.bvid)}`, k.pubdate, k.desc, true)),
};

/** Failures reject only this source; caller maintains its last good snapshot. */
export async function fetchSource(sourceOrId, { fetcher = safeFetch, dnsLookup, signal, now = Date.now() } = {}) {
  const source = typeof sourceOrId === 'string' ? BUILTIN_SOURCES.find(s => s.id === sourceOrId) : sourceOrId;
  if (!source) throw new Error('Unknown Cosmic Web source');
  const { url } = source;
  const load = async (address, headers) => {
    const res = await fetcher(address, { headers, dnsLookup, signal });
    if (res.status < 200 || res.status >= 300) throw new Error(`Source returned HTTP ${res.status}`);
    return res;
  };
  let base = url, rows;
  if (source.kind === 'rss') {
    const res = await load(url);
    base = res.url ?? url;
    const xml = await res.text();
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error('Expected RSS or Atom');
    rows = parseFeedXml(xml, base);
  } else {
    const adapter = Object.hasOwn(adapters, source.id) && adapters[source.id];
    if (!adapter) throw new Error('Unknown Cosmic Web adapter');
    rows = await adapter({ url, now, load, text: async (u, h) => (await load(u, h)).text(), json: async (u, h) => (await load(u, h)).json() });
  }
  const seen = new Set();
  return rows.flatMap(k => {
    if (!k) return [];
    const title = cleanText(k.title).slice(0, 500);
    const canonical = canonicalizeUrl(resolveHttpUrl(k.url, base));
    if (!title || !canonical || canonical.length > 4096 || seen.has(canonical)) return [];
    seen.add(canonical);
    return [record(title, canonical, Math.min((source.kind === 'rss' || ['36kr-quick', 'ithome'].includes(source.id) ? k.publishedAt : parseTimestamp(k.publishedAt)) ?? now, now), cleanText(k.summaryExcerpt).slice(0, 1000), !!k.hasHotMetric)];
  }).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 60);
}
