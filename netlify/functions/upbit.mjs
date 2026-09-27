// 브라우저용 업비트 중계: /api/upbit?ep=tickers | ep=candles&market=KRW-BTC&count=200
import { upbitGet } from '../lib/upbit.mjs';

const json = (body, maxAge, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${maxAge}`,
    'netlify-cdn-cache-control': `public, s-maxage=${maxAge}, stale-while-revalidate=30`,
  },
});

export default async (req) => {
  const u = new URL(req.url);
  const ep = u.searchParams.get('ep');
  try {
    if (ep === 'tickers') {
      return json(await upbitGet('/ticker/all?quote_currencies=KRW'), 15);
    }
    if (ep === 'markets') {
      return json(await upbitGet('/market/all?isDetails=false'), 3600);
    }
    if (ep === 'candles') {
      const market = u.searchParams.get('market') || '';
      if (!/^KRW-[A-Z0-9]{1,15}$/.test(market)) return json({ error: 'bad market' }, 0, 400);
      const count = Math.min(200, Math.max(1, parseInt(u.searchParams.get('count') || '200', 10)));
      return json(await upbitGet(`/candles/days?market=${market}&count=${count}`), 60);
    }
    return json({ error: 'unknown ep' }, 0, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 0, 502);
  }
};

export const config = { path: '/api/upbit' };
