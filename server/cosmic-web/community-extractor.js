import { cleanText, extractMarkupMedia, normalizeMedia, resolveHttpUrl } from './rss-parser.js';
import { safeFetch, validateExternalUrl } from './safe-fetch.js';
import { toProxyMediaUrl } from './media-proxy.js';
import { parseNextData } from './sources.js';

const maxItems = 4;
const timeoutMs = 5000;
const browser = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' };
const array = value => Array.isArray(value) ? value : [];
const within = (host, root) => host === root || host.endsWith(`.${root}`);
const compact = text => typeof text === 'string' ? cleanText(text) : '';
function comment(platform, author, quote, likes, sourceUrl) {
  const name = compact(author).slice(0, 150), body = compact(quote).slice(0, 700);
  if (!name || !body || /^\[(?:deleted|removed)\]$/i.test(name) || /^\[(?:deleted|removed)\]$/i.test(body)) return null;
  const score = Number(likes);
  return { platform, author: name, quote: body, likes: Number.isSafeInteger(score) ? Math.max(0, score) : 0, sourceUrl };
}

function hupuDetails(html, url) {
  const data = parseNextData(html)?.props?.pageProps;
  const detail = data?.detail ?? data;
  const lights = array(detail?.lights ?? detail?.lightReplies ?? detail?.brightReplies);
  const visible = lights.slice(0, 12).filter(r => r && !r.isHidden && !r.isDelete && !r.isSelfDelete && !r.hidePost);
  const fragments = [detail?.thread?.content, ...visible.map(r => r.content)];
  const comments = visible.map(r => comment('Hupu', r.author?.puname ?? r.author?.name ?? r.username, r.content, r.allLightCount ?? r.count ?? r.likes, url));
  if (!comments.some(Boolean)) {
    // Read only the bright-replies section, never the OP or sidebar links.
    const marker = /这些回帖亮了|亮评/.exec(html);
    if (marker) {
      const section = html.slice(marker.index, marker.index + 160_000).split(/全部回帖|全部回复|所有回帖|最新回帖/)[0];
      for (const part of section.split(/class=["'][^"']*\b(?:post-reply-list-container|bright-reply|light-reply)\b[^"']*["']/i).slice(1, 13)) {
        const author = /class=["'][^"']*\b(?:post-reply-list-user-info-top-name|reply-author|username)\b[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(part)?.[1];
        const body = /class=["'][^"']*\b(?:thread-content-detail|reply-content)\b[^"']*["'][^>]*>([\s\S]*?)(?=<\/div\b|<div\b[^>]*class=["']seo-dom)/i.exec(part)?.[1];
        const likes = /亮了\s*\D{0,30}(\d+)/.exec(part)?.[1];
        const result = comment('Hupu', author, body, likes, url);
        if (result) { comments.push(result); fragments.push(body); }
      }
    }
  }
  return { comments, media: fragments.flatMap(value => extractMarkupMedia(value, url)) };
}

async function community(url, load, html) {
  const { hostname, pathname, searchParams } = new URL(url);
  let id;
  if (within(hostname, 'reddit.com') && /^\/r\/[\w]+\/comments\/[a-z0-9]+(?:\/|$)/i.test(pathname)) {
    const thread = pathname.match(/^\/r\/[\w]+\/comments\/[a-z0-9]+/i)[0];
    const data = await load(`https://www.reddit.com${thread}.json?limit=8&sort=top`, 'json');
    return { comments: array(data?.[1]?.data?.children).slice(0, 16).filter(r => r?.kind === 't1' && r.data && !r.data.stickied).map(({ data: r }) =>
      comment('Reddit', r.author, r.body, r.score, /^\/r\/[\w]+\/comments\/[\w/]+$/i.test(r.permalink) ? `https://www.reddit.com${r.permalink}` : url)) };
  }
  if (hostname === 'news.ycombinator.com' && pathname === '/item' && /^\d{1,20}$/.test(id = searchParams.get('id') ?? '')) {
    const data = await load(`https://hn.algolia.com/api/v1/items/${id}`, 'json');
    return { comments: array(data?.children).slice(0, 16).map(r => comment('Hacker News', r?.author, r?.text, r?.points,
      /^\d{1,20}$/.test(r?.id) ? `https://news.ycombinator.com/item?id=${r.id}` : url)) };
  }
  if (within(hostname, 'v2ex.com') && (id = /^\/t\/(\d{1,20})(?:\/|$)/.exec(pathname)?.[1])) {
    const data = await load(`https://www.v2ex.com/api/replies/show.json?topic_id=${id}`, 'json');
    return { comments: array(data).slice(0, 80).map(r => comment('V2EX', r?.member?.username, r?.content ?? r?.content_rendered, r?.thanks,
      /^\d{1,20}$/.test(r?.id) ? `https://www.v2ex.com/t/${id}#r_${r.id}` : url)) };
  }
  if (hostname === 'linux.do' && (id = /^\/t\/(?:[^/]+\/)?(\d{1,20})(?:\/|$)/.exec(pathname)?.[1])) {
    const data = await load(`https://linux.do/t/${id}.json`, 'json');
    return { comments: array(data?.post_stream?.posts).slice(0, 40).filter(r => Number(r?.post_number) > 1 && !r.deleted_at && !r.hidden)
      .map(r => comment('Linux.do', r.username, r.cooked, array(r.actions_summary).find(a => a.id === 2)?.count ?? r.like_count,
        `https://linux.do/t/topic/${id}/${Number(r.post_number)}`)) };
  }
  if (hostname === 'bbs.hupu.com' && /^\/\d{1,20}\.html$/.test(pathname)) return hupuDetails(await html(), url);
  if (within(hostname, 'bilibili.com') && (id = /^\/video\/(BV[\da-zA-Z]{8,20})(?:\/|$)/.exec(pathname)?.[1])) {
    const data = (await load(`https://api.bilibili.com/x/web-interface/view?bvid=${id}`, 'json'))?.data;
    if (!data) return {};
    let replies = data.hot_replies ?? data.replies;
    if (!array(replies).length && /^\d{1,20}$/.test(data.aid)) {
      const res = (await load(`https://api.bilibili.com/x/v2/reply?type=1&oid=${data.aid}&sort=2&pn=1&ps=8`, 'json'))?.data;
      replies = res?.hots?.length ? res.hots : res?.replies;
    }
    return { media: [data.pic], comments: array(replies).slice(0, 12).map(r => comment('Bilibili', r?.member?.uname,
      r?.content?.message, r?.like, /^\d{1,22}$/.test(r?.rpid_str ?? r?.rpid) ? `${url.split('#')[0]}#reply${r.rpid_str ?? r.rpid}` : url)) };
  }
  return {};
}

function combinedMedia(groups) {
  const seen = new Set(), result = [];
  for (const { media, item } of groups) {
    for (const image of normalizeMedia(media, item.url, 12)) {
      if (seen.has(image.url)) continue;
      seen.add(image.url);
      result.push({ url: image.url, kind: image.kind, ...(image.alt && { caption: image.alt }),
        sourceName: item.sourceName || new URL(image.url).hostname, proxyUrl: toProxyMediaUrl(image.url) });
    }
  }
  return result;
}

async function verifyMedia(candidates, { dnsLookup, signal }) {
  const media = [];
  for (let i = 0; i < candidates.length && media.length < 6 && !signal?.aborted; i += 6) {
    const verified = await Promise.all(candidates.slice(i, i + 6).map(async value => {
      try { await validateExternalUrl(value.url, { dnsLookup, signal, timeoutMs }); return value; }
      catch { return null; }
    }));
    media.push(...verified.filter(Boolean));
  }
  return media.slice(0, 6);
}

export function verifyStoredCommunityMedia(items, options = {}) {
  const groups = items.slice(0, 12).map(item => ({ item, media: item.media }));
  return verifyMedia(combinedMedia(groups).slice(0, 12), options);
}

/** Contact at most four articles plus one platform endpoint per article (two for Bilibili).
 * Verify candidate destinations as public; the media proxy revalidates DNS and checks the raster bytes when served.
 */
export async function extractCommunityEnrichment(items, { fetcher = safeFetch, dnsLookup, signal } = {}) {
  const load = async (url, type) => {
    try {
      signal?.throwIfAborted();
      const res = await fetcher(url, { dnsLookup, signal, timeoutMs, headers: browser });
      if (res.status < 200 || res.status >= 300) return null;
      return type === 'json' ? await res.json() : { text: await res.text(), url: res.url ?? url };
    } catch { return null; }
  };
  const seenUrls = new Set();
  const selected = items.filter(item => {
    if (!resolveHttpUrl(item.url) || seenUrls.has(item.url) || seenUrls.size >= maxItems) return false;
    seenUrls.add(item.url);
    return true;
  });
  const results = await Promise.all(selected.map(async item => {
    const page = load(item.url, 'html');
    const [article, social] = await Promise.all([page, community(item.url, load, async () => (await page)?.text ?? '').catch(() => ({}))]);
    const media = [...(social.media ?? []), ...(article ? extractMarkupMedia(article.text, article.url, { openGraph: true, limit: 6 }) : [])];
    return { item, media, comments: social.comments ?? [] };
  }));
  const candidates = combinedMedia([...items.slice(0, 12).map(item => ({ item, media: item.media })), ...results]).slice(0, 18);
  const media = await verifyMedia(candidates, { dnsLookup, signal });
  const seenComments = new Set();
  const communityComments = results.flatMap(r => r.comments).filter(Boolean).sort((a, b) => b.likes - a.likes).filter(c => {
    const key = JSON.stringify([c.platform, c.author, c.quote]);
    if (seenComments.has(key)) return false;
    seenComments.add(key);
    return true;
  }).slice(0, 6);
  return { media, communityComments };
}
