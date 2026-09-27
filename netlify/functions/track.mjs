// 실전 성적표: 저장된 과거 추천들을 지금 시세로 채점해서 돌려줌
import { getStore } from '@netlify/blobs';
import { HORIZONS, splitClosed } from '../../public/lib/strategy.js';
import { candlesFor } from '../lib/upbit.mjs';

export default async () => {
  const store = getStore('picks');
  const { blobs } = await store.list();
  const records = (await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })))).filter(Boolean);
  const picks = records.flatMap((r) => r.picks.map((p) => ({ ...p, loggedOn: r.today })));
  const markets = [...new Set(picks.map((p) => p.market))];
  const data = markets.length ? await candlesFor(markets, 60) : {};

  const graded = picks.map((p) => {
    const cs = data[p.market];
    if (!cs) return { ...p, returns: {} };
    const { closed, live } = splitClosed(cs);
    const i = closed.findIndex((c) => c.t === p.date);
    const returns = {};
    if (i >= 0) {
      for (const hz of HORIZONS) if (closed[i + hz]) returns[hz] = closed[i + hz].c / p.entry - 1;
    }
    const nowPrice = (live || closed[closed.length - 1]).c;
    return { ...p, returns, now: nowPrice / p.entry - 1 };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));

  return new Response(JSON.stringify({ days: records.length, picks: graded }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120' },
  });
};

export const config = { path: '/api/track' };
