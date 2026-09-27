import {
  DEFAULT_PARAMS, HORIZONS, STABLES, backtest, evaluate, normalizeUpbitCandles,
  screenMarket, signalIndexes, splitClosed, todayKST,
} from './lib/strategy.js';

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
    const first = state.order.find((m) => rowInfo(m)?.hasSignal) || state.order[0];
    if (first) select(first);
    connectLive(state.order);
  } catch (e) {
    load.textContent = `데이터를 불러오지 못했어요: ${e.message}. 잠시 후 새로고침 해보세요.`;
  }
}

// ---------- 오늘의 신호 ----------
function rowInfo(m) {
  const s = screenMarket(state.data[m], state.params, 3);
  if (!s) return null;
  const yesterday = s.lastEv;
  const liveBreak = s.live && s.live.breakout && s.live.trend;
  return { s, yesterday, liveBreak, hasSignal: s.confirmed.length > 0 };
}

function checks(e) {
  if (!e) return '<span class="flat">-</span>';
  const c = (on, n, title) => `<span class="ck ${on ? 'on' : ''}" title="${title}">${n}</span>`;
  return `<span class="checks">${c(e.breakout, '①', '돌파')}${c(e.trend, '②', '추세')}${c(e.volume, '③', '거래량 ' + e.volRatio.toFixed(1) + '배')}</span>`;
}

function renderScreen() {
  const rows = state.order.map((m) => ({ m, info: rowInfo(m) })).filter((r) => r.info);
  rows.sort((a, b) =>
    (b.info.hasSignal - a.info.hasSignal) ||
    (b.info.liveBreak - a.info.liveBreak) ||
    ((state.tickers[b.m]?.acc_trade_price_24h || 0) - (state.tickers[a.m]?.acc_trade_price_24h || 0)));
  const tb = $('#screenTable tbody');
  tb.innerHTML = rows.map(({ m, info }) => {
    const t = state.tickers[m] || {};
    const sig = info.s.confirmed.at(-1);
    const sigBadge = sig ? `<span class="badge sig" title="${sig.date} 신호">신호 ${sig.date.slice(5).replace('-', '/')}</span>` : '';
    const live = info.s.live;
    const liveCell = !live ? '<span class="flat">-</span>'
      : `${checks(live)}${info.liveBreak ? '<span class="badge live">돌파 중</span>' : ''}`;
    return `<tr class="row ${state.selected === m ? 'sel' : ''}" data-m="${m}">
      <td class="coin"><b>${sym(m)}</b><small>${state.names[m] || ''}</small></td>
      <td class="num" data-f="price">${fmtPrice(t.trade_price)}</td>
      <td class="num col-chg" data-f="chg">${pct(t.signed_change_rate, 2)}</td>
      <td>${checks(info.yesterday)}${sigBadge}</td>
      <td data-f="live">${liveCell}</td>
    </tr>`;
  }).join('');
}
$('#screenTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-m]');
  if (tr) select(tr.dataset.m);
});

function select(m) {
  state.selected = m;
  document.querySelectorAll('#screenTable tr[data-m]').forEach((r) => r.classList.toggle('sel', r.dataset.m === m));
  drawChart(m);
}

// ---------- 차트 ----------
let chart = null;
function drawChart(m) {
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

  const { closed } = splitClosed(candles);
  const { idx } = signalIndexes(closed, p);
  cs.setMarkers(idx.map((i) => ({ time: closed[i].t, position: 'belowBar', color: css('--text'), shape: 'arrowUp', text: '신호' })));
  chart.timeScale().setVisibleLogicalRange({ from: candles.length - 100, to: candles.length + 2 });

  $('#chartTitle').textContent = `${sym(m)} ${state.names[m] || ''}`;
  const info = rowInfo(m);
  const last = info?.yesterday;
  $('#chartInfo').innerHTML = last
    ? `어제 기준 · 직전 ${p.breakoutDays}일 최고가 ${fmtPrice(last.prevHigh)} · 거래대금 평소의 ${last.volRatio.toFixed(1)}배 · 최근 200일간 신호 ${idx.length}회`
    : '';
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
  const sel = state.selected;
  renderScreen();
  if (sel) document.querySelector(`#screenTable tr[data-m="${sel}"]`)?.classList.add('sel');
}, 2000);

// ---------- 백테스트 ----------
let btDone = false;
$('#btForm').addEventListener('submit', (e) => { e.preventDefault(); runBacktest(); });

function runBacktest() {
  if (!state.order.length) { $('#btWarn').hidden = false; $('#btWarn').textContent = '데이터를 불러오는 중이에요. 잠시 후 다시 눌러주세요.'; return; }
  const f = new FormData($('#btForm'));
  const p = { ...state.params };
  for (const [k, v] of f.entries()) p[k] = Number(v);
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
    table.innerHTML = `<thead><tr><th>신호일</th><th>코인</th><th class="num">매수가</th>${HORIZONS.map((h) => `<th class="num">${h}일 뒤</th>`).join('')}<th class="num">지금까지</th></tr></thead><tbody>${
      picks.map((p) => `<tr><td>${p.date}</td><td class="coin"><b>${sym(p.market)}</b></td><td class="num">${fmtPrice(p.entry)}</td>${
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
