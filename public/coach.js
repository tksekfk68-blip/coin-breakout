// 🧭 코치: 오늘의 후보 · 내 포지션 · 페이스메이커 · 매매 일지
let C = null; // app.js에서 넘겨주는 도구들
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const journal = { code: null, data: null, savedAt: null, saving: false, error: null };
const RULES = { maxOpen: 3, maxDailyBuys: 2, lossStreak: 2 };

// ---------- 시작 ----------
export function initCoach(ctx) {
  C = ctx;
  try { journal.code = localStorage.getItem('journalCode'); } catch {}
  if (journal.code) loadJournal();
  renderConnect();

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-coach]');
    if (!b) return;
    const act = b.dataset.coach;
    if (act === 'chart') C.openCoin(b.dataset.m);
    if (act === 'buy') openBuy(b.dataset.m);
    if (act === 'sell') openSell(b.dataset.id);
    if (act === 'del') delTrade(b.dataset.id);
    if (act === 'add') openBuy(null);
    if (act === 'connect') connect();
    if (act === 'logout') { journal.code = null; journal.data = null; try { localStorage.removeItem('journalCode'); } catch {} renderConnect(); renderCoach(); }
  });

  $('#buyForm').addEventListener('submit', onBuy);
  $('#sellForm').addEventListener('submit', onSell);
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#buyForm [name=coin]').addEventListener('change', (e) => prefillFromCoin(e.target.value));
  $('#buyForm').addEventListener('input', updateBuyPreview);
}

// ---------- 오늘의 후보 ----------
const WEIGHT = { pullback: 3, near: 2, breakout: 2, pullwait: 1.5, neutral: 1, hot: 0, down: 0 };

function scorePick(r) {
  const pl = r.plan;
  if (!pl || pl.none) return -99;
  let s = WEIGHT[r.state] ?? 0;
  if (r.state === 'breakout' && r.action !== '매수 관심') s -= 1.5; // 추격 위험
  if (r.state === 'neutral' && !r.checks.trend) s -= 1;
  if (pl.inZone) s += 2; else if (pl.dist > -0.03) s += 1; else if (pl.dist < -0.1) s -= 1.5;
  if (pl.rr != null) s += pl.rr >= 2 ? 1.5 : pl.rr >= 1.5 ? 0.5 : pl.rr < 1.2 ? -1 : 0;
  if (r.rsi != null) s += r.rsi > 75 ? -1 : r.rsi >= 40 && r.rsi <= 65 ? 0.5 : 0;
  return s;
}

function coachLine(r) {
  const pl = r.plan;
  const d = C.pctPlain(pl.dist);
  switch (r.state) {
    case 'pullback': return pl.inZone ? '지지선 위에서 반등 확인. 2~3번 나눠 들어가고 손절가부터 정해두기.' : `타점까지 ${d}. 거기까지 오면 다시 보기.`;
    case 'pullwait': return '눌림 자리지만 반등 양봉 전. 하루 더 지켜보기.';
    case 'breakout': return pl.inZone ? '뚫었던 천장을 다시 확인하는 자리. 여기서 버티면 좋은 자리.' : `이미 떠 있어요. 되돌림(${d})까지 기다리는 게 유리.`;
    case 'near': return '아직 사는 자리 아님. 저항을 거래량 실어 뚫는 걸 보고 들어가기.';
    case 'neutral': return pl.inZone ? '지지선 근처. 추세가 강하진 않으니 소액만.' : `지지선(${d})까지 기다리기.`;
    default: return '';
  }
}

function marketMood() {
  const btc = C.state.data['KRW-BTC'] ? (C.cache['KRW-BTC'] || C.info('KRW-BTC')) : null;
  const all = C.state.order.map((m) => C.cache[m]).filter(Boolean);
  const down = all.filter((r) => r.state === 'down').length;
  const hot = all.filter((r) => r.state === 'hot' || (r.state === 'breakout' && r.action !== '매수 관심')).length;
  let icon = '🙂', text = '비트코인 상승 추세 유지. 규칙대로 움직이면 되는 날이에요.';
  if (!btc) { icon = '…'; text = C.state.order.length ? '비트코인 데이터를 못 받아서 시장 분위기는 건너뛸게요.' : '시장 데이터를 불러오는 중이에요.'; }
  else if (btc.state === 'down') { icon = '🧊'; text = '비트코인이 하락 추세예요. 오늘은 비중 작게, 쉬는 것도 전략이에요.'; }
  else if (btc.state === 'hot') { icon = '🔥'; text = '비트코인이 과열권이에요. 알트 추격은 특히 조심.'; }
  else if (!btc.checks.trend) { icon = '🤔'; text = '시장 방향이 애매해요. 확실한 자리만 골라요.'; }
  const extra = [];
  if (all.length && down / all.length >= 0.5) extra.push(`상위 코인 ${all.length}개 중 ${down}개가 하락 추세`);
  if (all.length && hot / all.length >= 0.3) extra.push(`${hot}개가 과열·추격 위험 구간`);
  return { icon, text, extra };
}

// ---------- 페이스메이커 ----------
function nudges() {
  const out = [];
  const t = journal.data?.trades || [];
  const open = t.filter((x) => x.status === 'open');
  const today = C.todayKST();
  const todayBuys = t.filter((x) => x.buyAt && toKST(x.buyAt) === today).length;
  const closed = t.filter((x) => x.status === 'closed').sort((a, b) => (a.sellAt < b.sellAt ? 1 : -1));
  let streak = 0;
  for (const x of closed) { if (x.sellPrice < x.buyPrice) streak++; else break; }

  if (open.length >= RULES.maxOpen) out.push(['warn', `포지션 ${open.length}개 꽉 찼어요. 새로 사기 전에 하나 정리부터.`]);
  if (todayBuys >= RULES.maxDailyBuys) out.push(['warn', `오늘 벌써 ${todayBuys}번 샀어요. 오늘은 여기까지.`]);
  if (streak >= RULES.lossStreak) out.push(['stop', `연속 손절 ${streak}번. 하루 쉬고 머리 식히기.`]);
  const noStop = open.filter((x) => !x.stop).length;
  if (noStop) out.push(['warn', `손절가 없는 포지션 ${noStop}개. 지금 정해두세요.`]);
  const broken = open.filter((x) => x.stop && price(x.market) <= x.stop);
  if (broken.length) out.push(['stop', `${broken.map((x) => C.sym(x.market)).join(', ')} 손절선 아래예요. 계획대로 할지 결정할 때.`]);
  if (journal.data && !out.length) out.push(['ok', open.length ? '규칙 안에서 잘 움직이고 있어요. 계획대로.' : '포지션 없음. 좋은 자리 올 때까지 기다리는 것도 실력이에요.']);
  return out;
}

// ---------- 그리기 ----------
export function renderCoach() {
  if (!C || !$('#tab-coach')) return;
  const mood = marketMood();
  const ng = nudges();
  $('#coachMood').innerHTML = `
    <div class="mood-main"><span class="mood-icon">${mood.icon}</span><div><b>코치 한마디</b><p>${mood.text}${mood.extra.length ? ` <span class="flat">(${mood.extra.join(' · ')})</span>` : ''}</p></div></div>
    ${ng.map(([k, t]) => `<div class="nudge ${k}">${k === 'stop' ? '🛑' : k === 'warn' ? '⚠️' : '✅'} ${t}</div>`).join('')}`;
  renderPicks();
  renderPositions();
  renderHistory();
}

function renderPicks() {
  const box = $('#picks');
  const list = C.state.order
    .map((m) => ({ m, r: C.cache[m] }))
    .filter((x) => x.r && x.r.plan && !x.r.plan.none)
    .map((x) => ({ ...x, s: scorePick(x.r) }))
    .filter((x) => x.s >= 2.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (!C.state.order.length) { box.innerHTML = '<p class="note">데이터 불러오는 중…</p>'; return; }
  if (!list.length) {
    box.innerHTML = '<div class="pick empty">지금은 조건 좋은 자리가 없어요. <b>안 사는 것도 포지션</b>이에요. 🚀 급등 레이더나 "지금 상태" 탭에서 타점 근처 코인을 지켜보세요.</div>';
    return;
  }
  box.innerHTML = list.map(({ m, r }, i) => {
    const pl = r.plan;
    const mid = (pl.low + pl.high) / 2;
    const cur = price(m) ?? r.price;
    return `<div class="pick">
      <div class="pick-h">
        <span class="rank">${i + 1}</span>
        <div class="pick-name"><b>${C.sym(m)}</b><small>${esc(C.state.names[m] || '')}</small></div>
        <span class="pill t-${r.state}">${r.icon} ${r.label}</span>
      </div>
      <div class="pick-now">${C.fmtPrice(cur)}원 · ${pl.inZone ? '<span class="badge zone">📍 지금 타점 안</span>' : `타점까지 <b>${C.pctPlain(pl.dist)}</b>`}</div>
      <div class="pick-grid">
        <div><span>타점</span><b>${C.fmtPrice(pl.low)}~${C.fmtPrice(pl.high)}</b></div>
        <div><span>손절</span><b class="down">${C.fmtPrice(pl.stop)}</b><em>${C.pctPlain(pl.stop / mid - 1)}</em></div>
        <div><span>목표</span><b class="up">${pl.target ? C.fmtPrice(pl.target) : '-'}</b><em>${pl.target ? C.pctPlain(pl.target / mid - 1) : '위 저항 없음'}</em></div>
        <div><span>손익비</span><b>${pl.rr ? '1:' + pl.rr.toFixed(1) : '-'}</b></div>
      </div>
      <p class="pick-coach">🧭 ${coachLine(r)}</p>
      <div class="pick-btns">
        <button type="button" class="ghostbtn" data-coach="chart" data-m="${m}">차트 보기</button>
        <button type="button" class="ghostbtn strong" data-coach="buy" data-m="${m}">샀어요 · 기록</button>
      </div>
    </div>`;
  }).join('');
}

function posStatus(x) {
  const cur = price(x.market);
  if (cur == null) return { k: 'wait', icon: '…', t: '시세 받는 중', d: '' };
  const r = cur / x.buyPrice - 1;
  const days = Math.floor((Date.now() - new Date(x.buyAt).getTime()) / 86400000);
  if (x.stop && cur <= x.stop) return { k: 'stop', icon: '🛑', t: '손절선 이탈', d: '계획한 손절가 아래예요. 계획대로 정리할지 지금 결정하세요.' };
  if (x.target && cur >= x.target) return { k: 'goal', icon: '🎯', t: '목표 도달', d: '절반 익절하고, 나머지는 손절선을 매수가로 올려 지키는 방법도 있어요.' };
  if (x.stop && x.buyPrice > x.stop && (cur - x.stop) / (x.buyPrice - x.stop) < 0.35) return { k: 'warn', icon: '⚠️', t: '손절선 근접', d: `손절가(${C.fmtPrice(x.stop)})까지 ${C.pctPlain(x.stop / cur - 1)}. 미리 마음의 준비.` };
  if (r >= 0.1 && x.stop && x.stop < x.buyPrice) return { k: 'up', icon: '📈', t: '수익 중', d: '손절선을 매수가로 올려서 본전은 지키는 걸 고려해 보세요.' };
  if (days >= 7 && Math.abs(r) < 0.03) return { k: 'idle', icon: '⏳', t: '제자리', d: `${days}일째 제자리예요. 이 돈이 다른 데서 더 일할 수 있는지 재점검.` };
  if (!x.stop) return { k: 'warn', icon: '⚠️', t: '손절가 없음', d: '손절가를 정해두세요. 코치가 지켜볼 수 있어요.' };
  return { k: 'ok', icon: '🙂', t: '순항', d: '계획대로 두세요. 자꾸 보는 것보다 알림이 낫습니다.' };
}

function renderPositions() {
  const box = $('#positions');
  if (!journal.data) { box.innerHTML = '<p class="note">아래에서 일지 코드를 만들면 포지션을 기록하고 코치가 지켜볼 수 있어요.</p>'; return; }
  const open = journal.data.trades.filter((x) => x.status === 'open');
  if (!open.length) { box.innerHTML = '<p class="note">열린 포지션이 없어요.</p>'; return; }
  box.innerHTML = open.map((x) => {
    const cur = price(x.market);
    const r = cur != null ? cur / x.buyPrice - 1 : null;
    const st = posStatus(x);
    const won = x.amount && r != null ? Math.round(x.amount * r) : null;
    // 손절 ~ 목표 막대
    let bar = '';
    if (x.stop && x.target && cur != null && x.target > x.stop) {
      const span = x.target - x.stop;
      const pos = (v) => Math.max(0, Math.min(100, ((v - x.stop) / span) * 100));
      bar = `<div class="pbar"><div class="pbar-track"></div>
        <i class="pbar-buy" style="left:${pos(x.buyPrice)}%"></i>
        <i class="pbar-cur" style="left:${pos(cur)}%"></i></div>
        <div class="pbar-lbl"><span>손절 ${C.fmtPrice(x.stop)}</span><span>매수 ${C.fmtPrice(x.buyPrice)}</span><span>목표 ${C.fmtPrice(x.target)}</span></div>`;
    }
    return `<div class="pos st-${st.k}">
      <div class="pos-h">
        <div><b>${C.sym(x.market)}</b> <small>${esc(C.state.names[x.market] || '')}</small><div class="flat small">${toKST(x.buyAt)} · ${esc(x.reason || '')}</div></div>
        <div class="pos-r">${C.pct(r)}${won != null ? `<small>${won >= 0 ? '+' : ''}${won.toLocaleString('ko-KR')}원</small>` : ''}</div>
      </div>
      <div class="pos-st"><b>${st.icon} ${st.t}</b> ${st.d}</div>
      ${bar}
      <div class="pos-f"><span>매수 ${C.fmtPrice(x.buyPrice)} → 현재 ${C.fmtPrice(cur)}</span>
        <span><button type="button" class="ghostbtn" data-coach="chart" data-m="${x.market}">차트</button>
        <button type="button" class="ghostbtn strong" data-coach="sell" data-id="${x.id}">팔았어요</button></span></div>
    </div>`;
  }).join('');
}

function renderHistory() {
  const tiles = $('#jStats'), table = $('#jHistory');
  if (!journal.data) { tiles.innerHTML = ''; table.innerHTML = ''; return; }
  const closed = journal.data.trades.filter((x) => x.status === 'closed').sort((a, b) => (a.sellAt < b.sellAt ? 1 : -1));
  if (!closed.length) { tiles.innerHTML = ''; table.innerHTML = '<tbody><tr><td class="flat">아직 정리한 매매가 없어요. 팔면 여기에 성적이 쌓여요.</td></tr></tbody>'; return; }
  const rets = closed.map((x) => x.sellPrice / x.buyPrice - 1);
  const wins = rets.filter((r) => r > 0), losses = rets.filter((r) => r <= 0);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const kept = closed.filter((x) => planKept(x).ok).length;
  const won = closed.reduce((s, x) => s + (x.amount ? x.amount * (x.sellPrice / x.buyPrice - 1) : 0), 0);
  const tile = (k, v, s = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  tiles.innerHTML = [
    tile('매매 수', closed.length, `이김 ${wins.length} · 짐 ${losses.length}`),
    tile('승률', Math.round((wins.length / closed.length) * 100) + '%'),
    tile('평균 수익률', C.pct(avg(rets)), `이길 때 ${C.pctPlain(avg(wins))} · 질 때 ${C.pctPlain(avg(losses))}`),
    tile('계획 지킨 비율', Math.round((kept / closed.length) * 100) + '%', '손절가 정하고 지켰는지'),
    tile('누적 손익', won ? `${won >= 0 ? '+' : ''}${Math.round(won).toLocaleString('ko-KR')}원` : '-', '금액 입력한 매매만'),
  ].join('');
  table.innerHTML = `<thead><tr><th>매도일</th><th>코인</th><th>근거</th><th class="num">매수가</th><th class="num">매도가</th><th class="num">수익률</th><th class="num">보유</th><th>계획</th><th></th></tr></thead><tbody>${
    closed.map((x) => {
      const pk = planKept(x);
      const days = Math.max(0, Math.round((new Date(x.sellAt) - new Date(x.buyAt)) / 86400000));
      return `<tr><td>${toKST(x.sellAt)}</td><td class="coin"><b>${C.sym(x.market)}</b></td><td>${esc(x.reason || '')}${x.sellReason ? ` → ${esc(x.sellReason)}` : ''}</td>
        <td class="num">${C.fmtPrice(x.buyPrice)}</td><td class="num">${C.fmtPrice(x.sellPrice)}</td><td class="num">${C.pct(x.sellPrice / x.buyPrice - 1)}</td>
        <td class="num">${days}일</td><td>${pk.ok ? '✅' : '⚠️'} <span class="flat small">${pk.t}</span></td>
        <td><button type="button" class="linkbtn" data-coach="del" data-id="${x.id}" aria-label="삭제">삭제</button></td></tr>`;
    }).join('')}</tbody>`;
}

function planKept(x) {
  if (!x.stop) return { ok: false, t: '손절가 없었음' };
  if (x.sellPrice < x.stop * 0.98) return { ok: false, t: '손절 늦음' };
  return { ok: true, t: x.sellPrice <= x.stop * 1.02 ? '손절 지킴' : x.target && x.sellPrice >= x.target * 0.98 ? '목표 익절' : '계획 안' };
}

// ---------- 일지 연결 ----------
function renderConnect() {
  const box = $('#jConnect');
  if (journal.code) {
    box.innerHTML = `<span>📒 일지 연결됨 <span class="flat small">${journal.error ? '⚠️ ' + esc(journal.error) : journal.saving ? '저장 중…' : journal.savedAt ? '저장됨 ' + new Date(journal.savedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''}</span></span>
      <button type="button" class="linkbtn" data-coach="logout">이 기기에서 연결 끊기</button>`;
  } else {
    box.innerHTML = `<div><b>📒 매매 일지 시작하기</b><p class="note small">나만 아는 <b>일지 코드</b>(6자 이상)를 정하세요. 폰·PC에서 같은 코드를 넣으면 같은 일지가 열려요. 잊어버리면 찾을 수 없으니 메모해 두세요.</p></div>
      <div class="jc-row"><input id="jCode" type="password" placeholder="일지 코드 (6자 이상)" autocomplete="off" /><button type="button" class="primary" data-coach="connect">시작</button></div>`;
  }
}

async function connect() {
  const v = $('#jCode').value.trim();
  if (v.length < 6) { alert('일지 코드는 6자 이상으로 정해주세요.'); return; }
  journal.code = v;
  try { localStorage.setItem('journalCode', v); } catch {}
  await loadJournal();
}

async function loadJournal() {
  try {
    const res = await fetch('/api/journal', { headers: { 'x-journal-code': journal.code } });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    journal.data = await res.json();
    journal.error = null;
  } catch (e) {
    journal.error = '불러오기 실패: ' + e.message;
  }
  renderConnect();
  renderCoach();
}

async function saveJournal() {
  journal.saving = true; renderConnect();
  try {
    const res = await fetch('/api/journal', { method: 'PUT', headers: { 'x-journal-code': journal.code, 'content-type': 'application/json' }, body: JSON.stringify(journal.data) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.status);
    journal.savedAt = j.savedAt; journal.error = null;
  } catch (e) {
    journal.error = '저장 실패: ' + e.message;
  }
  journal.saving = false;
  renderConnect();
}

// ---------- 매수 / 매도 기록 ----------
function openBuy(m) {
  if (!journal.data) { $('#jConnect').scrollIntoView({ behavior: 'smooth' }); $('#jCode')?.focus(); return; }
  const f = $('#buyForm');
  f.reset();
  if (m) {
    f.coin.value = `${C.sym(m)} ${C.state.names[m] || ''}`.trim();
    prefillFromCoin(f.coin.value);
  }
  updateBuyPreview();
  $('#buyDlg').showModal();
}

function findMarket(v) {
  const q = (v || '').trim();
  const s = q.split(/\s+/)[0].toUpperCase();
  return C.state.allKRW.find((m) => C.sym(m) === s) || C.state.allKRW.find((m) => (C.state.names[m] || '') === q) || null;
}

function prefillFromCoin(v) {
  const m = findMarket(v);
  const f = $('#buyForm');
  if (!m) return;
  const cur = price(m);
  if (cur != null) f.price.value = cur;
  const r = C.cache[m];
  const pl = r?.plan;
  if (pl && !pl.none) {
    f.stop.value = +pl.stop.toPrecision(6);
    if (pl.target) f.target.value = +pl.target.toPrecision(6);
    const map = { breakout: '돌파', pullback: '눌림목', pullwait: '눌림목', near: '돌파', neutral: '지지 반등', hot: '급등 추격' };
    f.reason.value = map[r.state] || '기타';
  }
  updateBuyPreview();
}

function updateBuyPreview() {
  const f = $('#buyForm');
  const p = +f.price.value, s = +f.stop.value, t = +f.target.value, amt = +f.amount.value;
  const out = [];
  if (p && s) {
    if (s >= p) out.push('⚠️ 손절가가 매수가보다 높아요.');
    else out.push(`손절까지 <b class="down">${C.pctPlain(s / p - 1)}</b>${amt ? ` (최대 손실 약 ${Math.round(amt * (1 - s / p)).toLocaleString('ko-KR')}원)` : ''}`);
  } else if (p) out.push('⚠️ <b>손절가를 먼저 정하세요.</b> 들어가기 전에 나올 곳부터.');
  if (p && t && s && t > p && s < p) {
    const rr = (t - p) / (p - s);
    out.push(`손익비 <b>1:${rr.toFixed(1)}</b> ${rr < 1.5 ? '— 조금 불리해요' : rr >= 2 ? '— 좋아요' : ''}`);
  }
  const t2 = journal.data?.trades || [];
  if (t2.filter((x) => x.status === 'open').length >= RULES.maxOpen) out.push('⚠️ 이미 포지션이 꽉 찼어요.');
  if (f.reason.value === '급등 추격') out.push('⚠️ 급등 추격은 손절을 더 짧게.');
  $('#buyPreview').innerHTML = out.map((x) => `<div>${x}</div>`).join('');
}

async function onBuy(e) {
  e.preventDefault();
  const f = e.target;
  const m = findMarket(f.coin.value);
  if (!m) { alert('코인을 목록에서 골라주세요. (예: BTC, ETH)'); return; }
  const trade = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    market: m, status: 'open', buyAt: new Date().toISOString(),
    buyPrice: +f.price.value, amount: +f.amount.value || null,
    stop: +f.stop.value || null, target: +f.target.value || null,
    reason: f.reason.value, memo: f.memo.value.trim(),
  };
  if (!trade.buyPrice) { alert('매수가를 넣어주세요.'); return; }
  journal.data.trades.push(trade);
  $('#buyDlg').close();
  renderCoach();
  await saveJournal();
}

function openSell(id) {
  const x = journal.data.trades.find((t) => t.id === id);
  if (!x) return;
  const f = $('#sellForm');
  f.reset();
  f.id.value = id;
  f.price.value = price(x.market) ?? x.buyPrice;
  $('#sellTitle').textContent = `${C.sym(x.market)} 매도 기록`;
  const cur = price(x.market);
  f.why.value = x.stop && cur <= x.stop * 1.02 ? '손절' : x.target && cur >= x.target * 0.98 ? '목표 도달' : '계획 변경';
  $('#sellDlg').showModal();
}

async function onSell(e) {
  e.preventDefault();
  const f = e.target;
  const x = journal.data.trades.find((t) => t.id === f.id.value);
  if (!x) return;
  Object.assign(x, { status: 'closed', sellAt: new Date().toISOString(), sellPrice: +f.price.value, sellReason: f.why.value, sellMemo: f.memo.value.trim() });
  $('#sellDlg').close();
  renderCoach();
  await saveJournal();
}

async function delTrade(id) {
  if (!confirm('이 기록을 지울까요?')) return;
  journal.data.trades = journal.data.trades.filter((t) => t.id !== id);
  renderCoach();
  await saveJournal();
}

// ---------- 도우미 ----------
function price(m) { return C.state.tickers[m]?.trade_price ?? null; }
function toKST(iso) { return new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10); }
