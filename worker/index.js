// Cloudflare Worker entry: /api/sync/* is the sync API; everything else is the static app (assets binding).
import { handleSync } from './sync-server.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      try {
        return await handleSync(request, env);
      } catch {
        return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
