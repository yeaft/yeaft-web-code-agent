/* Source catalog adapted in part from newsnext/newsnow (MIT License).
 * Copyright (c) 2024 ourongxing. Full MIT notice in sources.js. */
export const BUILTIN_DOMAINS = Object.freeze([
  { id: 'ai', nameZh: 'AI 与大模型', nameEn: 'AI & Models', colorToken: 'cyan', icon: '✦', defaultEnabled: true },
  { id: 'tech', nameZh: '编程与开源', nameEn: 'Engineering & OSS', colorToken: 'mint', icon: '⌘', defaultEnabled: true },
  { id: 'finance', nameZh: '财经与市场', nameEn: 'Finance & Markets', colorToken: 'gold', icon: '◈', defaultEnabled: true },
  { id: 'product', nameZh: '科技与数码', nameEn: 'Tech & Products', colorToken: 'violet', icon: '◎', defaultEnabled: true },
  { id: 'world', nameZh: '全球与时政', nameEn: 'World & Current', colorToken: 'rose', icon: '◐', defaultEnabled: false },
  { id: 'hot', nameZh: '全网热议', nameEn: 'Trending Hot', colorToken: 'amber', icon: '✹', defaultEnabled: false },
].map(Object.freeze));

// The explicit source list contains 23 distinct IDs (including separate feeds from WallstreetCN).
export const BUILTIN_SOURCES = Object.freeze([
  ['aihot', 'ai', 'AIHot', 'https://aihot.news/feed/all.xml', 'rss'],
  ['36kr-quick', 'ai', '36氪快讯', 'https://www.36kr.com/newsflashes'],
  ['hackernews', 'ai', 'Hacker News', 'https://hnrss.org/frontpage?count=30', 'rss'],
  ['github', 'tech', 'GitHub Trending', 'https://github.com/trending?spoken_language_code='],
  ['juejin', 'tech', '掘金', 'https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot&spider=0'],
  ['v2ex', 'tech', 'V2EX', 'https://www.v2ex.com/feed/'],
  ['solidot', 'tech', 'Solidot', 'https://www.solidot.org/index.rss', 'rss'],
  ['linuxdo', 'tech', 'Linux.do', 'https://linux.do/latest.json?order=created'],
  ['cls-telegraph', 'finance', '财联社电报', 'https://www.cls.cn/v1/roll/get_roll_list'],
  ['wallstreetcn-quick', 'finance', '华尔街见闻快讯', 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30'],
  ['wallstreetcn-news', 'finance', '华尔街见闻资讯', 'https://api-one.wallstcn.com/apiv1/content/information-flow?channel=global-channel&accept=article&limit=30'],
  ['jin10', 'finance', '金十快讯', 'https://www.jin10.com/flash_newest.js'],
  ['xueqiu', 'finance', '雪球热股', 'https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=30&_type=10&type=10'],
  ['ithome', 'product', 'IT之家', 'https://www.ithome.com/list/'],
  ['sspai', 'product', '少数派', 'https://sspai.com/api/v1/article/tag/page/get?limit=30&offset=0&tag=热门文章&released=false'],
  ['producthunt', 'product', 'Product Hunt', 'https://www.producthunt.com/feed', 'rss'],
  ['thepaper', 'world', '澎湃热榜', 'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar'],
  ['cankaoxiaoxi', 'world', '参考消息', 'http://china.cankaoxiaoxi.com/json/channel/'],
  ['toutiao', 'world', '今日头条', 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc'],
  ['zhihu', 'hot', '知乎热榜', 'https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true'],
  ['weibo', 'hot', '微博热搜', 'https://s.weibo.com/top/summary?cate=realtimehot'],
  ['baidu', 'hot', '百度热搜', 'https://top.baidu.com/board?tab=realtime'],
  ['bilibili', 'hot', 'B站热门视频', 'https://api.bilibili.com/x/web-interface/popular'],
].map(([id, domainId, name, url, kind = 'adapter']) => Object.freeze({ id, domainId, name, url, kind })));
