// 매일 신호 기록 + 성적표 채점 (GitHub Actions, 매일 09:10 KST)
// - 어제 마감 캔들 기준 신호를 public/research/picks.json 에 누적 (최근 90일 보관)
//   · breakout(추세 돌파) · pullback(눌림목) · pro(깐부 점수제, 실제 검증된 조합)
// - 지난 신호를 3/7/14일 뒤 가격으로 채점 → public/research/track.json
import fs from 'node:fs';
import { DEFAULT_PARAMS, signalIndexes, STABLES } from '../public/lib/strategy.js';
import { prepare, currentSetup } from '../public/lib/pro.js';

const BASE = 'https://api.upbit.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(BASE + p);
    if (r.status === 429) { await sleep(1000 * (a + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${p}`);
    return r.json();
  }
  throw new Error('rate limited');
}
const norm = (raw) => raw.map((d) => ({ t: d.candle_date_time_kst.slice(0, 10), o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.candle_acc_trade_price })).reverse();
const todayKST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const PICKS = 'public/research/picks.json';
const TRACK = 'public/research/track.json';
const HORIZONS = [3, 7, 14];

async function main() {
  const tickers = await get('/ticker/all?quote_currencies=KRW');
  const names = Object.fromEntries((await get('/market/all?isDetails=false')).map((m) => [m.market, m.korean_name]));
  const uni = tickers.filter((t) => !STABLES.has(t.market.replace('KRW-', '')) && t.acc_trade_price_24h >= 1e9)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h).map((t) => t.market);
  if (!uni.includes('KRW-BTC')) uni.unshift('KRW-BTC');

  const data = {};
  for (const m of uni) {
    try { data[m] = norm(await get(`/candles/days?market=${m}&count=200`)); } catch {}
    await sleep(130);
  }
  for (const m of Object.keys(data)) if (data[m].at(-1)?.t === todayKST) data[m].pop();

  // 1) 오늘 기록
  const report = read('public/research/report.json', null);
  const proP = report?.modes?.win?.latest?.p || { minScore: 8, tATR: 1, sATR: 2, maxHold: 14, needMarket: true };
  const btc = data['KRW-BTC'];
  const today = [];
  for (const [m, cs] of Object.entries(data)) {
    if (cs.length < 80) continue;
    const last = cs.length - 1;
    for (const strategy of ['breakout', 'pullback']) {
      const { idx, ev } = signalIndexes(cs, { ...DEFAULT_PARAMS, strategy });
      if (idx.includes(last)) today.push({ market: m, name: names[m] || '', strategy, date: cs[last].t, entry: cs[last].c, volRatio: ev[last].volRatio });
    }
    const s = currentSetup(prepare(cs, btc), proP, null);
    if (s && s.kind === 'go') today.push({ market: m, name: names[m] || '', strategy: 'pro', date: cs[last].t, entry: s.ref, stop: s.stop, target: s.target, score: s.score, wild: s.wild });
  }
  const signalDate = btc.at(-1).t;
  const picks = read(PICKS, { days: {} });
  picks.days[signalDate] = { loggedAt: new Date().toISOString(), proParams: proP, universe: Object.keys(data).length, picks: today };
  const keep = Object.keys(picks.days).sort().slice(-90);
  picks.days = Object.fromEntries(keep.map((k) => [k, picks.days[k]]));
  fs.writeFileSync(PICKS, JSON.stringify(picks));

  // 2) 채점: 지난 신호들의 3/7/14일 뒤 수익률 (pro는 손절/목표 도달도)
  const need = new Set();
  for (const d of Object.values(picks.days)) for (const p of d.picks) need.add(p.market);
  for (const m of need) if (!data[m]) { try { data[m] = norm(await get(`/candles/days?market=${m}&count=120`)); } catch {} await sleep(130); }
  const T = Object.fromEntries(tickers.map((t) => [t.market, t.trade_price]));
  const graded = [];
  for (const d of Object.values(picks.days)) for (const p of d.picks) {
    const cs = data[p.market];
    if (!cs) continue;
    const i = cs.findIndex((c) => c.t === p.date);
    const returns = {};
    if (i >= 0) for (const h of HORIZONS) if (cs[i + h]) returns[h] = cs[i + h].c / p.entry - 1;
    let outcome = null;
    if (p.strategy === 'pro' && i >= 0) {
      for (let k = 1; k <= (d.proParams?.maxHold || 14) && cs[i + k]; k++) {
        if (cs[i + k].l <= p.stop) { outcome = { why: '손절', ret: p.stop / p.entry - 1, days: k }; break; }
        if (cs[i + k].h >= p.target) { outcome = { why: '목표', ret: p.target / p.entry - 1, days: k }; break; }
      }
    }
    graded.push({ ...p, returns, outcome, now: T[p.market] ? T[p.market] / p.entry - 1 : null });
  }
  graded.sort((a, b) => (a.date < b.date ? 1 : -1));
  const summary = {};
  for (const s of ['pro', 'breakout', 'pullback']) {
    const g = graded.filter((x) => x.strategy === s);
    const r7 = g.filter((x) => x.returns[7] != null).map((x) => x.returns[7]);
    const done = g.filter((x) => x.outcome);
    summary[s] = {
      n: g.length,
      n7: r7.length, win7: r7.length ? r7.filter((x) => x > 0).length / r7.length : null, avg7: r7.length ? r7.reduce((a, b) => a + b, 0) / r7.length : null,
      closed: done.length, hitTarget: done.filter((x) => x.outcome.why === '목표').length, hitStop: done.filter((x) => x.outcome.why === '손절').length,
    };
  }
  fs.writeFileSync(TRACK, JSON.stringify({ at: new Date().toISOString(), days: keep.length, summary, picks: graded.slice(0, 400) }));
  console.log('signalDate', signalDate, 'today', today.length, 'graded', graded.length, JSON.stringify(summary));
}
main().catch((e) => { console.error(e); process.exit(1); });
