// 추세 돌파 전략 + 백테스트 엔진
// 브라우저와 Netlify 함수에서 같이 쓰는 공용 모듈입니다.
//
// 캔들 형식(오래된 것 → 최신 순):
//   { t: 'YYYY-MM-DD', o, h, l, c, v }   v = 하루 거래대금(원)

export const DEFAULT_PARAMS = {
  breakoutDays: 20,   // 최근 N일 최고가를 넘으면 "돌파"
  maFast: 20,         // 단기 이동평균
  maSlow: 60,         // 장기 이동평균
  volDays: 20,        // 거래대금 평균을 낼 기간
  volMult: 2,         // 평균 대비 몇 배 이상이면 "거래량 급증"
  cooldown: 5,        // 같은 코인에서 신호가 연달아 뜨면 N일 동안은 무시
  horizon: 7,         // 신호 후 며칠 뒤 성과로 채점할지
  stopLoss: 0,        // 손절 비율(%) — 0이면 사용 안 함
  periodDays: 60,     // 백테스트 기간(최근 N일)
};

export const HORIZONS = [3, 7, 14];

export const STABLES = new Set([
  'USDT', 'USDC', 'USDE', 'USDS', 'USD1', 'USDG', 'PYUSD', 'RLUSD',
  'EURC', 'JPYC', 'XAUT', 'DAI', 'TUSD',
]);

// ---------- 기본 계산 ----------

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function maxRange(arr, from, to) { // [from, to)
  let m = -Infinity;
  for (let i = from; i < to; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function avgRange(arr, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i];
  return s / (to - from);
}

/** 오늘(KST) 날짜 문자열 */
export function todayKST(now = new Date()) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}

/** 업비트 원본 캔들 → 내부 형식 (오래된 것부터) */
export function normalizeUpbitCandles(raw) {
  return raw
    .map((d) => ({
      t: d.candle_date_time_kst.slice(0, 10),
      o: d.opening_price,
      h: d.high_price,
      l: d.low_price,
      c: d.trade_price,
      v: d.candle_acc_trade_price,
    }))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
}

/** 마지막 캔들이 오늘(아직 마감 전)이면 떼어냄 */
export function splitClosed(candles, today = todayKST()) {
  if (candles.length && candles[candles.length - 1].t === today) {
    return { closed: candles.slice(0, -1), live: candles[candles.length - 1] };
  }
  return { closed: candles, live: null };
}

// ---------- 지표 + 조건 ----------

/**
 * 각 날짜별로 세 가지 조건을 계산.
 * 반환: 날짜별 { breakout, trend, volume, all, prevHigh, maF, maS, volRatio }
 */
export function evaluate(candles, p = DEFAULT_PARAMS) {
  const c = candles.map((x) => x.c);
  const h = candles.map((x) => x.h);
  const v = candles.map((x) => x.v);
  const maF = sma(c, p.maFast);
  const maS = sma(c, p.maSlow);
  const warm = Math.max(p.maSlow, p.breakoutDays, p.volDays);

  return candles.map((_, i) => {
    if (i < warm) return null;
    const prevHigh = maxRange(h, i - p.breakoutDays, i);
    const volAvg = avgRange(v, i - p.volDays, i);
    const volRatio = volAvg > 0 ? v[i] / volAvg : 0;
    const breakout = c[i] > prevHigh;
    const trend = maF[i] != null && maS[i] != null && maF[i] > maS[i];
    const volume = volRatio >= p.volMult;
    return {
      breakout, trend, volume,
      all: breakout && trend && volume,
      prevHigh, maF: maF[i], maS: maS[i], volRatio,
    };
  });
}

/** 신호가 뜬 날짜 인덱스 목록 (쿨다운 적용) */
export function signalIndexes(candles, p = DEFAULT_PARAMS) {
  const ev = evaluate(candles, p);
  const out = [];
  let last = -Infinity;
  ev.forEach((e, i) => {
    if (e && e.all && i - last > p.cooldown) {
      out.push(i);
      last = i;
    }
  });
  return { ev, idx: out };
}

// ---------- 신호 1개 채점 ----------

/**
 * 신호일 종가에 샀다고 가정하고, 이후 성과를 계산.
 * 손절(stopLoss %)이 켜져 있으면 저가가 손절선에 닿는 순간 그 가격에 판 것으로 봄.
 */
export function gradeSignal(candles, i, p = DEFAULT_PARAMS) {
  const entry = candles[i].c;
  const res = { date: candles[i].t, entry, returns: {}, done: {} };
  const stop = p.stopLoss > 0 ? entry * (1 - p.stopLoss / 100) : null;
  let stoppedAt = null;
  let maxUp = 0;
  let maxDown = 0;

  const maxH = Math.max(...HORIZONS, p.horizon);
  for (let k = 1; k <= maxH && i + k < candles.length; k++) {
    const d = candles[i + k];
    if (stoppedAt == null) {
      maxUp = Math.max(maxUp, d.h / entry - 1);
      maxDown = Math.min(maxDown, d.l / entry - 1);
      if (stop != null && d.l <= stop) stoppedAt = k;
    }
    for (const hz of new Set([...HORIZONS, p.horizon])) {
      if (k === hz) {
        res.returns[hz] = stoppedAt != null && stoppedAt <= hz
          ? -p.stopLoss / 100
          : d.c / entry - 1;
        res.done[hz] = true;
      }
    }
    if (k === p.horizon) { res.maxUp = maxUp; res.maxDown = maxDown; }
  }
  // 아직 기간이 안 지난 신호: 현재까지 수익률만 기록
  const lastIdx = candles.length - 1;
  if (!res.done[p.horizon]) {
    res.pending = true;
    res.sofar = stoppedAt != null ? -p.stopLoss / 100 : candles[lastIdx].c / entry - 1;
    res.maxUp = maxUp;
    res.maxDown = maxDown;
  }
  res.stopped = stoppedAt != null && stoppedAt <= p.horizon;
  return res;
}

// ---------- 백테스트 ----------

/**
 * data: { 'KRW-XXX': candles[] (마감된 캔들만) }
 * 기간: 마지막 캔들 기준 최근 periodDays일 안에서 뜬 신호만 집계.
 */
export function backtest(data, p = DEFAULT_PARAMS) {
  const trades = [];
  const baseline = { [p.horizon]: [] };

  for (const [market, candles] of Object.entries(data)) {
    if (!candles || candles.length < p.maSlow + 5) continue;
    const start = Math.max(0, candles.length - p.periodDays);
    const { idx, ev } = signalIndexes(candles, p);
    for (const i of idx) {
      if (i < start) continue;
      const g = gradeSignal(candles, i, p);
      trades.push({ market, ...g, volRatio: ev[i].volRatio });
    }
    // 비교 기준: 같은 기간에 "아무 날이나" 샀을 때의 평균 성과
    for (let i = Math.max(start, p.maSlow); i + p.horizon < candles.length; i++) {
      baseline[p.horizon].push(candles[i + p.horizon].c / candles[i].c - 1);
    }
  }

  trades.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { trades, stats: summarize(trades, p), baseline: summarizeBaseline(baseline[p.horizon]) };
}

export function summarize(trades, p = DEFAULT_PARAMS) {
  const done = trades.filter((t) => !t.pending);
  const rets = done.map((t) => t.returns[p.horizon]);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : null);
  const byH = {};
  for (const hz of HORIZONS) {
    const r = trades.filter((t) => t.done[hz]).map((t) => t.returns[hz]);
    byH[hz] = { n: r.length, winRate: r.length ? r.filter((x) => x > 0).length / r.length : null, avg: mean(r) };
  }
  return {
    total: trades.length,
    graded: done.length,
    pending: trades.length - done.length,
    winRate: done.length ? wins.length / done.length : null,
    avgRet: mean(rets),
    avgWin: mean(wins),
    avgLoss: mean(losses),
    median: rets.length ? [...rets].sort((a, b) => a - b)[Math.floor(rets.length / 2)] : null,
    profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : null,
    worst: rets.length ? Math.min(...rets) : null,
    best: rets.length ? Math.max(...rets) : null,
    byHorizon: byH,
  };
}

function summarizeBaseline(r) {
  if (!r.length) return { n: 0, winRate: null, avg: null };
  return {
    n: r.length,
    winRate: r.filter((x) => x > 0).length / r.length,
    avg: r.reduce((s, x) => s + x, 0) / r.length,
  };
}

// ---------- 오늘의 스크리닝 ----------

/**
 * candles: 마감 캔들 + (선택) 오늘 진행 중인 캔들
 * 반환: { confirmed: 최근 recentDays일 안 확정 신호, live: 오늘 진행 중 상태 }
 */
export function screenMarket(allCandles, p = DEFAULT_PARAMS, recentDays = 3, today = todayKST()) {
  const { closed, live } = splitClosed(allCandles, today);
  if (closed.length < p.maSlow + 1) return null;
  const { ev, idx } = signalIndexes(closed, p);
  const last = closed.length - 1;
  const recent = idx.filter((i) => last - i < recentDays);
  const lastEv = ev[last];

  let liveState = null;
  if (live) {
    const withLive = [...closed, live];
    const e = evaluate(withLive, p)[withLive.length - 1];
    if (e) liveState = { ...e, price: live.c };
  }

  return {
    confirmed: recent.map((i) => ({ date: closed[i].t, close: closed[i].c, volRatio: ev[i].volRatio })),
    lastEv,
    live: liveState,
    lastClose: closed[last].c,
  };
}
