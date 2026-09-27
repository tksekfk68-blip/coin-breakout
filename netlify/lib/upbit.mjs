// 서버(Netlify 함수)에서 업비트 공개 API를 부르는 도우미
import { STABLES, normalizeUpbitCandles } from '../../public/lib/strategy.js';

const BASE = 'https://api.upbit.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function upbitGet(path, tries = 3) {
  for (let a = 0; a < tries; a++) {
    const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (res.status === 429) { await sleep(800 * (a + 1)); continue; }
    if (!res.ok) throw new Error(`Upbit ${res.status} ${path}`);
    return res.json();
  }
  throw new Error(`Upbit rate limited: ${path}`);
}

/** 원화 마켓 중 24시간 거래대금 상위 N개 (스테이블코인 제외) */
export async function topMarkets(n = 30, minValue = 0) {
  const all = await upbitGet('/ticker/all?quote_currencies=KRW');
  return all
    .filter((t) => !STABLES.has(t.market.replace('KRW-', '')))
    .filter((t) => t.acc_trade_price_24h >= minValue)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, n);
}

export async function dailyCandles(market, count = 200) {
  const raw = await upbitGet(`/candles/days?market=${encodeURIComponent(market)}&count=${count}`);
  return normalizeUpbitCandles(raw);
}

/** 여러 코인 캔들을 초당 요청 한도에 맞춰 나눠서 받기 */
export async function candlesFor(markets, count = 200, batch = 5, gap = 600) {
  const out = {};
  for (let i = 0; i < markets.length; i += batch) {
    const part = markets.slice(i, i + batch);
    const got = await Promise.all(part.map((m) => dailyCandles(m, count).catch(() => null)));
    part.forEach((m, k) => { if (got[k]) out[m] = got[k]; });
    if (i + batch < markets.length) await sleep(gap);
  }
  return out;
}
