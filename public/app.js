import {
  DEFAULT_PARAMS, HORIZONS, STABLES, backtest, evaluate, normalizeUpbitCandles,
  signalIndexes, splitClosed, todayKST,
} from './lib/strategy.js';
import { TONES, classify } from './lib/analysis.js';

const UNIVERSE = 30;
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  params: { ...DEFAULT_PARAMS },
  names: {},       // KRW-BTC -> 비트코인
  tickers: {},     // 실시간 시세
  data: {},        // market -> candles (마감 + 오늘 진행)
  order: [],
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
    connectLive(state.order);
  } catch (e) {
    load.textContent = `데이터를 불러오지 못했어요: ${e.message}. 잠시 후 새로고침 해보세요.`;
  }
}

// ---------- 지금 상태 ----------
const ORDER = ['breakout', 'pullback', 'pullwait', 'near', 'hot', 'neutral', 'down'];
let filter = 'all';
const cache = {}; // market -> classify 결과

function info(m) {
  const r = classify(state.data[m], state.params);
  if (r) cache[m] = r;
  return r;
}

function pill(r, big = false) {
  return `<span class="pill t-${r.state} ${big ? 'big' : ''}">${r.icon} ${r.label}</span>`;
}

function renderFilters(list) {
  const cnt = { all: list.length };
  list.forEach(({ r }) => { cnt[r.state] = (cnt[r.state] || 0) + 1; });
  const items = [['all', '전체'], ...ORDER.map((k) => [k, `${TONES[k].icon} ${TONES[k].label}`])]
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
  const shown = filter === 'all' ? list : list.filter((x) => x.r.state === filter);
  $('#coinList').innerHTML = shown.map(({ m, r }) => {
    const t = state.tickers[m] || {};
    return `<button type="button" class="coin-row ${state.selected === m ? 'sel' : ''}" data-m="${m}">
      <span class="c-name"><b>${sym(m)}</b><small>${state.names[m] || ''}</small></span>
      <span class="c-state">${pill(r)}${r.action ? `<em>${r.action}</em>` : ''}</span>
      <span class="c-price"><b>${fmtPrice(t.trade_price ?? r.price)}</b>${pct(t.signed_change_rate, 2)}</span>
      <span class="c-reason">${r.reason}</span>
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
  if (!r) return;
  const t = state.tickers[m] || {};
  const p = state.params;
  $('#dTitle').innerHTML = `${sym(m)} <small>${state.names[m] || ''}</small>`;
  $('#dPrice').innerHTML = `${fmtPrice(t.trade_price ?? r.price)}원 ${pct(t.signed_change_rate, 2)}`;
  $('#dPill').innerHTML = `${pill(r, true)}<div class="dact">${r.action}</div>`;
  $('#dReason').textContent = r.reason;

  const gap = (x) => (x ? pctPlain(x / r.price - 1) : '');
  const cell = (k, v, s = '', cls = '') => `<div class="lv ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const res = r.resistances[0], sup = r.supports[0];
  $('#dLevels').innerHTML = [
    cell('위 저항', res ? fmtPrice(res.price) : '없음', res ? `${gap(res.price)} · ${res.touches}번 막힘` : '신고가 구간', 'res'),
    cell('아래 지지', sup ? fmtPrice(sup.price) : '-', sup ? `${gap(sup.price)} · ${sup.touches}번 받침` : '', 'sup'),
    cell('손절 기준', r.stop ? fmtPrice(r.stop) : '-', r.stop ? `${gap(r.stop)}` : '진입 자리 아님', 'stop'),
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
    if (r.stop) cs.createPriceLine({ price: r.stop, color: css('--muted'), lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: '손절' });
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
    const cs = state.data[m];
    if (cs && cs.length) {
      const today = todayKST();
      let last = cs[cs.length - 1];
      if (last.t !== today) { last = { t: today, o: d.opening_price, h: d.high_price, l: d.low_price, c: d.trade_price, v: d.acc_trade_price }; cs.push(last); }
      else Object.assign(last, { h: d.high_price, l: d.low_price, c: d.trade_price, v: d.acc_trade_price });
    }
    dirty = true;
  };
  ws.onclose = () => {
    dot.classList.remove('on'); txt.textContent = '재연결 중…';
    setTimeout(() => connectLive(codes), 3000);
  };
}
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  renderScreen();
}, 2000);

// ---------- 백테스트 ----------
let btDone = false;
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

loadAll();
