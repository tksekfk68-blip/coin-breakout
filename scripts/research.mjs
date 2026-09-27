// 실제 업비트 데이터로 전략 검증 (GitHub Actions에서 실행)
// - 원화마켓 중 하루 거래대금 10억 이상 코인, 일봉 최대 400일
// - 수수료 + 호가 차이 반영
// - 롤링 검증: 150일로 조합 고르기 → 바로 다음 50일에 시험, 50일씩 밀면서 반복
// 결과: public/research/report.json (사이트에서 표시)
import fs from 'node:fs';
import { prepare, simulate, stats, currentSetup, GRID, COST_PER_SIDE } from '../public/lib/pro.js';
import { STABLES } from '../public/lib/strategy.js';

const BASE = 'https://api.upbit.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAYS = 400, TRAIN = 150, TEST = 50, MIN_TRAIN_N = 20;

async function get(path, tries = 5) {
  for (let a = 0; a < tries; a++) {
    const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (res.status === 429) { await sleep(1000 * (a + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }
  throw new Error('rate limited ' + path);
}

async function candles(market) {
  let out = [], to = '';
  while (out.length < DAYS) {
    const q = `/candles/days?market=${market}&count=200${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    const raw = await get(q);
    await sleep(130);
    if (!raw.length) break;
    out = out.concat(raw);
    to = raw[raw.length - 1].candle_date_time_utc.replace('T', ' ');
    if (raw.length < 200) break;
  }
  return out
    .map((d) => ({ t: d.candle_date_time_kst.slice(0, 10), o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.candle_acc_trade_price }))
    .sort((a, b) => (a.t < b.t ? -1 : 1))
    .filter((x, i, a) => i === 0 || x.t !== a[i - 1].t);
}

const combos = [];
for (const minScore of GRID.minScore) for (const tATR of GRID.tATR) for (const sATR of GRID.sATR) for (const maxHold of GRID.maxHold) for (const needMarket of GRID.needMarket)
  combos.push({ minScore, tATR, sATR, maxHold, needMarket });

function runAll(preps, p, from, to) {
  const t = [];
  for (const [m, pr] of Object.entries(preps)) for (const x of simulate(pr, p, from, to)) t.push({ ...x, m });
  return t;
}
const key = (mode, s) => (mode === 'win' ? s.win + s.avgR * 0.05 : s.avgR + s.win * 0.05);

/** 1% 위험으로 순서대로 굴렸을 때 자산 곡선 */
function equity(trades, riskPct = 0.01) {
  const done = trades.filter((t) => !t.open).sort((a, b) => (a.t < b.t ? -1 : 1));
  let eq = 1, peak = 1, mdd = 0;
  for (const t of done) {
    eq *= 1 + riskPct * t.R;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
  }
  return { final: eq, mdd };
}

async function main() {
  const t0 = Date.now();
  const tickers = await get('/ticker/all?quote_currencies=KRW');
  const names = Object.fromEntries((await get('/market/all?isDetails=false')).map((m) => [m.market, m.korean_name]));
  const uni = tickers
    .filter((t) => !STABLES.has(t.market.replace('KRW-', '')) && t.acc_trade_price_24h >= 1e9)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .map((t) => t.market);
  if (!uni.includes('KRW-BTC')) uni.unshift('KRW-BTC');

  const data = {};
  for (const m of uni) {
    try { data[m] = await candles(m); } catch (e) { console.log('skip', m, e.message); }
  }
  const todayKST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const m of Object.keys(data)) if (data[m].at(-1)?.t === todayKST) data[m].pop(); // 오늘 미완성 캔들 제외
  const btc = data['KRW-BTC'];
  const preps = {};
  for (const [m, cs] of Object.entries(data)) if (cs.length >= 120) preps[m] = prepare(cs, btc);

  const dates = btc.map((x) => x.t);
  const first = 60; // 지표 준비 기간
  const folds = [];
  for (let s = first; s + TRAIN + 10 <= dates.length; s += TEST) {
    const trainFrom = dates[s], trainTo = dates[s + TRAIN - 1];
    const testFrom = dates[s + TRAIN], testTo = dates[Math.min(dates.length - 1, s + TRAIN + TEST - 1)];
    if (!testFrom) break;
    folds.push({ trainFrom, trainTo, testFrom, testTo });
  }

  const report = { generatedAt: new Date().toISOString(), costPerSide: COST_PER_SIDE, coins: Object.keys(preps).length, from: dates[first], to: dates.at(-1), train: TRAIN, test: TEST, modes: {} };

  for (const mode of ['win', 'profit']) {
    const oos = [], foldRows = [];
    for (const f of folds) {
      let best = null;
      for (const p of combos) {
        const s = stats(runAll(preps, p, f.trainFrom, f.trainTo));
        if (s.n < MIN_TRAIN_N || !(s.avgR > 0)) continue;
        if (!best || key(mode, s) > key(mode, best.s)) best = { p, s };
      }
      const btcFrom = btc.find((x) => x.t >= f.testFrom), btcTo = [...btc].reverse().find((x) => x.t <= f.testTo);
      const btcRet = btcFrom && btcTo ? btcTo.c / btcFrom.c - 1 : null;
      if (!best) { foldRows.push({ ...f, skipped: true, btcRet }); continue; }
      const tt = runAll(preps, best.p, f.testFrom, f.testTo);
      oos.push(...tt);
      const alt = stats(runAll(preps, { ...best.p, needMarket: !best.p.needMarket }, f.testFrom, f.testTo));
      foldRows.push({ ...f, p: best.p, train: best.s, test: stats(tt), alt, btcRet });
    }
    // 최신 조합: 가장 최근 150일로 고름
    const lastFrom = dates[Math.max(first, dates.length - TRAIN)], lastTo = dates.at(-1);
    let latest = null;
    for (const p of combos) {
      const s = stats(runAll(preps, p, lastFrom, lastTo));
      if (s.n < MIN_TRAIN_N || !(s.avgR > 0)) continue;
      if (!latest || key(mode, s) > key(mode, latest.s)) latest = { p, s };
    }
    const setups = latest ? Object.entries(preps)
      .map(([m, pr]) => ({ m, s: currentSetup(pr, latest.p, null) }))
      .filter((x) => x.s && x.s.kind)
      .map(({ m, s }) => ({ m, name: names[m] || '', kind: s.kind, score: s.score, ref: s.ref, stop: s.stop, target: s.target, atrPct: s.atrPct, wild: s.wild }))
      .sort((a, b) => (a.kind === 'go' ? -1 : 1) - (b.kind === 'go' ? -1 : 1) || b.score - a.score)
      : [];
    const oosDone = oos.filter((t) => !t.open);
    const forced = {};
    for (const nm of [false, true]) {
      const all = [];
      for (const f of foldRows) if (f.p) all.push(...runAll(preps, { ...f.p, needMarket: nm }, f.testFrom, f.testTo));
      forced[nm ? 'withMarketFilter' : 'noMarketFilter'] = { ...stats(all), equity1pct: equity(all, 0.01) };
    }
    report.modes[mode] = {
      oos: stats(oos),
      equity1pct: equity(oos, 0.01),
      equity2pct: equity(oos, 0.02),
      forced,
      folds: foldRows,
      latest,
      setups,
      exits: oosDone.reduce((a, t) => { const k = t.why.startsWith('손절') ? '손절' : t.why; a[k] = (a[k] || 0) + 1; return a; }, {}),
      topCoins: Object.entries(oosDone.reduce((a, t) => { (a[t.m] ||= []).push(t.R); return a; }, {}))
        .map(([m, rs]) => ({ m, n: rs.length, avgR: rs.reduce((s, x) => s + x, 0) / rs.length }))
        .sort((a, b) => b.n - a.n).slice(0, 15),
    };
  }
  // 비교 기준: 같은 코인들을 아무 날이나 사서 14일 들고 있었을 때 (비용 포함)
  const base = [];
  for (const pr of Object.values(preps)) {
    const cs = pr.cs;
    for (let i = first; i + 14 < cs.length; i += 3) {
      if (cs[i].t < report.from) continue;
      base.push((cs[i + 14].c * (1 - COST_PER_SIDE)) / (cs[i].c * (1 + COST_PER_SIDE)) - 1);
    }
  }
  report.baseline14 = { n: base.length, win: base.filter((x) => x > 0).length / base.length, avgRet: base.reduce((s, x) => s + x, 0) / base.length };
  report.btc = { from: btc.find((x) => x.t >= report.from)?.c, to: btc.at(-1).c };
  report.seconds = Math.round((Date.now() - t0) / 1000);

  fs.mkdirSync('public/research', { recursive: true });
  fs.writeFileSync('public/research/report.json', JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ coins: report.coins, from: report.from, to: report.to, win: report.modes.win.oos, profit: report.modes.profit.oos, base: report.baseline14 }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
