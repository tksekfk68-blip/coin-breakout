// 📌 내 보유 코인 차트 분석 (GitHub Actions, 하루 4번)
// - 대상: public/research/watch.json 의 markets (기본 왁스·아비트럼)
// - 추세·지지/저항·기준선(위: 반등 이어짐 / 아래: 반등 끝)·쉬운 말 코멘트
// - 비슷하게 움직인 코인, 하루 한 번 상태 기록(history)
// 결과: public/research/analyze.json
import fs from 'node:fs';
import { STABLES } from '../public/lib/strategy.js';
import { ema, atr, rsiArr } from '../public/lib/pro.js';
import { findLevels } from '../public/lib/analysis.js';

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const TARGETS = read('public/research/watch.json', { markets: ['KRW-WAXP', 'KRW-ARB'] }).markets;
const BASE = 'https://api.upbit.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(BASE + p);
    if (r.status === 429) { await sleep(1000 * (a + 1)); continue; }
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
}
async function candles(m, n = 400) {
  let out = [], to = '';
  while (out.length < n) {
    const raw = await get(`/candles/days?market=${m}&count=200${to ? `&to=${encodeURIComponent(to)}` : ''}`);
    await sleep(130);
    if (!raw?.length) break;
    out = out.concat(raw);
    to = raw.at(-1).candle_date_time_utc.replace('T', ' ');
    if (raw.length < 200) break;
  }
  return out.map((d) => ({ t: d.candle_date_time_kst.slice(0, 10), o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.candle_acc_trade_price }))
    .sort((a, b) => (a.t < b.t ? -1 : 1)).filter((x, i, a) => i === 0 || x.t !== a[i - 1].t);
}
const fmt = (x) => {
  const d = x >= 1000 ? 0 : x >= 100 ? 1 : x >= 1 ? 2 : 4;
  return x.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const pc = (x) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const tick = await get('/ticker/all?quote_currencies=KRW');
const T = Object.fromEntries(tick.map((t) => [t.market, t]));
const names = Object.fromEntries((await get('/market/all?isDetails=false')).map((m) => [m.market, m.korean_name]));
const uni = tick.filter((t) => !STABLES.has(t.market.replace('KRW-', '')) && t.acc_trade_price_24h >= 1e9)
  .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h).slice(0, 120).map((t) => t.market);

const data = {};
for (const m of TARGETS) data[m] = await candles(m, 800);
for (const m of uni) if (!data[m]) { try { data[m] = await candles(m, 70); } catch {} }

const ret = (cs, n) => { const s = cs.slice(-n - 1); return s.slice(1).map((x, i) => Math.log(x.c / s[i].c)); };
const corr = (a, b) => {
  const n = Math.min(a.length, b.length); a = a.slice(-n); b = b.slice(-n);
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return c / Math.sqrt(va * vb);
};

const todayKST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const prev = read('public/research/analyze.json', { coins: {} });
const out = { at: new Date().toISOString(), coins: {} };

for (const m of TARGETS) {
  const all = data[m];
  if (!all?.length) continue;
  // 오늘 진행 중 캔들은 지표 계산에서 빼고, 가격은 실시간 값 사용
  const cs = all.at(-1).t === todayKST ? all.slice(0, -1) : all;
  const live = all.at(-1).t === todayKST ? all.at(-1) : null;
  const price = T[m]?.trade_price ?? cs.at(-1).c;
  const c = cs.map((x) => x.c), last = cs.length - 1;
  const e20 = ema(c, 20)[last], e50 = ema(c, 50)[last], e200 = cs.length >= 200 ? ema(c, 200)[last] : null;
  const A = atr(cs)[last], R = rsiArr(c)[last];
  const hiAll = Math.max(...all.map((x) => x.h)), loAll = Math.min(...all.map((x) => x.l));
  const lv = findLevels(cs, price, { lookback: 200 });

  // 기준선: 위 = 최근 20일 최고가(넘으면 반등 이어짐), 아래 = 가장 여러 번 받쳐준 지지선(깨지면 반등 끝)
  const upKey = Math.max(...cs.slice(-20).map((x) => x.h));
  const strong = lv.supports.filter((s) => s.price >= price * 0.65).sort((a, b) => b.touches - a.touches || b.price - a.price)[0];
  const downKey = strong ? strong.price : Math.min(...cs.slice(-30).map((x) => x.l));
  const nextR = lv.resistances[0]?.price ?? upKey;
  const nextS = lv.supports[0]?.price ?? downKey;

  const trend = e20 > e50 && (!e200 || price > e200) ? 'up' : e20 < e50 && e200 && price < e200 ? 'down' : 'mixed';
  let status, tone;
  if (price > upKey) { status = '반등 강해짐'; tone = 'good'; }
  else if (price < downKey) { status = '반등 끝 경고'; tone = 'bad'; }
  else if (trend === 'up' && price >= e20) { status = '상승 흐름 유지'; tone = 'good'; }
  else if (trend === 'up') { status = '상승 중 쉬어가는 중'; tone = 'mid'; }
  else if (trend === 'down') { status = '하락 흐름'; tone = 'bad'; }
  else { status = '방향 탐색 중'; tone = 'mid'; }

  const volNow = (live ? live.v : cs.at(-1).v);
  const vol20 = cs.slice(-21, -1).reduce((s, x) => s + x.v, 0) / 20;
  const chg1 = price / cs.at(-1).c - 1;
  const comments = [];
  comments.push(`지금 ${fmt(price)}원, 어제 마감 대비 ${pc(chg1)}. 최근 7일 ${pc(price / cs.at(-7).c - 1)}, 30일 ${pc(price / cs.at(-30).c - 1)}.`);
  comments.push(trend === 'up'
    ? `20일선(${fmt(e20)}) > 50일선(${fmt(e50)})${e200 ? `, 200일선(${fmt(e200)}) 위` : ''} — 큰 흐름은 위쪽이에요.`
    : trend === 'down' ? `20일선이 50일선 아래${e200 ? `, 200일선(${fmt(e200)})도 아래` : ''} — 큰 흐름은 아래쪽이에요.`
    : `이동평균선이 엉켜 있어요 — 방향을 정하는 중이에요.`);
  comments.push(`위로는 ${fmt(nextR)}원이 첫 벽, ${fmt(upKey)}원을 넘으면 반등이 이어지는 신호예요.`);
  comments.push(`아래로는 ${fmt(nextS)}원이 첫 받침, ${fmt(downKey)}원이 깨지면 이번 반등은 끝난 걸로 봐요.`);
  if (R > 70) comments.push(`RSI ${R.toFixed(0)} — 단기 과열권이라 쉬어갈 수 있어요.`);
  else if (R < 35) comments.push(`RSI ${R.toFixed(0)} — 많이 눌린 상태예요.`);
  if (volNow > vol20 * 2) comments.push(`오늘 거래량이 평소의 ${(volNow / vol20).toFixed(1)}배 — 큰 돈이 움직이는 중이에요.`);

  const r60 = ret(cs, 60);
  const similar = uni.filter((x) => x !== m && data[x]?.length >= 61)
    .map((x) => ({ m: x, name: names[x], corr: corr(r60, ret(data[x], 60)), chg30: data[x].at(-1).c / data[x].at(-31).c - 1 }))
    .sort((a, b) => b.corr - a.corr).slice(0, 5);

  // 하루 한 번 상태 기록 (최근 30일)
  const hist = (prev.coins?.[m]?.history || []).filter((h) => h.date !== todayKST);
  hist.push({ date: todayKST, price, status, tone });

  out.coins[m] = {
    name: names[m], price, updatedFrom: cs.at(-1).t,
    hiAll, hiAllDate: all.find((x) => x.h === hiAll).t, loAll, loAllDate: all.find((x) => x.l === loAll).t,
    e20, e50, e200, atrPct: A / c[last], rsi: R, trend, status, tone,
    upKey, downKey, nextR, nextS, levels: lv,
    chg: { d1: chg1, d7: price / cs.at(-7).c - 1, d30: price / cs.at(-30).c - 1, d90: cs.length > 90 ? price / cs.at(-90).c - 1 : null },
    volRatio: volNow / vol20,
    comments, similar,
    history: hist.slice(-30),
  };
}
fs.writeFileSync('public/research/analyze.json', JSON.stringify(out, null, 1));
console.log(Object.entries(out.coins).map(([m, x]) => `${m} ${x.price} ${x.status} up ${x.upKey} down ${x.downKey}`).join('\n'));
