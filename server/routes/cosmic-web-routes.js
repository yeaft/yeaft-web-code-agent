import { CONFIG } from '../config.js';
import { userDb } from '../database.js';
import { cosmicWebService } from '../cosmic-web/service.js';
import { proxyMedia as defaultMediaProxy } from '../cosmic-web/media-proxy.js';

export function registerCosmicWebRoutes(app, { requireSessionAuth, cosmicWeb = cosmicWebService, proxyMedia = defaultMediaProxy }) {
  const prefix = '/api/cosmic-web';
  function route(method, path, action, binary = false) {
    app[method](`${prefix}${path}`, requireSessionAuth, async (req, res) => {
      // Browsing history, preferences, and briefing output are session-scoped.
      res.set('Cache-Control', 'private, no-store');
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) ac.abort(Object.assign(new Error('Cosmic Web request cancelled'), { status: 499 }));
      };
      res.on('close', onClose);
      try {
        if (method !== 'get' && req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request not allowed' });
        const username = CONFIG.skipAuth ? 'dev-user' : req.user?.username;
        const user = username && userDb.getByUsername(username);
        const userId = user?.id ?? (CONFIG.skipAuth ? 'dev-user' : null);
        if (!userId || user?.deletion_state && user.deletion_state !== 'active') return res.status(401).json({ error: 'User not found' });
        const role = CONFIG.skipAuth ? 'admin' : user.role ?? req.user.role;
        const result = await action(userId, role, req, ac.signal);
        if (ac.signal.aborted || res.writableEnded) return;
        if (!binary) return res.json(result);
        res.vary('Cookie').vary('Authorization');
        return res.set(result.headers).set('Content-Length', String(result.body.length)).end(result.body);
      } catch (err) {
        if (ac.signal.aborted || res.writableEnded || err?.status === 499) return;
        if ([400, 403, 404, 409, 415, 429, 502, 503, 504].includes(err.status)) return res.status(err.status).json({ error: err.message });
        console.error('[CosmicWeb] Request failed:', method, path, err.name);
        return res.status(500).json({ error: 'Internal server error' });
      } finally {
        res.off('close', onClose);
      }
    });
  }
  route('get', '/media-proxy', (id, _role, req, signal) => proxyMedia(req.query.url, {
    userId: id,
    exp: req.query.exp,
    sig: req.query.sig,
    signal,
    requireSigned: true,
  }), true);
  route('get', '/bootstrap', (id, role) => cosmicWeb.bootstrap(id, role));
  route('get', '/feed', (id, _, req) => cosmicWeb.feed(id, req.query));
  route('get', '/graph', (id, _, req) => cosmicWeb.graph(id, req.query));
  route('get', '/clusters/:id', (id, _, req) => cosmicWeb.cluster(id, req.params.id));
  route('get', '/clusters/:id/community', (id, _, req, signal) => cosmicWeb.clusterCommunity(id, req.params.id, signal));
  route('get', '/clusters/:id/article', (id, _, req) => cosmicWeb.article(id, req.params.id, req.query));
  route('post', '/clusters/:id/ai-brief', (id, role, req, signal) => cosmicWeb.aiBrief(id, role, req.params.id, req.body, signal));
  route('post', '/clusters/:id/follow-up', (id, role, req, signal) => cosmicWeb.followUp(id, role, req.params.id, req.body, signal));
  route('post', '/domains/:id/radar-scan', (id, role, req, signal) => cosmicWeb.radarScan(id, role, req.params.id, req.body, signal));
  route('post', '/daily-briefing', (id, role, req, signal) => cosmicWeb.dailyBriefing(id, role, req.body, signal));
  route('patch', '/clusters/:id/state', (id, _, req) => cosmicWeb.setClusterState(id, req.params.id, req.body));
  route('post', '/mark-all-read', (id, _, req) => cosmicWeb.markAllRead(id, req.body ?? {}));
  route('get', '/preferences', id => cosmicWeb.getPreferences(id));
  route('put', '/preferences', async (id, _, req) => {
    const { domains, graph, stats, ...preferences } = await cosmicWeb.savePreferences(id, req.body);
    return { preferences, prefs: preferences, domains, graph, stats };
  });
  route('post', '/refresh', (id, _, req) => cosmicWeb.refresh(id, req.body));
}
