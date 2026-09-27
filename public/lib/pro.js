// 프로 지표 + 점수제(컨플루언스) + ATR 백테스트 + 자동 최적화
// 캔들: { t, o, h, l, c, v } 오래된 것 → 최신

// ---------- 지표 ----------
export function ema(a, n) {
  const out = new Array(a.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < a.length; i++) {
    if (i < n - 1) continue;
    if (prev == null) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; prev = s / n; }
    else prev = a[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function smaArr(a, n) {
  const out = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
/** Wilder 평활 */
function wilder(a, n) {
  const out = new Array(a.length).fill(null);
  let prev = null;
  for (let i = 1; i < a.length; i++) {
    if (i < n) continue;
    if (prev == null) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; prev = s / n; }
    else prev = (prev * (n - 1) + a[i]) / n;
    out[i] = prev;
  }
  return out;
}
export function atr(cs, n = 14) {
  const tr = cs.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - cs[i - 1].c), Math.abs(x.l - cs[i - 1].c))));
  return wilder(tr, n);
}
export function adx(cs, n = 14) {
  const pdm = [0], ndm = [0], tr = [cs[0].h - cs[0].l];
  for (let i = 1; i < cs.length; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  const atrW = wilder(tr, n), p = wilder(pdm, n), m = wilder(ndm, n);
  const pdi = p.map((x, i) => (x == null || !atrW[i] ? null : (100 * x) / atrW[i]));
  const ndi = m.map((x, i) => (x == null || !atrW[i] ? null : (100 * x) / atrW[i]));
  const dx = pdi.map((x, i) => (x == null || ndi[i] == null || x + ndi[i] === 0 ? 0 : (100 * Math.abs(x - ndi[i])) / (x + ndi[i])));
  const adxv = wilder(dx, n).map((x, i) => (i < 2 * n ? null : x));
  return { adx: adxv, pdi, ndi };
}
export function macd(c, f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s);
  const line = c.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const start = line.findIndex((x) => x != null);
  const sigArr = new Array(c.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start), sig);
    e.forEach((x, k) => { sigArr[start + k] = x; });
  }
  const hist = line.map((x, i) => (x == null || sigArr[i] == null ? null : x - sigArr[i]));
  return { line, signal: sigArr, hist };
}
export function rsiArr(c, n = 14) {
  const out = new Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
export function obv(cs) {
  const out = [0];
  for (let i = 1; i < cs.length; i++) {
    const d = cs[i].c - cs[i - 1].c;
    out.push(out[i - 1] + (d > 0 ? cs[i].v : d < 0 ? -cs[i].v : 0));
  }
  return out;
}

// ---------- 점수제 ----------
export const CHECKS = [
  { key: 'trend', w: 2, label: '추세 정배열', desc: '가격 > EMA20 > EMA50, EMA50 상승 중' },
  { key: 'adx', w: 1, label: '추세 힘', desc: 'ADX 20 이상 + 매수세(+DI) 우위' },
  { key: 'macd', w: 1, label: '모멘텀', desc: 'MACD 히스토그램 플러스 또는 2일 연속 상승' },
  { key: 'rsi', w: 1, label: 'RSI 적정', desc: 'RSI 45~68 (힘은 있고 과열 아님)' },
  { key: 'obv', w: 1, label: '돈 유입', desc: 'OBV가 20일 평균 위 (사는 돈이 더 많음)' },
  { key: 'rs', w: 1, label: 'BTC보다 강함', desc: '최근 20일 수익률이 비트코인보다 높음' },
  { key: 'market', w: 1, label: '시장 순풍', desc: '비트코인이 EMA50 위' },
  { key: 'notExt', w: 1, label: '안 떠 있음', desc: 'EMA20에서 1.5 ATR 이내 (추격 아님)' },
];
export const MAX_SCORE = CHECKS.reduce((s, c) => s + c.w, 0);

/**
 * 코인 하나의 날짜별 점수·트리거 계산 (한 번만 계산해 두고 최적화에 재사용)
 * btc: 비트코인 캔들 (날짜로 맞춤)
 */
export function prepare(cs, btc) {
  const c = cs.map((x) => x.c);
  const e20 = ema(c, 20), e50 = ema(c, 50);
  const A = atr(cs, 14);
  const D = adx(cs, 14);
  const M = macd(c);
  const R = rsiArr(c, 14);
  const O = obv(cs), Os = smaArr(O, 20);
  const bmap = {};
  if (btc) {
    const bc = btc.map((x) => x.c), be50 = ema(bc, 50);
    btc.forEach((x, i) => { bmap[x.t] = { c: x.c, e50: be50[i], i }; });
    var bArr = btc;
  }
  const rows = cs.map((x, i) => {
    if (i < 60 || e50[i] == null || A[i] == null) return null;
    const b = bmap[x.t];
    const b20 = b && b.i >= 20 ? bArr[b.i - 20].c : null;
    const chk = {
      trend: x.c > e20[i] && e20[i] > e50[i] && e50[i] > e50[i - 5],
      adx: D.adx[i] != null && D.adx[i] >= 20 && D.pdi[i] > D.ndi[i],
      macd: M.hist[i] != null && (M.hist[i] > 0 || (M.hist[i] > M.hist[i - 1] && M.hist[i - 1] > M.hist[i - 2])),
      rsi: R[i] != null && R[i] >= 45 && R[i] <= 68,
      obv: Os[i] != null && O[i] > Os[i],
      rs: b && b20 ? x.c / cs[i - 20].c - 1 > b.c / b20 - 1 : false,
      market: b ? b.c > b.e50 : true,
      notExt: x.c - e20[i] <= 1.5 * A[i],
    };
    const score = CHECKS.reduce((s, k) => s + (chk[k.key] ? k.w : 0), 0);
    const trigger = x.c > cs[i - 1].h && x.c > x.o; // 전일 고가를 양봉으로 넘김 = 다시 출발
    return { i, t: x.t, score, chk, trigger, atr: A[i], e20: e20[i], e50: e50[i], rsi: R[i], adx: D.adx[i] };
  });
  return { cs, rows };
}

// ---------- ATR 청산 백테스트 ----------
/**
 * p: { minScore, tATR, sATR, maxHold }
 * from/to: 신호 날짜 범위 (문자열, 포함)
 * 같은 코인은 포지션이 끝나야 다음 진입. 같은 날 손절·목표 둘 다 닿으면 손절로 봄(보수적).
 */
export function simulate(prep, p, from = '0000', to = '9999') {
  const { cs, rows } = prep;
  const trades = [];
  let busyUntil = -1;
  for (let i = 0; i < cs.length - 1; i++) {
    const r = rows[i];
    if (!r || i <= busyUntil) continue;
    if (r.t < from || r.t > to) continue;
    if (!(r.chk.trend && r.trigger && r.score >= p.minScore)) continue;
    const entry = cs[i].c;
    const stop = entry - p.sATR * r.atr;
    const target = entry + p.tATR * r.atr;
    let exit = null, why = null, k = 1;
    for (; k <= p.maxHold && i + k < cs.length; k++) {
      const d = cs[i + k];
      if (d.l <= stop) { exit = stop; why = '손절'; break; }
      if (d.h >= target) { exit = target; why = '목표'; break; }
    }
    if (exit == null) {
      if (i + p.maxHold < cs.length) { k = p.maxHold; exit = cs[i + k].c; why = '기간 만료'; }
      else { trades.push({ t: r.t, entry, stop, target, open: true }); busyUntil = cs.length; continue; }
    }
    const ret = exit / entry - 1;
    trades.push({ t: r.t, entry, stop, target, exit, why, ret, R: (exit - entry) / (entry - stop), days: k });
    busyUntil = i + k;
  }
  return trades;
}

export function stats(trades) {
  const done = trades.filter((t) => !t.open);
  const n = done.length;
  if (!n) return { n: 0, win: null, avgR: null, avgRet: null, pf: null };
  const wins = done.filter((t) => t.ret > 0);
  const sumW = wins.reduce((s, t) => s + t.ret, 0);
  const sumL = done.filter((t) => t.ret <= 0).reduce((s, t) => s + t.ret, 0);
  return {
    n,
    win: wins.length / n,
    avgR: done.reduce((s, t) => s + t.R, 0) / n,
    avgRet: done.reduce((s, t) => s + t.ret, 0) / n,
    pf: sumL ? sumW / -sumL : null,
    open: trades.length - n,
  };
}

// ---------- 자동 최적화 (앞 기간에서 고르고 뒤 기간에서 검증) ----------
export const GRID = {
  minScore: [6, 7, 8],
  tATR: [1, 1.5, 2, 3],
  sATR: [1, 1.5, 2],
  maxHold: [7, 14],
};

/**
 * preps: { market: prepare() 결과 }
 * mode: 'win' 승률 우선 | 'profit' 수익(기대값) 우선
 * days: 평가 기간(최근 N일). 앞 60%로 고르고 뒤 40%로 검증
 */
export function optimize(preps, { mode = 'win', days = 120, minN = 15 } = {}) {
  const dates = [...new Set(Object.values(preps).flatMap((p) => p.cs.map((x) => x.t)))].sort();
  const end = dates[dates.length - 1];
  const start = dates[Math.max(0, dates.length - days)];
  const cut = dates[Math.max(0, dates.length - Math.round(days * 0.4))];

  const results = [];
  for (const minScore of GRID.minScore)
    for (const tATR of GRID.tATR)
      for (const sATR of GRID.sATR)
        for (const maxHold of GRID.maxHold) {
          const p = { minScore, tATR, sATR, maxHold };
          const ins = [], out = [];
          for (const pr of Object.values(preps)) {
            ins.push(...simulate(pr, p, start, cut));
            out.push(...simulate(pr, p, cut, end));
          }
          results.push({ p, ins: stats(ins), out: stats(out), outTrades: out });
        }
  const ok = (s) => s.n >= minN && s.avgR > 0;
  const key = (s) => (mode === 'win' ? s.win + s.avgR * 0.05 : s.avgR + s.win * 0.05);
  const ranked = results.filter((r) => ok(r.ins)).sort((a, b) => key(b.ins) - key(a.ins));
  const best = ranked[0] || null;
  return { best, ranked: ranked.slice(0, 8), all: results, range: { start, cut, end } };
}

// ---------- 지금 신호 / 대기 후보 ----------
/**
 * prep: prepare() 결과 (마감 캔들만), live: 지금 가격
 * 반환: { kind: 'go'|'ready'|null, row, entry, stop, target, trigger }
 */
export function currentSetup(prep, p, livePrice = null) {
  const { cs, rows } = prep;
  const last = cs.length - 1;
  const r = rows[last];
  if (!r) return null;
  const base = { row: r, score: r.score, atr: r.atr, atrPct: r.atr / cs[last].c };
  let s;
  if (r.chk.trend && r.trigger && r.score >= p.minScore) {
    // 어제 마감에 신호 확정: 손절/목표는 어제 종가 기준으로 고정
    const ref = cs[last].c;
    s = { ...base, kind: 'go', ref, stop: ref - p.sATR * r.atr, target: ref + p.tATR * r.atr, trigger: null };
  } else if (r.chk.trend && r.score >= p.minScore) {
    // 점수는 되는데 트리거 전: 오늘 어제 고가를 넘으면 진입
    const trig = cs[last].h;
    const hit = livePrice != null && livePrice > trig;
    s = { ...base, kind: hit ? 'live' : 'ready', ref: trig, stop: trig - p.sATR * r.atr, target: trig + p.tATR * r.atr, trigger: trig };
  } else {
    return { ...base, kind: null };
  }
  // 지금 가격에 사면 어떻게 되나 (신호 뒤 이미 많이 올랐으면 늦은 자리)
  s.entry = s.kind === 'ready' ? s.ref : (livePrice ?? s.ref);
  s.rr = s.entry > s.stop ? (s.target - s.entry) / (s.entry - s.stop) : null;
  const plannedRR = (s.target - s.ref) / (s.ref - s.stop);
  s.late = s.kind !== 'ready' && (s.entry >= s.target || s.rr == null || s.rr < plannedRR * 0.5);
  s.lateBy = s.entry / s.ref - 1;
  // 변동성이 너무 크면(손절폭 12% 초과) 초보 친화적이지 않음
  s.wild = (s.ref - s.stop) / s.ref > 0.12;
  return s;
}
