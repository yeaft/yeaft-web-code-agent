import { CONFIG } from '../config.js';
import { userDb } from '../database.js';
import { cosmicWebService } from '../cosmic-web/service.js';

export function registerCosmicWebRoutes(app, { requireSessionAuth, cosmicWeb = cosmicWebService }) {
  const prefix = '/api/cosmic-web';
  function route(method, path, action) {
    app[method](`${prefix}${path}`, requireSessionAuth, async (req, res) => {
      // Browsing history, preferences, and briefing output are session-scoped.
      res.set('Cache-Control', 'private, no-store');
      try {
        const username = CONFIG.skipAuth ? 'dev-user' : req.user?.username;
        const user = username && userDb.getByUsername(username);
        const userId = user?.id ?? (CONFIG.skipAuth ? 'dev-user' : null);
        if (!userId || user?.deletion_state && user.deletion_state !== 'active') return res.status(401).json({ error: 'User not found' });
        const role = CONFIG.skipAuth ? 'admin' : user.role ?? req.user.role;
        return res.json(await action(userId, role, req));
      } catch (err) {
        if ([400, 403, 404, 409, 429, 502, 503, 504].includes(err.status)) return res.status(err.status).json({ error: err.message });
        console.error('[CosmicWeb] Request failed:', method, path, err.name);
        return res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
  route('get', '/bootstrap', (id, role) => cosmicWeb.bootstrap(id, role));
  route('get', '/feed', (id, _, req) => cosmicWeb.feed(id, req.query));
  route('get', '/graph', (id, _, req) => cosmicWeb.graph(id, req.query));
  route('get', '/clusters/:id', (id, _, req) => cosmicWeb.cluster(id, req.params.id));
  route('get', '/clusters/:id/article', (id, _, req) => cosmicWeb.article(id, req.params.id, req.query));
  route('post', '/clusters/:id/ai-brief', (id, role, req) => cosmicWeb.aiBrief(id, role, req.params.id, req.body));
  route('post', '/daily-briefing', (id, role, req) => cosmicWeb.dailyBriefing(id, role, req.body));
  route('patch', '/clusters/:id/state', (id, _, req) => cosmicWeb.setClusterState(id, req.params.id, req.body));
  route('post', '/mark-all-read', (id, _, req) => cosmicWeb.markAllRead(id, req.body ?? {}));
  route('get', '/preferences', id => cosmicWeb.getPreferences(id));
  route('put', '/preferences', async (id, _, req) => ({ preferences: await cosmicWeb.savePreferences(id, req.body) }));
  route('post', '/refresh', (id, _, req) => cosmicWeb.refresh(id, req.body));
}
