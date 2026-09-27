// 오늘의 신호를 저장하는 공용 로직
import { getStore } from '@netlify/blobs';
import { DEFAULT_PARAMS, screenMarket, todayKST } from '../../public/lib/strategy.js';
import { topMarkets, candlesFor } from './upbit.mjs';

export async function runDailyLog() {
  const p = DEFAULT_PARAMS;
  const tops = await topMarkets(30);
  const data = await candlesFor(tops.map((t) => t.market), 120);
  const today = todayKST();
  const picks = [];
  for (const [market, candles] of Object.entries(data)) {
    const s = screenMarket(candles, p, 1, today);
    if (s && s.confirmed.length) {
      const c = s.confirmed[0];
      picks.push({ market, date: c.date, entry: c.close, volRatio: c.volRatio });
    }
  }
  const signalDate = picks[0]?.date || null;
  const record = { loggedAt: new Date().toISOString(), today, signalDate, params: p, universe: Object.keys(data).length, picks };
  await getStore('picks').setJSON(today, record);
  return record;
}

