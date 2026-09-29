// Cloudflare Workers 진입점: /api/* 는 서버 기능, 나머지는 public/ 정적 파일
import * as upbit from '../functions/api/upbit.js';
import * as journal from '../functions/api/journal.js';
import * as pulse from '../functions/api/pulse.js';

const routes = { '/api/upbit': upbit, '/api/journal': journal, '/api/pulse': pulse };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = routes[url.pathname];
    if (mod) {
      const c = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
      const h = (request.method === 'GET' && mod.onRequestGet) || mod.onRequest;
      if (!h) return new Response('method not allowed', { status: 405 });
      return h(c);
    }
    if (url.pathname.startsWith('/api/')) return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    return env.ASSETS.fetch(request);
  },
};
