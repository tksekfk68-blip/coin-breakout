// 지지·저항 + 코인별 "지금 상태" 판정
import {
  DEFAULT_PARAMS, evaluate, pullbackStates, rsi, signalIndexes, splitClosed, todayKST,
} from './strategy.js';

/**
 * 지지/저항 가격대 찾기.
 * 최근 lookback일 동안 "봉우리(고점)"와 "골짜기(저점)"를 모아서,
 * 비슷한 가격(±tol)끼리 묶은 뒤 여러 번 부딪힌 가격대를 강한 선으로 봅니다.
 */
export function findLevels(candles, price, { lookback = 120, k = 3, tol = 0.025 } = {}) {
  const cs = candles.slice(-lookback);
  const pts = [];
  for (let i = k; i < cs.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let d = 1; d <= k; d++) {
      if (cs[i - d].h > cs[i].h || cs[i + d].h > cs[i].h) isHigh = false;
      if (cs[i - d].l < cs[i].l || cs[i + d].l < cs[i].l) isLow = false;
    }
    if (isHigh) pts.push({ p: cs[i].h, i });
    if (isLow) pts.push({ p: cs[i].l, i });
  }
  // 최근 끝부분(아직 봉우리 확정 전)의 최고/최저도 후보로
  const tail = cs.slice(-k);
  if (tail.length) {
    pts.push({ p: Math.max(...tail.map((x) => x.h)), i: cs.length - 1 });
  }
  pts.sort((a, b) => a.p - b.p);

  const clusters = [];
  for (const pt of pts) {
    const cl = clusters[clusters.length - 1];
    if (cl && Math.abs(pt.p / cl.price - 1) <= tol) {
      cl.sum += pt.p; cl.n += 1; cl.price = cl.sum / cl.n; cl.last = Math.max(cl.last, pt.i);
    } else {
      clusters.push({ price: pt.p, sum: pt.p, n: 1, last: pt.i });
    }
  }
  const lv = clusters.map((c) => ({ price: c.price, touches: c.n, recent: c.last >= cs.length - 30 }));
  const resistances = lv.filter((x) => x.price > price * 1.005).sort((a, b) => a.price - b.price).slice(0, 3);
  const supports = lv.filter((x) => x.price < price * 0.995).sort((a, b) => b.price - a.price).slice(0, 3);
  return { resistances, supports };
}

export const TONES = {
  breakout: { label: '돌파', icon: '🔥', action: '매수 관심' },
  pullback: { label: '눌림목', icon: '🎯', action: '매수 관심' },
  pullwait: { label: '눌림 대기', icon: '⏳', action: '반등 확인 후' },
  near: { label: '돌파 임박', icon: '👀', action: '지켜보기' },
  hot: { label: '과열', icon: '⚠️', action: '추격 금지' },
  down: { label: '하락 추세', icon: '🧊', action: '관망' },
  neutral: { label: '관망', icon: '⏸', action: '' },
};

const fmt = (x) => {
  if (x == null) return '-';
  const d = x >= 1000 ? 0 : x >= 100 ? 1 : x >= 1 ? 2 : 4;
  return x.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const pc = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * 코인 하나의 지금 상태.
 * allCandles: 마감 캔들 + (있으면) 오늘 진행 중 캔들
 */
export function classify(allCandles, p = DEFAULT_PARAMS, today = todayKST()) {
  const r = classifyCore(allCandles, p, today);
  if (r) r.plan = makePlan(r);
  return r;
}

/**
 * 예상 매수 타점: "이 가격대에 오면 전략 조건에 맞는 자리"
 * 반환: { kind, low, high, why, stop, target, rr, dist, inZone } 또는 { none: true, why }
 */
export function makePlan(r) {
  const price = r.price;
  const nextRes = (above) => r.resistances.find((x) => x.price > above * 1.01)?.price ?? null;
  let kind, low, why;
  switch (r.state) {
    case 'breakout':
      kind = '되돌림 매수'; low = r.ctx.level;
      why = `돌파했던 가격(${fmt(low)})까지 되돌아와 지지받을 때. 뚫린 천장이 바닥이 되는 자리`;
      break;
    case 'pullback':
    case 'pullwait':
      kind = '눌림 매수'; low = r.support;
      why = `${r.ctx.supportKind}(${fmt(low)}) 위에서 버틸 때. ${r.state === 'pullwait' ? '반등 양봉이 나온 뒤가 더 안전' : '어제 반등 확인됨'}`;
      break;
    case 'near': {
      const wall = r.ctx.wall;
      const target = nextRes(wall * 1.03) ?? wall * 1.1;
      const lo = wall * 1.005, hi = wall * 1.03, stop = wall * 0.97;
      return finish({ kind: '돌파 매수', low: lo, high: hi, stop, target,
        why: `저항 ${fmt(wall)}을 거래량 실어 뚫고 올라설 때. 못 뚫으면 사지 않기` });
    }
    case 'hot': {
      const cand = r.supports.find((x) => x.price <= price * 0.95);
      low = Math.max(cand ? cand.price : 0, r.maF);
      kind = '조정 대기';
      why = `급등 뒤라 ${cand && cand.price >= r.maF ? '지지선' : `${r.ctx.maFast}일선`}(${fmt(low)})까지 쉬어갈 때를 기다리기`;
      break;
    }
    case 'neutral': {
      const s0 = r.supports[0];
      if (!s0) return { none: true, why: '아래에 뚜렷한 지지선이 없어요' };
      kind = r.checks.trend ? '지지 매수' : '지지 반등(약함)'; low = s0.price;
      why = `지지 ${fmt(low)}(${s0.touches}번 받침)에서 버틸 때${r.checks.trend ? '' : '. 추세가 약해 소액만'}`;
      break;
    }
    default:
      return { none: true, why: `하락 추세라 타점 없음. ${r.ctx.maSlow}일선(${fmt(r.maS)})을 회복하면 다시 볼게요` };
  }
  const high = low * 1.03;
  const stop = low * 0.97;
  return finish({ kind, low, high, stop, target: nextRes(high), why });

  function finish(pl) {
    const mid = (pl.low + pl.high) / 2;
    pl.rr = pl.target && mid > pl.stop ? (pl.target - mid) / (mid - pl.stop) : null;
    pl.dist = price > pl.high ? pl.high / price - 1 : price < pl.low ? pl.low / price - 1 : 0;
    pl.inZone = price >= pl.low && price <= pl.high;
    return pl;
  }
}

function classifyCore(allCandles, p = DEFAULT_PARAMS, today = todayKST()) {
  const { closed, live } = splitClosed(allCandles, today);
  if (closed.length < p.maSlow + 10) return null;
  const last = closed.length - 1;
  const price = live ? live.c : closed[last].c;
  const bp = { ...p, strategy: 'breakout' };
  const ev = evaluate(closed, bp);
  const e = ev[last];
  const r = rsi(closed.map((x) => x.c))[last];
  const ext = price / e.maF - 1;
  const lv = findLevels(closed, price);
  const res1 = lv.resistances[0] || null;
  const sup1 = lv.supports[0] || null;

  const bo = signalIndexes(closed, bp).idx.filter((i) => last - i <= 2);
  const pbStates = pullbackStates(closed, bp);
  const pb = pbStates[last];

  const base = {
    price, rsi: r, ext, maF: e.maF, maS: e.maS, volRatio: e.volRatio,
    resistances: lv.resistances, supports: lv.supports, checks: e,
    breakoutDates: bo.map((i) => closed[i].t),
    ctx: { maFast: p.maFast, maSlow: p.maSlow },
  };
  const out = (state, reason, extra = {}) => ({ ...base, state, ...TONES[state], reason, ...extra });

  // 1) 최근 2일 안 돌파 신호 (가격이 돌파선 위에 있을 때만)
  if (bo.length) {
    const i = bo[bo.length - 1];
    const level = ev[i].prevHigh;
    if (price >= level * 0.97) {
      const chase = ext > 0.2 || r > 75;
      return out('breakout',
        `${closed[i].t.slice(5).replace('-', '/')} ${p.breakoutDays}일 최고가(${fmt(level)}) 돌파, 거래대금 평소의 ${ev[i].volRatio.toFixed(1)}배` +
          (chase ? `. 다만 20일선보다 ${pc(ext)} 높아 추격은 위험` : ''),
        {
          action: chase ? '분할·소액만' : TONES.breakout.action,
          stop: level * 0.97, stopWhy: `돌파했던 가격 ${fmt(level)} 아래로 3% 이탈`,
          target: res1?.price ?? null,
          ctx: { ...base.ctx, level },
        });
    }
  }
  // 2) 눌림목 (어제 마감 기준)
  if (pb) {
    const why = `돌파 뒤 고점 대비 ${pc(pb.drop)} 조정, ${pb.supportKind} ${fmt(pb.support)} 근처에서 거래량이 줄며 버티는 중`;
    const common = { stop: pb.support * 0.97, stopWhy: `${pb.supportKind} ${fmt(pb.support)} 아래로 3% 이탈`, target: res1?.price ?? null, support: pb.support, ctx: { ...base.ctx, supportKind: pb.supportKind } };
    if (pb.stage === 'bounce') return out('pullback', `${why}. 어제 양봉으로 반등`, common);
    return out('pullwait', `${why}. 아직 반등 양봉 전`, common);
  }
  // 3) 과열
  if (r > 75 || ext > 0.25) {
    return out('hot', `RSI ${r.toFixed(0)} · 20일선보다 ${pc(ext)} 위. 급하게 올라 쉬어갈 가능성이 커요. 눌림을 기다리세요`,
      { stop: null, target: null });
  }
  // 4) 하락 추세
  if (!e.trend && price < e.maS) {
    return out('down', `20일선이 60일선 아래, 가격도 60일선(${fmt(e.maS)}) 아래. 바닥 확인 전까지 관망`, { stop: null, target: null });
  }
  // 5) 돌파 임박: 상승 추세 + 저항까지 3% 이내
  const high20 = Math.max(...closed.slice(-p.breakoutDays).map((x) => x.h));
  const wall = res1 ? Math.min(res1.price, high20 > price ? high20 : Infinity) : (high20 > price ? high20 : null);
  if (e.trend && wall && wall / price - 1 <= 0.03) {
    return out('near', `저항 ${fmt(wall)}까지 ${pc(wall / price - 1)} 남음. 거래량 실린 돌파가 나오는지 확인`,
      { stop: sup1 ? sup1.price * 0.97 : null, stopWhy: sup1 ? `지지 ${fmt(sup1.price)} 아래로 3% 이탈` : '', target: wall, ctx: { ...base.ctx, wall } });
  }
  // 6) 그 외
  const trendTxt = e.trend ? '상승 추세 유지 중이지만 뚜렷한 자리가 아님' : '방향이 애매한 구간';
  return out('neutral', `${trendTxt}${sup1 ? ` · 지지 ${fmt(sup1.price)}` : ''}${res1 ? ` · 저항 ${fmt(res1.price)}` : ''}`,
    { stop: null, target: null });
}
