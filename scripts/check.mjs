// 어제 추천 코인들이 그 뒤 어떻게 됐는지 + 시장 전체에서 오른 코인 확인
import fs from 'node:fs';
const BASE = 'https://api.upbit.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { for (let a = 0; a < 5; a++) { const r = await fetch(BASE + p); if (r.status === 429) { await sleep(1000); continue; } return r.json(); } };
const rep = JSON.parse(fs.readFileSync('public/research/report.json', 'utf8'));
const setups = rep.modes.win.setups;
const tick = await get('/ticker/all?quote_currencies=KRW');
const T = Object.fromEntries(tick.map((t) => [t.market, t]));
const out = { at: new Date().toISOString(), picks: [], btc: null, topGainers: [] };
for (const s of [...setups, { m: 'KRW-BTC', ref: null }]) {
  const cs = await get(`/candles/days?market=${s.m}&count=4`); await sleep(150);
  const row = { m: s.m, ref: s.ref, stop: s.stop, target: s.target, now: T[s.m]?.trade_price,
    candles: cs.map((c) => ({ t: c.candle_date_time_kst.slice(0, 10), o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price })).reverse() };
  if (s.m === 'KRW-BTC') out.btc = row; else out.picks.push(row);
}
// 2일 수익률 상위 (9/26 종가 대비)
const cand = tick.filter((t) => t.acc_trade_price_24h >= 1e9).sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h).slice(0, 120);
const g = [];
for (const t of cand) {
  const cs = await get(`/candles/days?market=${t.market}&count=3`); await sleep(120);
  const base = cs.find((c) => c.candle_date_time_kst.startsWith('2026-09-26'));
  if (base) g.push({ m: t.market, from926: t.trade_price / base.trade_price - 1, day: t.signed_change_rate });
}
out.topGainers = g.sort((a, b) => b.from926 - a.from926).slice(0, 15);
out.universeMedian = g.map((x) => x.from926).sort((a, b) => a - b)[Math.floor(g.length / 2)];
out.universeUpShare = g.filter((x) => x.from926 > 0).length / g.length;
fs.writeFileSync('public/research/check.json', JSON.stringify(out, null, 1));
console.log('done', out.picks.length);
