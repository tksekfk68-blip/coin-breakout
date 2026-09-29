// 브라우저용 업비트 중계 (Cloudflare Pages Functions)
// /api/upbit?ep=tickers | ep=markets | ep=candles&market=KRW-BTC&count=200
const BASE = 'https://api.upbit.com/v1';

async function upbit(path) {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 700 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`Upbit ${r.status}`);
    return r.text();
  }
  throw new Error('Upbit rate limited');
}

const reply = (body, maxAge, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
});

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url);
  const ep = u.searchParams.get('ep');
  let path, maxAge;
  if (ep === 'tickers') { path = '/ticker/all?quote_currencies=KRW'; maxAge = 15; }
  else if (ep === 'markets') { path = '/market/all?isDetails=false'; maxAge = 3600; }
  else if (ep === 'candles') {
    const market = u.searchParams.get('market') || '';
    if (!/^KRW-[A-Z0-9]{1,15}$/.test(market)) return reply('{"error":"bad market"}', 0, 400);
    const count = Math.min(200, Math.max(1, parseInt(u.searchParams.get('count') || '200', 10)));
    path = `/candles/days?market=${market}&count=${count}`; maxAge = 60;
  } else return reply('{"error":"unknown ep"}', 0, 400);

  // 엣지 캐시: 같은 요청은 잠깐 재사용 (쿼리별로 따로 저장됨)
  const cache = caches.default;
  const key = new Request(u.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const res = reply(await upbit(path), maxAge);
    waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e) {
    return reply(JSON.stringify({ error: String(e.message || e) }), 0, 502);
  }
}
