import {
  DEFAULT_PARAMS, HORIZONS, STABLES, backtest, evaluate, normalizeUpbitCandles,
  signalIndexes, splitClosed, todayKST,
} from './lib/strategy.js';
import { TONES, classify } from './lib/analysis.js';
import { initCoach, renderCoach } from './coach.js';
import { CHECKS, MAX_SCORE, optimize, prepare, currentSetup } from './lib/pro.js';

const UNIVERSE = 30;
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  params: { ...DEFAULT_PARAMS },
  names: {},       // KRW-BTC -> 비트코인
  tickers: {},     // 실시간 시세
  data: {},        // market -> candles (마감 + 오늘 진행)
  order: [],
  allKRW: [],
  selected: null,
};

// ---------- 공통 ----------
async function api(q) {
  const res = await fetch(`/api/upbit?${new URLSearchParams(q)}`);
  if (!res.ok) throw new Error(`요청 실패 ${res.status}`);
  return res.json();
}
const sym = (m) => m.replace('KRW-', '');
function fmtPrice(p) {
  if (p == null) return '-';
  const d = p >= 1000 ? 0 : p >= 100 ? 1 : p >= 1 ? 2 : 4;
  return p.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pct(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return '<span class="flat">-</span>';
  const cls = x > 0 ? 'up' : x < 0 ? 'down' : 'flat';
  const s = (x > 0 ? '+' : '') + (x * 100).toFixed(digits) + '%';
  return `<span class="${cls}">${s}</span>`;
}
const pctPlain = (x) => (x == null ? '-' : (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------- 탭 / 테마 ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'track') loadTrack();
  if (b.dataset.tab === 'coach') renderCoach();
  if (b.dataset.tab === 'backtest' && !btDone) runBacktest();
}));

try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
$('#themeBtn').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  if (state.selected) drawChart(state.selected);
});

// ---------- 데이터 로딩 ----------
async function loadAll() {
  const load = $('#loadState');
  try {
    const [markets, tickers] = await Promise.all([
      api({ ep: 'markets' }).catch(() => []),
      api({ ep: 'tickers' }),
    ]);
    markets.forEach((m) => { state.names[m.market] = m.korean_name; });
    state.allKRW = markets.map((m) => m.market).filter((m) => m.startsWith('KRW-') && !STABLES.has(sym(m)));
    if (!state.allKRW.length) state.allKRW = tickers.map((t) => t.market);
    fillSearch();
    // 처음 열었을 때 이미 많이 오른 코인은 바로 레이더에 표시
    tickers.forEach((t) => { if (t.signed_change_rate >= SURGE.day) markSurge(t.market, { day: t.signed_change_rate, why: 'day' }); });
    renderRadar();
    tickers.forEach((t) => { state.tickers[t.market] = t; });

    const top = tickers
      .filter((t) => !STABLES.has(sym(t.market)))
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, UNIVERSE)
      .map((t) => t.market);
    $('#universeN').textContent = top.length;

    let done = 0;
    for (let i = 0; i < top.length; i += 4) {
      const part = top.slice(i, i + 4);
      const got = await Promise.all(part.map((m) => api({ ep: 'candles', market: m, count: 200 }).catch(() => null)));
      part.forEach((m, k) => { if (got[k]) state.data[m] = normalizeUpbitCandles(got[k]); });
      done += part.length;
      load.textContent = `일봉 데이터 불러오는 중… ${done}/${top.length}`;
      if (i + 4 < top.length) await sleep(450);
    }
    state.order = top.filter((m) => state.data[m]);
    load.textContent = '';
    load.hidden = true;
    renderScreen();
    const first = state.order.find((m) => ['breakout', 'pullback'].includes(cache[m]?.state)) || state.order[0];
    if (first) select(first);
    connectLive(state.allKRW);
    await loadResearch();
    buildPro();
    renderCoach();
  } catch (e) {
    load.textContent = `데이터를 불러오지 못했어요: ${e.message}. 잠시 후 새로고침 해보세요.`;
  }
}

// ---------- 지금 상태 ----------
const ORDER = ['breakout', 'pullback', 'pullwait', 'near', 'hot', 'neutral', 'down'];
let filter = 'all';
const cache = {}; // market -> classify 결과

function info(m) {
  if (!state.data[m]) return null;
  const r = classify(state.data[m], state.params);
  if (r) cache[m] = r;
  return r;
}

function pill(r, big = false) {
  return `<span class="pill t-${r.state} ${big ? 'big' : ''}">${r.icon} ${r.label}</span>`;
}

function planLine(r) {
  const pl = r.plan;
  if (!pl || pl.none) return '';
  const where = pl.inZone ? '<span class="badge zone">📍 지금 타점 안</span>' : `<span class="flat">현재가 대비 ${pctPlain(pl.dist)}</span>`;
  return `<span class="c-plan"><b>📍 ${pl.kind}</b> ${fmtPrice(pl.low)} ~ ${fmtPrice(pl.high)} ${where}</span>`;
}

function renderFilters(list) {
  const cnt = { all: list.length };
  list.forEach(({ r }) => { cnt[r.state] = (cnt[r.state] || 0) + 1; if (r.plan?.inZone) cnt.zone = (cnt.zone || 0) + 1; });
  const items = [['all', '전체'], ['zone', '📍 타점 안'], ...ORDER.map((k) => [k, `${TONES[k].icon} ${TONES[k].label}`])]
    .filter(([k]) => k === 'all' || cnt[k]);
  $('#filters').innerHTML = items.map(([k, label]) =>
    `<button type="button" class="fchip ${filter === k ? 'on' : ''}" data-f="${k}">${label} <b>${cnt[k] || 0}</b></button>`).join('');
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  renderScreen();
});

function renderScreen() {
  const list = state.order.map((m) => ({ m, r: info(m) })).filter((x) => x.r);
  list.sort((a, b) => (ORDER.indexOf(a.r.state) - ORDER.indexOf(b.r.state)) ||
    ((state.tickers[b.m]?.acc_trade_price_24h || 0) - (state.tickers[a.m]?.acc_trade_price_24h || 0)));
  renderFilters(list);
  const shown = filter === 'all' ? list : filter === 'zone' ? list.filter((x) => x.r.plan?.inZone) : list.filter((x) => x.r.state === filter);
  $('#coinList').innerHTML = shown.map(({ m, r }) => {
    const t = state.tickers[m] || {};
    return `<button type="button" class="coin-row ${state.selected === m ? 'sel' : ''}" data-m="${m}">
      <span class="c-name"><b>${sym(m)}</b><small>${state.names[m] || ''}</small></span>
      <span class="c-state">${pill(r)}${r.action ? `<em>${r.action}</em>` : ''}</span>
      <span class="c-price"><b>${fmtPrice(t.trade_price ?? r.price)}</b>${pct(t.signed_change_rate, 2)}</span>
      <span class="c-reason">${r.reason}</span>
      ${planLine(r)}
    </button>`;
  }).join('') || '<p class="note">해당하는 코인이 없어요.</p>';
  if (state.selected) renderDetail(state.selected, false);
}
$('#coinList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]');
  if (b) select(b.dataset.m, true);
});

function select(m, scroll = false) {
  state.selected = m;
  document.querySelectorAll('.coin-row').forEach((r) => r.classList.toggle('sel', r.dataset.m === m));
  renderDetail(m, true);
  if (scroll && matchMedia('(max-width: 900px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDetail(m, redraw) {
  const r = cache[m] || info(m);
  if (!r) {
    const t = state.tickers[m] || {};
    $('#dTitle').innerHTML = `${sym(m)} <small>${state.names[m] || ''}</small>`;
    $('#dPrice').innerHTML = `${fmtPrice(t.trade_price)}원 ${pct(t.signed_change_rate, 2)}`;
    $('#dPill').innerHTML = '<span class="pill t-neutral big">🆕 데이터 부족</span>';
    $('#dReason').textContent = `상장한 지 얼마 안 돼 일봉이 ${state.data[m]?.length || 0}개뿐이에요. 추세·지지·저항을 판단하려면 최소 ${state.params.maSlow + 10}일이 필요해요. 급등 신규 코인은 변동이 특히 커요.`;
    $('#dPlan').innerHTML = ''; $('#dLevels').innerHTML = ''; $('#dChecks').innerHTML = '';
    if (redraw) drawChart(m, null);
    return;
  }
  const t = state.tickers[m] || {};
  const p = state.params;
  $('#dTitle').innerHTML = `${sym(m)} <small>${state.names[m] || ''}</small>`;
  $('#dPrice').innerHTML = `${fmtPrice(t.trade_price ?? r.price)}원 ${pct(t.signed_change_rate, 2)}`;
  $('#dPill').innerHTML = `${pill(r, true)}<div class="dact">${r.action}</div>`;
  $('#dReason').textContent = r.reason;

  const gap = (x) => (x ? pctPlain(x / r.price - 1) : '');
  const pl = r.plan;
  $('#dPlan').innerHTML = !pl ? '' : pl.none
    ? `<div class="plan-h">📍 예상 매수 타점</div><div class="plan-none">${pl.why}</div>`
    : `<div class="plan-h">📍 예상 매수 타점 · ${pl.kind} ${pl.inZone ? '<span class="badge zone">지금 타점 안</span>' : ''}</div>
       <div class="plan-zone">${fmtPrice(pl.low)} ~ ${fmtPrice(pl.high)}<small>${pl.inZone ? '현재가가 구간 안' : `현재가 대비 ${pctPlain(pl.dist)}`}</small></div>
       <div class="plan-why">${pl.why}</div>
       <div class="plan-row">
         <div><span>손절</span><b>${fmtPrice(pl.stop)}</b><em class="down">${pctPlain(pl.stop / ((pl.low + pl.high) / 2) - 1)}</em></div>
         <div><span>목표</span><b>${pl.target ? fmtPrice(pl.target) : '위 저항 없음'}</b><em class="up">${pl.target ? pctPlain(pl.target / ((pl.low + pl.high) / 2) - 1) : '추세 따라가기'}</em></div>
         <div><span>손익비</span><b>${pl.rr ? '1 : ' + pl.rr.toFixed(1) : '-'}</b><em>${pl.rr == null ? '' : pl.rr >= 2 ? '좋음' : pl.rr >= 1.5 ? '보통' : '불리'}</em></div>
       </div>`;
  const cell = (k, v, s = '', cls = '') => `<div class="lv ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const res = r.resistances[0], sup = r.supports[0];
  $('#dLevels').innerHTML = [
    cell('위 저항', res ? fmtPrice(res.price) : '없음', res ? `${gap(res.price)} · ${res.touches}번 막힘` : '신고가 구간', 'res'),
    cell('아래 지지', sup ? fmtPrice(sup.price) : '-', sup ? `${gap(sup.price)} · ${sup.touches}번 받침` : '', 'sup'),
    cell(`${state.params.maFast}일선`, fmtPrice(r.maF), `현재가가 ${pctPlain(r.ext)} 위치`),
    cell('RSI', r.rsi == null ? '-' : r.rsi.toFixed(0), r.rsi > 70 ? '과열권' : r.rsi < 30 ? '침체권' : '보통'),
  ].join('');

  const c = r.checks;
  const yes = (b) => (b ? '✅' : '⬜');
  $('#dChecks').innerHTML = `
    <div>${yes(c.breakout)} 어제 종가가 직전 ${p.breakoutDays}일 최고가(${fmtPrice(c.prevHigh)}) 위</div>
    <div>${yes(c.trend)} ${p.maFast}일선(${fmtPrice(c.maF)}) &gt; ${p.maSlow}일선(${fmtPrice(c.maS)})</div>
    <div>${yes(c.volume)} 어제 거래대금 평소의 ${c.volRatio.toFixed(1)}배 (기준 ${p.volMult}배)</div>
    <div>20일선 대비 ${pctPlain(r.ext)}${r.stopWhy ? ` · 손절 근거: ${r.stopWhy}` : ''}</div>
    <div>저항 후보: ${r.resistances.map((x) => fmtPrice(x.price)).join(', ') || '없음'} · 지지 후보: ${r.supports.map((x) => fmtPrice(x.price)).join(', ') || '없음'}</div>`;
  if (redraw) drawChart(m, r);
}

// ---------- 차트 ----------
let chart = null;
function drawChart(m, r = cache[m]) {
  const box = $('#chart');
  if (!window.LightweightCharts) { box.textContent = '차트 라이브러리를 불러오지 못했어요.'; return; }
  if (chart) { chart.remove(); chart = null; }
  const candles = state.data[m];
  const p = state.params;
  const up = css('--up'), down = css('--down');
  chart = LightweightCharts.createChart(box, {
    autoSize: true,
    layout: { background: { color: css('--surface') }, textColor: css('--text-2'), fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--border') } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false },
    crosshair: { mode: 0 },
    localization: { priceFormatter: fmtPrice },
  });
  const cs = chart.addCandlestickSeries({
    upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
    priceLineVisible: false,
  });
  cs.setData(candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));

  const ev = evaluate(candles, p);
  const line = (key, color) => {
    const s = chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.setData(candles.map((c, i) => (ev[i] ? { time: c.t, value: ev[i][key] } : null)).filter(Boolean));
  };
  line('maF', css('--ma-fast'));
  line('maS', css('--ma-slow'));

  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(candles.map((c) => ({ time: c.t, value: c.v, color: (c.c >= c.o ? up : down) + '55' })));

  // 지지 / 저항 / 손절 선
  if (r) {
    r.resistances.slice(0, 2).forEach((x, k) => cs.createPriceLine({ price: x.price, color: css('--res'), lineWidth: k ? 1 : 2, lineStyle: 2, axisLabelVisible: true, title: k ? '' : '저항' }));
    r.supports.slice(0, 2).forEach((x, k) => cs.createPriceLine({ price: x.price, color: css('--sup'), lineWidth: k ? 1 : 2, lineStyle: 2, axisLabelVisible: true, title: k ? '' : '지지' }));
    const pl = r.plan;
    if (pl && !pl.none) {
      cs.createPriceLine({ price: pl.high, color: css('--entry'), lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: '타점' });
      cs.createPriceLine({ price: pl.low, color: css('--entry'), lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: '' });
      cs.createPriceLine({ price: pl.stop, color: css('--muted'), lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: '손절' });
    }
  }

  // 신호 표시: 돌파 ▲, 눌림 ●
  const { closed } = splitClosed(candles);
  const bo = signalIndexes(closed, { ...p, strategy: 'breakout' }).idx;
  const pb = signalIndexes(closed, { ...p, strategy: 'pullback' }).idx;
  const marks = [
    ...bo.map((i) => ({ time: closed[i].t, position: 'belowBar', color: css('--up'), shape: 'arrowUp', text: '돌파' })),
    ...pb.map((i) => ({ time: closed[i].t, position: 'belowBar', color: css('--sup'), shape: 'circle', text: '눌림' })),
  ].sort((a, b) => (a.time < b.time ? -1 : 1));
  cs.setMarkers(marks);
  chart.timeScale().setVisibleLogicalRange({ from: candles.length - 90, to: candles.length + 3 });
}

// ---------- 실시간 시세 (업비트 웹소켓) ----------
let ws = null;
let dirty = false;
function connectLive(codes) {
  const dot = $('#liveDot'), txt = $('#liveText');
  try { ws = new WebSocket('wss://api.upbit.com/websocket/v1'); } catch { txt.textContent = '실시간 연결 실패'; return; }
  ws.binaryType = 'blob';
  ws.onopen = () => {
    ws.send(JSON.stringify([{ ticket: 'radar-' + Date.now() }, { type: 'ticker', codes }]));
    dot.classList.add('on'); txt.textContent = '실시간';
  };
  ws.onmessage = async (e) => {
    const d = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text());
    const m = d.code;
    const t = state.tickers[m] || (state.tickers[m] = {});
    t.trade_price = d.trade_price;
    t.signed_change_rate = d.signed_change_rate;
    t.acc_trade_price_24h = d.acc_trade_price_24h;
    trackSurge(m, d);
    const cs = state.data[m];
    if (cs && cs.length) {
      const today = todayKST();
      let last = cs[cs.length - 1];
      if (last.t !== today) { last = { t: today, o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.acc_trade_price }; cs.push(last); }
      else Object.assign(last, { h: d.high_price, l: d.low_price, c: d.trade_price, v: d.acc_trade_price });
      dirty = true;
    }
  };
  ws.onclose = () => {
    dot.classList.remove('on'); txt.textContent = '재연결 중…';
    setTimeout(() => connectLive(codes), 3000);
  };
}
setInterval(() => {
  if (radarDirty) { radarDirty = false; renderRadar(); }
  if (!dirty) return;
  dirty = false;
  renderScreen();
}, 2000);
setInterval(() => { if ($('#tab-coach').classList.contains('active') && state.order.length) renderCoach(); }, 3000);

// ---------- 🚀 급등 레이더 ----------
const SURGE = {
  win: 5 * 60 * 1000,  // 5분 창
  min5: 0.03,          // 5분 사이 +3% 이상
  vol5: 3,             // 5분 거래대금이 평소 5분의 3배 이상
  day: 0.15,           // 또는 오늘(09시 이후) +15% 이상
};
const hist = {};     // market -> [{t, p, acc}]
const surges = {};   // market -> { at, chg5, vol5, day, last }
let radarDirty = false;

function trackSurge(m, d) {
  const now = Date.now();
  const h = hist[m] || (hist[m] = []);
  if (!h.length || now - h[h.length - 1].t >= 5000) h.push({ t: now, p: d.trade_price, acc: d.acc_trade_price });
  while (h.length && now - h[0].t > SURGE.win + 60000) h.shift();
  // 5분 전 기준점 (최소 1분 이상 쌓였을 때만)
  const base = h.find((x) => now - x.t <= SURGE.win) || h[0];
  let chg5 = null, vol5 = null;
  if (base && now - base.t >= 60000) {
    chg5 = d.trade_price / base.p - 1;
    const span = (now - base.t) / 60000;              // 분
    const normal = (d.acc_trade_price_24h / 1440) * span; // 평소 같은 시간 거래대금
    vol5 = normal > 0 ? Math.max(0, d.acc_trade_price - base.acc) / normal : null;
  }
  const fast = chg5 != null && chg5 >= SURGE.min5 && vol5 != null && vol5 >= SURGE.vol5;
  if (fast || d.signed_change_rate >= SURGE.day) {
    markSurge(m, { chg5, vol5, day: d.signed_change_rate, why: fast ? 'fast' : 'day' });
  } else if (surges[m]) {
    surges[m].day = d.signed_change_rate;
    if (chg5 != null) surges[m].chg5 = chg5;
    radarDirty = true;
  }
}

function markSurge(m, x) {
  const cur = surges[m];
  if (!cur) {
    surges[m] = { at: Date.now(), ...x, fast: x.why === 'fast' };
  } else {
    Object.assign(cur, { day: x.day, chg5: x.chg5 ?? cur.chg5, vol5: x.vol5 ?? cur.vol5 });
    if (x.why === 'fast' && !cur.fast) { cur.fast = true; cur.at = Date.now(); }
  }
  radarDirty = true;
}

function renderRadar() {
  const box = $('#radarList');
  if (!box) return;
  $('#radarN').textContent = state.allKRW?.length || 0;
  const list = Object.entries(surges)
    .filter(([, s]) => s.fast || s.day >= SURGE.day)
    .sort((a, b) => (b[1].fast - a[1].fast) || (b[1].at - a[1].at) || (b[1].day - a[1].day))
    .slice(0, 12);
  if (!list.length) {
    box.innerHTML = '<p class="note small">지금은 급등 중인 코인이 없어요. 5분 사이 +3% 이상 오르면서 거래가 평소의 3배 넘게 몰리거나, 오늘 +15% 넘게 오르면 여기에 떠요.</p>';
    return;
  }
  box.innerHTML = list.map(([m, s]) => {
    const tm = new Date(s.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    return `<button type="button" class="rchip ${s.fast ? 'fast' : ''}" data-open="${m}">
      <b>${sym(m)}</b><small>${state.names[m] || ''}</small>
      <span class="rday">${pct(s.day, 1)}</span>
      ${s.chg5 != null ? `<span class="r5">5분 ${pctPlain(s.chg5)}</span>` : ''}
      ${s.vol5 != null && s.fast ? `<span class="r5">거래 ${s.vol5.toFixed(0)}배</span>` : ''}
      <span class="rtime">${s.fast ? '⚡ ' : ''}${tm}</span>
    </button>`;
  }).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (b) openCoin(b.dataset.open);
});

// ---------- 코인 검색 / 목록에 없는 코인 열기 ----------
function fillSearch() {
  $('#coinOptions').innerHTML = state.allKRW
    .map((m) => `<option value="${sym(m)} ${state.names[m] || ''}"></option>`).join('');
}
$('#coinSearch').addEventListener('change', (e) => {
  const q = e.target.value.trim().split(/\s+/)[0].toUpperCase();
  const hit = state.allKRW.find((m) => sym(m) === q) ||
    state.allKRW.find((m) => (state.names[m] || '').includes(e.target.value.trim()));
  if (hit) { openCoin(hit); e.target.value = ''; }
});

async function openCoin(m) {
  document.querySelector('.tab[data-tab="screen"]').click();
  if (!state.data[m]) {
    try {
      state.data[m] = normalizeUpbitCandles(await api({ ep: 'candles', market: m, count: 200 }));
    } catch { alert('데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'); return; }
  }
  if (!state.order.includes(m)) state.order.unshift(m);
  filter = 'all';
  renderScreen();
  select(m, true);
}

// ---------- 백테스트 ----------
let btDone = false;

// ---------- 🏆 프로 전략 ----------
const DEFAULT_PRO = { minScore: 7, tATR: 2, sATR: 1.5, maxHold: 14, needMarket: true };
function proMode() { try { return localStorage.getItem('proMode') || 'win'; } catch { return 'win'; } }

// ---------- 📊 실제 데이터 검증 (GitHub에서 매일 생성) ----------
async function loadResearch() {
  try {
    const res = await fetch('/research/report.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    state.research = await res.json();
  } catch { state.research = null; }
  renderResearch();
}

function renderResearch() {
  const box = $('#researchBox');
  const R = state.research;
  if (!R) { box.innerHTML = '<p class="note">아직 실제 데이터 검증 결과가 없어요.</p>'; return; }
  const f2 = (x) => (x == null ? '-' : x.toFixed(2));
  const mult = (x) => (x == null ? '-' : `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%`);
  const col = (mode, title) => {
    const M = R.modes[mode];
    if (!M) return '';
    const o = M.oos, real = M.real1pct3, nl = M.foldsNoLast;
    return `<div class="rs-col">
      <h4>${title}</h4>
      <div class="rs-grid">
        <div><span>승률</span><b>${pw(o.win)}</b></div>
        <div><span>평균</span><b>${o.avgR >= 0 ? '+' : ''}${f2(o.avgR)}R</b></div>
        <div><span>손익비(PF)</span><b>${f2(o.pf)}</b></div>
        <div><span>거래</span><b>${o.n}회</b></div>
      </div>
      ${real ? `<p class="small">💰 현실 시뮬(1회 위험 1%, 동시 3개까지): 자산 <b>${mult(real.final)}</b> · 최대 낙폭 <b class="down">${(real.mdd * 100).toFixed(0)}%</b></p>` : ''}
      ${nl && nl.n ? `<p class="small">마지막 상승장 구간을 빼면: 승률 ${pw(nl.win)} · 평균 ${nl.avgR >= 0 ? '+' : ''}${f2(nl.avgR)}R (${nl.n}회)</p>` : ''}
      <p class="small flat">지금 조합: ${proWords(M.latest?.p || DEFAULT_PRO)}</p>
    </div>`;
  };
  const M = R.modes.win;
  const folds = M.folds.map((f) => `<tr><td>${f.testFrom.slice(2)}~${f.testTo.slice(5)}</td><td class="num">${f.btcRet == null ? '-' : pct(f.btcRet, 0)}</td>
    ${['win', 'profit'].map((k) => { const x = R.modes[k].folds.find((y) => y.testFrom === f.testFrom); return x && x.test ? `<td class="num">${x.test.n}회 · ${pw(x.test.win)} · ${x.test.avgR >= 0 ? '+' : ''}${f2(x.test.avgR)}R</td>` : '<td class="num flat">쉼</td>'; }).join('')}</tr>`).join('');
  const nlBad = ['win', 'profit'].every((k) => !(R.modes[k].foldsNoLast?.avgR > 0));
  box.innerHTML = `
    <div class="sec-h" style="margin-top:0"><h3>📊 실제 데이터 검증</h3><span class="note small">업비트 ${R.coins}개 코인 · ${R.from} ~ ${R.to} · 수수료+호가차이 포함 · 매일 09:40 갱신 (${new Date(R.generatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})</span></div>
    <p class="note small">150일로 조합을 고르고 <b>처음 보는 다음 50일</b>에 시험하는 걸 반복한 결과예요. 과거에 끼워 맞춘 성적이 아니라 "그때 이 방법을 썼으면" 성적이에요.</p>
    <div class="rs-cols">${col('win', '승률 우선')}${col('profit', '수익 우선')}</div>
    <div class="tablewrap"><table class="grid"><thead><tr><th>시험 구간</th><th class="num">BTC 등락</th><th class="num">승률 우선</th><th class="num">수익 우선</th></tr></thead><tbody>${folds}</tbody></table></div>
    <div class="verdict">${nlBad ? '⚠️ <b>솔직한 결론:</b> 이 전략은 <b>상승장에서 돈을 벌고, 하락장에선 잃어요.</b> 최근 상승장 구간을 빼면 본전 근처예요. 비트코인이 꺾이면 비중을 확 줄이는 게 핵심이에요.' : '✅ 여러 구간에서 고르게 플러스였어요. 그래도 과거 성적이니 작게 시작하세요.'}</div>
    <p class="note small">비교: 같은 코인을 아무 날이나 사서 14일 들고 있었으면 승률 ${pw(R.baseline14.win)}, 평균 ${pct(R.baseline14.avgRet)}. 이 기간 비트코인 ${pct(R.btc.to / R.btc.from - 1, 0)}.</p>
    <details class="checkbox-detail"><summary>트레이딩뷰로 직접 검산하기</summary>
      <p class="small">같은 규칙을 트레이딩뷰 전략 코드로 만들어 뒀어요. <a href="/tradingview/kkanbu.pine" target="_blank">kkanbu.pine</a>을 열어 전체 복사 → 트레이딩뷰 Pine 편집기에 붙여넣기 → 차트에 추가 → 일봉 <code>UPBIT:코인KRW</code> 차트에서 "전략 테스터" 탭을 보세요. 설정값을 위의 '지금 조합'과 맞추면 돼요.</p>
    </details>`;
}

function buildPro(mode = proMode(), days = 130, forceLocal = false) {
  const btc = state.data['KRW-BTC'] ? splitClosed(state.data['KRW-BTC']).closed : null;
  const preps = {};
  for (const m of state.order) {
    const closed = splitClosed(state.data[m]).closed;
    if (closed.length >= 80) preps[m] = prepare(closed, btc);
  }
  const o = optimize(preps, { mode, days });
  const RM = !forceLocal && state.research?.modes?.[mode];
  state.pro = {
    mode, days, preps, range: o.range, ranked: o.ranked,
    params: RM?.latest?.p || (o.best ? o.best.p : DEFAULT_PRO),
    ins: o.best ? o.best.ins : null,
    out: RM ? RM.oos : o.best ? o.best.out : null,
    verified: !!RM,
    fallback: !o.best,
  };
  renderPro();
  return state.pro;
}
state.proSetup = (m) => {
  const pr = state.pro?.preps[m];
  if (!pr) return null;
  return currentSetup(pr, state.pro.params, state.tickers[m]?.trade_price ?? null);
};

const pw = (x) => (x == null ? '-' : Math.round(x * 100) + '%');
function proWords(p) {
  return `${p.needMarket ? '<b>비트코인이 EMA50 위일 때만</b>, ' : ''}점수 <b>${p.minScore}/${MAX_SCORE}</b> 이상 + 추세 정배열 + <b>전일 고가를 양봉으로 넘길 때</b> 매수 → 손절 <b>ATR×${p.sATR}</b> · 목표 <b>ATR×${p.tATR}</b> · 최대 <b>${p.maxHold}일</b> 보유`;
}
function renderPro() {
  const P = state.pro, box = $('#proResult');
  if (!P || !box) return;
  const row = (name, s) => s ? `<tr><td>${name}</td><td class="num">${s.n}</td><td class="num"><b>${pw(s.win)}</b></td><td class="num">${pct(s.avgRet)}</td><td class="num">${s.avgR == null ? '-' : s.avgR.toFixed(2) + 'R'}</td><td class="num">${s.pf == null ? '-' : s.pf.toFixed(2)}</td></tr>` : '';
  const o = P.out;
  const verdict = P.fallback ? '⚠️ 조건(15회 이상 + 기대값 플러스)을 만족하는 조합이 없어서 기본값을 써요. 요즘 장이 전략에 불리하다는 뜻이기도 해요.'
    : !o || o.n < 8 ? '🤔 검증 기간 거래가 너무 적어서 아직 판단하기 일러요.'
    : o.avgR > 0 && o.win >= (P.ins.win - 0.15) ? '✅ 검증 기간에도 통했어요. 그래도 과거 성적이라 소액부터.'
    : o.avgR > 0 ? '🙂 검증 기간에도 플러스지만 승률이 꽤 떨어졌어요. 기대치를 낮춰서 보세요.'
    : '⚠️ 검증 기간에선 마이너스예요. 과거에만 맞았던 조합일 가능성이 커요. 비중을 확 줄이거나 쉬어가세요.';
  box.innerHTML = `
    <div class="pro-best"><div class="k">${P.mode === 'win' ? '승률 우선' : '수익 우선'}으로 고른 조합</div><div class="v">${proWords(P.params)}</div></div>
    <div class="tablewrap"><table class="grid"><thead><tr><th>구간</th><th class="num">거래</th><th class="num">승률</th><th class="num">평균 수익</th><th class="num">평균 R</th><th class="num">손익비(PF)</th></tr></thead>
      <tbody>${row(`고른 기간 ${P.range.start.slice(5)}~${P.range.cut.slice(5)}`, P.ins)}${row(`검증 기간 ${P.range.cut.slice(5)}~${P.range.end.slice(5)}`, P.out)}</tbody></table></div>
    <div class="verdict">${verdict}</div>
    <details class="checkbox-detail"><summary>다른 상위 조합 보기</summary>
      <div class="tablewrap"><table class="grid"><thead><tr><th>조합</th><th class="num">고른 기간 승률</th><th class="num">검증 승률</th><th class="num">검증 평균 R</th><th class="num">검증 거래</th></tr></thead><tbody>${
        P.ranked.map((r) => `<tr><td>점수≥${r.p.minScore} · 손절 ${r.p.sATR} · 목표 ${r.p.tATR} · ${r.p.maxHold}일${r.p.needMarket ? ' · BTC필터' : ''}</td><td class="num">${pw(r.ins.win)}</td><td class="num">${pw(r.out.win)}</td><td class="num">${r.out.avgR == null ? '-' : r.out.avgR.toFixed(2)}</td><td class="num">${r.out.n}</td></tr>`).join('')
      }</tbody></table></div>
      <p class="note small">R = 손절폭 대비 수익. +1R이면 "손절폭만큼 벌었다", -1R이면 "손절에 걸렸다". 평균 R이 플러스여야 오래 하면 자산이 불어요.</p>
    </details>
    <details class="checkbox-detail"><summary>점수 항목 (총 ${MAX_SCORE}점)</summary>
      <ul class="small">${CHECKS.map((c) => `<li><b>${c.label}</b> (${c.w}점) — ${c.desc}</li>`).join('')}</ul>
    </details>`;
}
$('#proForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.order.length) return;
  const f = new FormData(e.target);
  const mode = f.get('mode');
  try { localStorage.setItem('proMode', mode); } catch {}
  buildPro(mode, Number(f.get('days')), true);
  renderCoach();
});
try { const m = localStorage.getItem('proMode'); if (m) $('#proForm [name=mode]').value = m; } catch {}
$('#btForm').addEventListener('submit', (e) => { e.preventDefault(); runBacktest(); });

function runBacktest() {
  if (!state.order.length) { $('#btWarn').hidden = false; $('#btWarn').textContent = '데이터를 불러오는 중이에요. 잠시 후 다시 눌러주세요.'; return; }
  const f = new FormData($('#btForm'));
  const p = { ...state.params };
  for (const [k, v] of f.entries()) p[k] = k === 'strategy' ? v : Number(v);
  const data = {};
  for (const m of state.order) data[m] = splitClosed(state.data[m]).closed;
  const { trades, stats, baseline } = backtest(data, p);
  btDone = true;

  const warn = $('#btWarn');
  if (stats.graded < 30) {
    warn.hidden = false;
    warn.textContent = `채점된 신호가 ${stats.graded}개뿐이에요. 30개 미만이면 우연의 영향이 커서 참고용으로만 보세요.`;
  } else warn.hidden = true;

  const tile = (k, v, s = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const wr = stats.winRate == null ? '-' : Math.round(stats.winRate * 100) + '%';
  $('#btTiles').innerHTML = [
    tile('신호 수', stats.total, `채점 ${stats.graded} · 진행 중 ${stats.pending}`),
    tile(`적중률 (${p.horizon}일 뒤)`, wr, '수익으로 끝난 비율'),
    tile('평균 수익률', pct(stats.avgRet), `중앙값 ${pctPlain(stats.median)}`),
    tile('이길 때 평균', pct(stats.avgWin), `최고 ${pctPlain(stats.best)}`),
    tile('질 때 평균', pct(stats.avgLoss), `최악 ${pctPlain(stats.worst)}`),
    tile('손익비', stats.profitFactor == null ? '-' : stats.profitFactor.toFixed(2), '번 돈 ÷ 잃은 돈 (1 넘으면 이득)'),
  ].join('');

  // 비교: 신호 vs 아무 날이나
  const scale = Math.max(0.05, Math.abs(stats.avgRet || 0), Math.abs(baseline.avg || 0)) * 1.1;
  const bar = (x) => {
    if (x == null) return '<div class="bar"><div class="mid"></div></div>';
    const w = Math.min(50, (Math.abs(x) / scale) * 50);
    const left = x >= 0 ? 50 : 50 - w;
    return `<div class="bar"><div class="fill" style="left:${left}%;width:${w}%;background:var(${x >= 0 ? '--up' : '--down'})"></div><div class="mid"></div></div>`;
  };
  const edge = stats.avgRet != null && baseline.avg != null ? stats.avgRet - baseline.avg : null;
  const verdict = edge == null ? '비교할 신호가 아직 없어요.'
    : edge > 0.02 ? `신호대로 샀을 때가 아무 날이나 샀을 때보다 평균 <b>${(edge * 100).toFixed(1)}%p 더 좋았어요.</b>`
    : edge < -0.02 ? `신호대로 샀을 때가 오히려 <b>${(-edge * 100).toFixed(1)}%p 나빴어요.</b> 조건을 바꿔보세요.`
    : '신호대로 산 것과 아무 날이나 산 것이 <b>거의 비슷해요.</b> 이 기간엔 전략의 힘보다 시장 흐름이 컸어요.';
  $('#btCompare').innerHTML = `
    <div class="row2"><span>신호대로 샀을 때</span>${bar(stats.avgRet)}<span class="num">${pct(stats.avgRet)}</span></div>
    <div class="row2"><span>아무 날이나 샀을 때</span>${bar(baseline.avg)}<span class="num">${pct(baseline.avg)}</span></div>
    <div class="note small">같은 기간, 같은 ${state.order.length}개 코인 · ${p.horizon}일 보유 기준 · 적중률 ${wr} vs ${baseline.winRate == null ? '-' : Math.round(baseline.winRate * 100) + '%'}</div>
    <div class="verdict">${verdict}</div>`;

  $('#btHorizon').innerHTML = `<thead><tr><th>채점 시점</th><th class="num">채점된 신호</th><th class="num">적중률</th><th class="num">평균 수익률</th></tr></thead><tbody>${
    HORIZONS.map((h) => {
      const s = stats.byHorizon[h];
      return `<tr><td>${h}일 뒤</td><td class="num">${s.n}</td><td class="num">${s.winRate == null ? '-' : Math.round(s.winRate * 100) + '%'}</td><td class="num">${pct(s.avg)}</td></tr>`;
    }).join('')}</tbody>`;

  $('#btTrades').innerHTML = `<thead><tr><th>신호일</th><th>코인</th><th class="num">매수가</th><th class="num">거래량</th>${HORIZONS.map((h) => `<th class="num">${h}일 뒤</th>`).join('')}<th class="num">최대 상승</th><th class="num">최대 하락</th></tr></thead><tbody>${
    trades.length ? trades.map((t) => `<tr class="row" data-m="${t.market}">
      <td>${t.date}${t.pending ? '<span class="badge pend">진행 중</span>' : ''}${t.stopped ? '<span class="badge pend">손절</span>' : ''}</td>
      <td class="coin"><b>${sym(t.market)}</b></td>
      <td class="num">${fmtPrice(t.entry)}</td>
      <td class="num">${t.volRatio.toFixed(1)}배</td>
      ${HORIZONS.map((h) => `<td class="num">${t.returns[h] != null ? pct(t.returns[h]) : '<span class="flat">-</span>'}</td>`).join('')}
      <td class="num">${pct(t.maxUp)}</td><td class="num">${pct(t.maxDown)}</td>
    </tr>`).join('') : `<tr><td colspan="9" class="flat">이 조건으로는 기간 안에 신호가 없었어요.</td></tr>`}</tbody>`;
}
$('#btTrades').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-m]');
  if (!tr) return;
  document.querySelector('.tab[data-tab="screen"]').click();
  select(tr.dataset.m);
});

// ---------- 실전 성적표 ----------
async function loadTrack() {
  const tiles = $('#trackTiles'), table = $('#trackTable');
  table.innerHTML = '<tbody><tr><td class="flat">불러오는 중…</td></tr></tbody>';
  try {
    const res = await fetch('/api/track');
    if (!res.ok) throw new Error(res.status);
    const { days, picks } = await res.json();
    if (!picks.length) {
      tiles.innerHTML = '';
      table.innerHTML = `<tbody><tr><td class="flat">아직 기록된 신호가 없어요. 매일 오전 9시 5분에 자동으로 쌓입니다. (기록한 날 ${days}일)</td></tr></tbody>`;
      return;
    }
    const s7 = picks.filter((p) => p.returns[7] != null).map((p) => p.returns[7]);
    const wr = s7.length ? Math.round((s7.filter((x) => x > 0).length / s7.length) * 100) + '%' : '-';
    const avg = s7.length ? s7.reduce((a, b) => a + b, 0) / s7.length : null;
    tiles.innerHTML = `
      <div class="tile"><div class="k">기록한 날</div><div class="v">${days}</div><div class="s">총 신호 ${picks.length}개</div></div>
      <div class="tile"><div class="k">7일 적중률</div><div class="v">${wr}</div><div class="s">채점 ${s7.length}개</div></div>
      <div class="tile"><div class="k">7일 평균 수익률</div><div class="v">${pct(avg)}</div><div class="s">신호일 종가 매수 가정</div></div>`;
    table.innerHTML = `<thead><tr><th>신호일</th><th>코인</th><th>전략</th><th class="num">매수가</th>${HORIZONS.map((h) => `<th class="num">${h}일 뒤</th>`).join('')}<th class="num">지금까지</th></tr></thead><tbody>${
      picks.map((p) => `<tr><td>${p.date}</td><td class="coin"><b>${sym(p.market)}</b></td><td>${p.strategy === 'pullback' ? '🎯 눌림목' : '🔥 돌파'}</td><td class="num">${fmtPrice(p.entry)}</td>${
        HORIZONS.map((h) => `<td class="num">${p.returns[h] != null ? pct(p.returns[h]) : '<span class="flat">대기</span>'}</td>`).join('')
      }<td class="num">${pct(p.now)}</td></tr>`).join('')}</tbody>`;
  } catch (e) {
    tiles.innerHTML = '';
    table.innerHTML = `<tbody><tr><td class="flat">성적표를 불러오지 못했어요 (${e.message}). 넷리파이에 배포된 뒤부터 동작해요.</td></tr></tbody>`;
  }
}

// 화면의 조건 숫자 채우기
document.querySelectorAll('[data-p]').forEach((el) => { el.textContent = state.params[el.dataset.p]; });

initCoach({ state, cache, fmtPrice, pct, pctPlain, sym, openCoin, info, todayKST, CHECKS, MAX_SCORE });
loadAll();
