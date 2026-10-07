// 변동성 감지 (GitHub Actions, 30분마다)
// 비트코인 급변 · 시장 전체 급락 · 보유 코인 기준선 도달 → public/briefing/alert.json
import fs from 'node:fs';
const BASE = 'https://api.upbit.com/v1';
const get = async (p) => { for (let a = 0; a < 4; a++) { const r = await fetch(BASE + p); if (r.status === 429) { await new Promise((s) => setTimeout(s, 1000)); continue; } return r.json(); } };
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const pc = (x) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const FILE = 'public/briefing/alert.json';
const prev = read(FILE, null);
const watch = read('public/research/watch.json', { markets: [] }).markets;
const A = read('public/research/analyze.json', { coins: {} });

const h1 = await get('/candles/minutes/60?market=KRW-BTC&count=25');   // 최신 → 과거
const btcNow = h1[0].trade_price;
const chg1h = btcNow / h1[1].trade_price - 1;
const chg4h = btcNow / h1[4].trade_price - 1;
const chg24h = btcNow / h1[24].trade_price - 1;
const tick = await get('/ticker/all?quote_currencies=KRW');
const down = tick.filter((t) => t.signed_change_rate < 0).length / tick.length;
const big = tick.filter((t) => t.acc_trade_price_24h > 5e9);
const movers = [...big].sort((a, b) => a.signed_change_rate - b.signed_change_rate);

const reasons = [];
let level = null;
if (Math.abs(chg1h) >= 0.015) { reasons.push(`비트코인 1시간 ${pc(chg1h)}`); level = Math.abs(chg1h) >= 0.03 ? '위험' : '주의'; }
if (Math.abs(chg4h) >= 0.03) { reasons.push(`비트코인 4시간 ${pc(chg4h)}`); level = Math.abs(chg4h) >= 0.05 ? '위험' : level || '주의'; }
if (down >= 0.85 && chg24h <= -0.015) { reasons.push(`원화마켓 ${Math.round(down * 100)}% 하락`); level = level || '주의'; }
if (down <= 0.15 && chg24h >= 0.015) { reasons.push(`원화마켓 ${Math.round((1 - down) * 100)}% 상승`); level = level || '주의'; }

const holdings = [];
for (const m of watch) {
  const t = tick.find((x) => x.market === m);
  const x = A.coins?.[m];
  if (!t || !x) continue;
  const p = t.trade_price;
  const zone = p > x.upKey ? '넘으면 강세 돌파' : p < x.downKey ? '반등 끝 기준선 이탈' : p < x.nextS ? '첫 받침 아래' : p > x.nextR ? '첫 벽 위' : '기준선 사이';
  holdings.push({ m, price: p, chgDay: t.signed_change_rate, zone });
  if (zone === '넘으면 강세 돌파' || zone === '반등 끝 기준선 이탈') { reasons.push(`${m.replace('KRW-', '')} ${zone}`); level = level || '주의'; }
}

const active = reasons.length > 0;
const out = {
  at: new Date().toISOString(), active, level, reasons,
  btc: { price: btcNow, chg1h, chg4h, chg24h }, breadthDown: down,
  topLosers: movers.slice(0, 5).map((t) => ({ m: t.market, chg: t.signed_change_rate })),
  topGainers: movers.slice(-5).reverse().map((t) => ({ m: t.market, chg: t.signed_change_rate })),
  holdings,
  since: active ? (prev?.active ? prev.since : new Date().toISOString()) : null,
};
// 같은 상태가 계속되면 1시간에 한 번만 기록 (커밋 줄이기)
const key = (o) => `${o?.active}|${(o?.reasons || []).map((r) => r.replace(/[-+]?\d+(\.\d+)?%/g, '')).join(',')}`;
const age = prev ? (Date.now() - Date.parse(prev.at)) / 60000 : 1e9;
if (!prev || key(prev) !== key(out) || (active && age >= 60) || (!active && age >= 360)) {
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.log('written', active, reasons.join(' / '));
} else console.log('unchanged', active, reasons.join(' / '));
