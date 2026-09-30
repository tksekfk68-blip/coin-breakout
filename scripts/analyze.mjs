// 특정 코인 분석: 추세·지지/저항·고점 대비 위치 + 최근 60일 움직임이 비슷한 코인
import fs from 'node:fs';
import { STABLES } from '../public/lib/strategy.js';
import { ema, atr, rsiArr } from '../public/lib/pro.js';
import { findLevels } from '../public/lib/analysis.js';
const TARGETS = ['KRW-WAXP', 'KRW-ARB'];
const BASE = 'https://api.upbit.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { for (let a = 0; a < 5; a++) { const r = await fetch(BASE + p); if (r.status === 429) { await sleep(1000); continue; } if (!r.ok) throw new Error(r.status); return r.json(); } }
async function candles(m, n = 400) {
  let out = [], to = '';
  while (out.length < n) {
    const raw = await get(`/candles/days?market=${m}&count=200${to ? `&to=${encodeURIComponent(to)}` : ''}`); await sleep(130);
    if (!raw?.length) break; out = out.concat(raw); to = raw.at(-1).candle_date_time_utc.replace('T', ' '); if (raw.length < 200) break;
  }
  return out.map((d) => ({ t: d.candle_date_time_kst.slice(0, 10), o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.candle_acc_trade_price })).sort((a, b) => (a.t < b.t ? -1 : 1));
}
const tick = await get('/ticker/all?quote_currencies=KRW');
const names = Object.fromEntries((await get('/market/all?isDetails=false')).map((m) => [m.market, m.korean_name]));
const uni = tick.filter((t) => !STABLES.has(t.market.replace('KRW-', '')) && t.acc_trade_price_24h >= 5e8).map((t) => t.market);
const data = {};
for (const m of TARGETS) data[m] = await candles(m, 800);
for (const m of uni) if (!data[m]) { try { data[m] = await candles(m, 120); } catch {} }
const ret = (cs, n) => { const s = cs.slice(-n - 1); return s.slice(1).map((x, i) => Math.log(x.c / s[i].c)); };
const corr = (a, b) => { const n = Math.min(a.length, b.length); a = a.slice(-n); b = b.slice(-n); const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };
const out = { at: new Date().toISOString(), coins: {} };
for (const m of TARGETS) {
  const cs = data[m]; const c = cs.map((x) => x.c); const last = cs.length - 1; const price = tick.find((t) => t.market === m).trade_price;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), A = atr(cs), R = rsiArr(c);
  const hiAll = Math.max(...cs.map((x) => x.h)), loAll = Math.min(...cs.map((x) => x.l));
  const hi90 = Math.max(...cs.slice(-90).map((x) => x.h)), lo90 = Math.min(...cs.slice(-90).map((x) => x.l));
  const lv = findLevels(cs, price, { lookback: 200 });
  const r60 = ret(cs, 60);
  const sim = uni.filter((x) => x !== m && data[x]?.length >= 61).map((x) => ({ m: x, name: names[x], corr: corr(r60, ret(data[x], 60)), chg60: data[x].at(-1).c / data[x].at(-61).c - 1 })).sort((a, b) => b.corr - a.corr).slice(0, 8);
  const monthly = []; for (let i = cs.length - 1; i >= 0 && monthly.length < 14; i -= 30) monthly.push({ t: cs[i].t, c: cs[i].c });
  out.coins[m] = { name: names[m], price, days: cs.length, first: cs[0].t, firstPrice: cs[0].c, hiAll, hiAllDate: cs.find((x) => x.h === hiAll).t, loAll, loAllDate: cs.find((x) => x.l === loAll).t, hi90, lo90,
    e20: e20[last], e50: e50[last], e200: e200[last], atrPct: A[last] / c[last], rsi: R[last],
    chg: { d7: price / cs.at(-8).c - 1, d30: price / cs.at(-31).c - 1, d90: price / cs.at(-91).c - 1, d180: cs.length > 181 ? price / cs.at(-181).c - 1 : null, d365: cs.length > 366 ? price / cs.at(-366).c - 1 : null },
    vol7vs30: cs.slice(-7).reduce((s, x) => s + x.v, 0) / 7 / (cs.slice(-37, -7).reduce((s, x) => s + x.v, 0) / 30),
    levels: lv, similar: sim, monthly: monthly.reverse(), last10: cs.slice(-10) };
}
fs.writeFileSync('public/research/analyze.json', JSON.stringify(out, null, 1));
console.log('ok');
