// 🧭 코치 (깐부 모드): 우리 자산 계획 · 오늘의 후보 · 내 포지션 · 매매 일지
let C = null; // app.js에서 넘겨주는 도구들
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (x) => (x == null ? '-' : `${Math.round(x).toLocaleString('ko-KR')}원`);
const wonS = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${Math.round(x).toLocaleString('ko-KR')}원`);
const man = (x) => (x >= 1e8 ? `${(x / 1e8).toFixed(2)}억` : x >= 1e4 ? `${Math.round(x / 1e4).toLocaleString('ko-KR')}만원` : won(x));

const journal = { code: null, data: null, savedAt: null, saving: false, error: null };
const RULES = { maxOpen: 3, maxDailyBuys: 2, lossStreak: 2 };
const DEFAULT_SET = { seed: 0, goalPct: 30, riskPct: 1, maxPosPct: 30 };

// ---------- 시작 ----------
export const journalApi = { get: () => journal.data, save: () => saveJournal() };

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
    if (act === 'plan') openPlan();
    if (act === 'news') document.querySelector('.tab[data-tab="news"]').click();
    if (act === 'logout') { journal.code = null; journal.data = null; try { localStorage.removeItem('journalCode'); } catch {} renderConnect(); renderCoach(); }
  });

  $('#buyForm').addEventListener('submit', onBuy);
  $('#sellForm').addEventListener('submit', onSell);
  $('#planForm').addEventListener('submit', onPlan);
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#buyForm [name=coin]').addEventListener('change', (e) => prefillFromCoin(e.target.value));
  $('#buyForm').addEventListener('input', updateBuyPreview);
}

// ---------- 우리 자산 ----------
function settings() { return { ...DEFAULT_SET, ...(journal.data?.settings || {}) }; }
function price(m) { return C.state.tickers[m]?.trade_price ?? null; }

/** 자산 = 시드 + 실현손익 + 평가손익 (금액 넣은 매매만 계산) */
function wallet() {
  const s = settings();
  const t = journal.data?.trades || [];
  let realized = 0, unreal = 0, invested = 0;
  for (const x of t) {
    if (!x.amount) continue;
    if (x.status === 'closed') realized += x.amount * (x.sellPrice / x.buyPrice - 1);
    else {
      invested += x.amount;
      const p = price(x.market);
      if (p != null) unreal += x.amount * (p / x.buyPrice - 1);
    }
  }
  const equity = s.seed + realized + unreal;
  const cash = s.seed + realized - invested;
  const goal = s.seed * (1 + s.goalPct / 100);
  return { s, realized, unreal, invested, equity, cash, goal, progress: s.seed ? (equity - s.seed) / (goal - s.seed) : 0 };
}

/** 한 번에 얼마 살지: 틀려도 자산의 riskPct%만 잃도록 */
function sizing(entry, stop) {
  const w = wallet();
  if (!w.s.seed || !entry || !stop || stop >= entry) return null;
  const dist = 1 - stop / entry;
  const risk = w.equity * (w.s.riskPct / 100);
  let amt = risk / dist;
  const cap = w.equity * (w.s.maxPosPct / 100);
  let capped = null;
  if (amt > cap) { amt = cap; capped = '1코인 최대 비중'; }
  if (amt > w.cash) { amt = Math.max(0, w.cash); capped = '남은 현금'; }
  amt = Math.floor(amt / 1000) * 1000;
  return { amt, loss: amt * dist, dist, capped, riskPct: w.s.riskPct };
}

function renderPlanCard() {
  const box = $('#planCard');
  if (!journal.data) { box.innerHTML = ''; return; }
  const w = wallet();
  if (!w.s.seed) {
    box.innerHTML = `<div class="plan-card empty"><div><b>💰 우리 자산 계획부터 세우자</b><p class="note small">시드랑 목표를 알려주면, 매번 <b>얼마치 살지</b>까지 같이 계산해 줄게.</p></div>
      <button type="button" class="primary" data-coach="plan">계획 세우기</button></div>`;
    return;
  }
  const prog = Math.max(0, Math.min(1, w.progress));
  const gain = w.equity - w.s.seed;
  box.innerHTML = `<div class="plan-card">
    <div class="pc-top">
      <div><div class="k">우리 자산</div><div class="v">${won(w.equity)}</div>
        <div class="s">시드 ${man(w.s.seed)} 대비 ${C.pct(gain / w.s.seed)} (${wonS(gain)})</div></div>
      <div class="pc-goal"><div class="k">목표 +${w.s.goalPct}%</div><div class="v2">${man(w.goal)}</div>
        <div class="s">${gain >= w.goal - w.s.seed ? '🎉 달성!' : `${man(Math.max(0, w.goal - w.equity))} 남음`}</div></div>
    </div>
    <div class="goalbar"><div style="width:${(prog * 100).toFixed(1)}%"></div></div>
    <div class="pc-row">
      <span>실현 ${wonS(w.realized)}</span><span>평가 ${wonS(w.unreal)}</span><span>현금 ${won(w.cash)}</span>
      <span>1회 최대 손실 ${w.s.riskPct}% ≈ ${won(w.equity * w.s.riskPct / 100)}</span>
      <button type="button" class="linkbtn" data-coach="plan">계획 수정</button>
    </div>
  </div>`;
}

function openPlan() {
  const f = $('#planForm'), s = settings();
  f.seed.value = s.seed || ''; f.goalPct.value = s.goalPct; f.riskPct.value = s.riskPct; f.maxPosPct.value = s.maxPosPct;
  $('#planDlg').showModal();
}
async function onPlan(e) {
  e.preventDefault();
  const f = e.target;
  journal.data.settings = { seed: +f.seed.value || 0, goalPct: +f.goalPct.value || 30, riskPct: +f.riskPct.value || 1, maxPosPct: +f.maxPosPct.value || 30 };
  $('#planDlg').close();
  renderCoach();
  await saveJournal();
}

// ---------- 코치 한마디 ----------
function marketMood() {
  const btc = C.state.data['KRW-BTC'] ? (C.cache['KRW-BTC'] || C.info('KRW-BTC')) : null;
  const P = C.state.pro;
  let icon = '🙂', text = '비트코인 흐름 괜찮아. 우리 규칙대로만 가자.';
  if (!btc) { icon = '…'; text = C.state.order.length ? '비트코인 데이터를 못 받아서 시장 분위기는 건너뛸게.' : '시장 데이터 불러오는 중이야.'; }
  else if (btc.state === 'down') { icon = '🧊'; text = '비트코인이 하락 추세야. 오늘은 조금만, 아니면 쉬자. 현금도 포지션이야.'; }
  else if (btc.state === 'hot') { icon = '🔥'; text = '비트코인이 과열권이야. 알트 따라붙는 건 특히 조심하자.'; }
  else if (!btc.checks.trend) { icon = '🤔'; text = '시장 방향이 애매해. 점수 높은 자리만 골라서 작게 가자.'; }
  const extra = [];
  if (P && P.out && P.out.n >= 8) {
    extra.push(P.out.avgR > 0 ? `요즘 우리 전략 검증 승률 ${Math.round(P.out.win * 100)}%` : '요즘 장에선 우리 전략 성적이 별로야');
  }
  return { icon, text, extra };
}

function nudges() {
  const out = [];
  const t = journal.data?.trades || [];
  const open = t.filter((x) => x.status === 'open');
  const today = C.todayKST();
  const todayBuys = t.filter((x) => x.buyAt && toKST(x.buyAt) === today).length;
  const closed = t.filter((x) => x.status === 'closed').sort((a, b) => (a.sellAt < b.sellAt ? 1 : -1));
  let streak = 0; for (const x of closed) { if (x.sellPrice < x.buyPrice) streak++; else break; }
  let wstreak = 0; for (const x of closed) { if (x.sellPrice > x.buyPrice) wstreak++; else break; }

  const broken = open.filter((x) => x.stop && price(x.market) != null && price(x.market) <= x.stop);
  if (broken.length) out.push(['stop', `${broken.map((x) => C.sym(x.market)).join(', ')} 손절선 아래야. 우리 약속대로 정리하자. 작게 잃는 게 오래 버티는 비결이야.`]);
  const goal = open.filter((x) => x.target && price(x.market) != null && price(x.market) >= x.target);
  if (goal.length) out.push(['good', `${goal.map((x) => C.sym(x.market)).join(', ')} 목표가 도착! 절반은 챙기고 나머지는 손절선을 매수가로 올려두자 🎉`]);
  if (streak >= RULES.lossStreak) out.push(['warn', `연속으로 ${streak}번 손절했네. 괜찮아, 규칙대로 끊은 거야. 오늘은 쉬고 내일 맑은 머리로 보자.`]);
  if (open.length >= RULES.maxOpen) out.push(['warn', `포지션 ${open.length}개면 충분해. 새로 사고 싶으면 제일 약한 거 하나 정리하고 가자.`]);
  if (todayBuys >= RULES.maxDailyBuys) out.push(['warn', `오늘 ${todayBuys}번 샀어. 오늘은 여기까지 하자, 조급하면 지는 게임이야.`]);
  const noStop = open.filter((x) => !x.stop).length;
  if (noStop) out.push(['warn', `손절가 없는 포지션이 ${noStop}개 있어. 지금 같이 정해두자.`]);
  if (wstreak >= 3) out.push(['good', `${wstreak}연승 중! 이럴 때일수록 베팅 크기 그대로 유지하자. 자만이 제일 무서워.`]);
  if (journal.data && !out.length) out.push(['ok', open.length ? '다 계획 안에서 굴러가고 있어. 잘하고 있어 👍' : '지금 포지션 없음. 좋은 자리 올 때까지 기다리는 것도 실력이야.']);
  return out;
}

// ---------- 그리기 ----------
export function renderCoach() {
  if (!C || !$('#tab-coach')) return;
  const mood = marketMood();
  const ng = nudges();
  $('#coachMood').innerHTML = `
    <div class="mood-main"><span class="mood-icon">${mood.icon}</span><div><b>깐부 한마디</b><p>${mood.text}${mood.extra.length ? ` <span class="flat">(${mood.extra.join(' · ')})</span>` : ''}</p></div></div>
    ${ng.map(([k, t]) => `<div class="nudge ${k}">${{ stop: '🛑', warn: '⚠️', good: '🎉', ok: '✅' }[k]} ${t}</div>`).join('')}`;
  const B = C.market?.briefing;
  $('#briefLine').innerHTML = B ? `<button type="button" class="brief-line" data-coach="news">📰 <b>오늘 시황:</b> ${esc(B.title)} <span class="flat">→</span></button>` : '';
  renderPlanCard();
  renderPicks();
  renderPositions();
  renderHistory();
}

// ---------- 오늘의 후보 (프로 점수제) ----------
function renderPicks() {
  const box = $('#picks');
  const P = C.state.pro;
  if (!P) { box.innerHTML = '<p class="note">데이터 불러오는 중…</p>'; return; }
  const ORDER = { go: 0, live: 1, ready: 2 };
  const all = Object.keys(P.preps)
    .map((m) => ({ m, s: C.state.proSetup(m) }))
    .filter((x) => x.s && x.s.kind);
  const late = all.filter((x) => x.s.late);
  const list = all.filter((x) => !x.s.late)
    .sort((a, b) => (a.s.wild - b.s.wild) || (ORDER[a.s.kind] - ORDER[b.s.kind]) || (b.s.score - a.s.score))
    .slice(0, 3);
  const lateHtml = late.length ? `<div class="late-note">🏃 이미 지나간 자리: ${late.map((x) => `<b>${C.sym(x.m)}</b> (신호 뒤 ${C.pctPlain(x.s.lateBy)})`).join(', ')} — 지금 따라 사면 손익비가 안 맞아. 다음 눌림을 기다리자.</div>` : '';
  const stat = P.verified ? P.out : P.out && P.out.n >= 8 ? P.out : P.ins;
  const modeTxt = P.mode === 'win' ? '승률 우선 (목표 짧게·손절 넓게 → 자주 이기지만 한 번 질 때 커)' : '수익 우선 (자주 지지만 이길 때 크게)';
  $('#picksNote').innerHTML = stat ? `${modeTxt} · ${P.verified ? '실제 데이터 검증' : '과거'} 승률 <b>${Math.round(stat.win * 100)}%</b> · 평균 ${stat.avgR >= 0 ? '+' : ''}${stat.avgR.toFixed(2)}R (${stat.n}회${P.verified ? ', 수수료 포함' : ''})` : modeTxt;
  const paused = Object.keys(P.preps).some((m) => C.state.proSetup(m)?.paused);
  if (!list.length && paused) {
    box.innerHTML = `<div class="pick empty">🧊 비트코인이 EMA50 아래라 <b>우리 규칙상 쉬는 구간</b>이야. 하락장에서 잃은 게 이 전략의 약점이었거든. 현금 지키면서 기다리자.</div>${lateHtml}`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="pick empty">오늘은 들어갈 만한 자리가 없어. <b>안 사는 것도 실력</b>이야. 내일 9시에 새로 계산해 볼게.</div>${lateHtml}`;
    return;
  }
  box.innerHTML = list.map(({ m, s }, i) => {
    const r = s.row;
    const cur = price(m);
    const sz = sizing(s.entry, s.stop);
    const head = s.kind === 'go' ? '<span class="pill t-pullback">✅ 진입 신호</span>'
      : s.kind === 'live' ? '<span class="pill t-near">⚡ 돌파 중 · 마감 확인 전</span>'
      : '<span class="pill t-pullwait">⏳ 트리거 대기</span>';
    const wildTxt = s.wild ? ' <b>다만 변동이 커서 손절폭이 넓어</b>. 금액을 작게.' : '';
    const moved = s.kind === 'go' && Math.abs(s.lateBy) >= 0.01 ? ` (신호 종가 ${C.fmtPrice(s.ref)} 대비 지금 ${C.pctPlain(s.lateBy)})` : '';
    const line = s.kind === 'go' ? `어제 전일 고가를 양봉으로 넘겼어. 조건 다 맞았어${moved}.${wildTxt}`
      : s.kind === 'live' ? `지금 어제 고가(${C.fmtPrice(s.trigger)})를 넘는 중이야. <b>아직 사지 마.</b> 장중 돌파는 자주 꺼져. 오전 9시 마감까지 버티면 그때 신호 확정이야.`
      : `오늘 <b>${C.fmtPrice(s.trigger)}</b>(어제 고가)를 넘으면 들어갈 자리야. 알림 걸어두자.${wildTxt}`;
    const chips = C.CHECKS.map((k) => `<span class="ck2 ${r.chk[k.key] ? 'on' : ''}" title="${k.desc}">${k.label}</span>`).join('');
    return `<div class="pick">
      <div class="pick-h">
        <span class="rank">${i + 1}</span>
        <div class="pick-name"><b>${C.sym(m)}</b><small>${esc(C.state.names[m] || '')}</small></div>
        ${head}
      </div>
      <div class="pick-now">${C.fmtPrice(cur ?? s.entry)}원 · 점수 <b>${s.score}/${C.MAX_SCORE}</b></div>
      <div class="chips2">${chips}</div>
      <div class="pick-grid">
        <div><span>진입</span><b>${C.fmtPrice(s.entry)}</b></div>
        <div><span>손절</span><b class="down">${C.fmtPrice(s.stop)}</b><em>${C.pctPlain(s.stop / s.entry - 1)}</em></div>
        <div><span>목표</span><b class="up">${C.fmtPrice(s.target)}</b><em>${C.pctPlain(s.target / s.entry - 1)}</em></div>
        <div><span>손익비</span><b>1:${s.rr.toFixed(1)}</b></div>
      </div>
      <p class="pick-coach">🤝 ${line}${sz ? `<br><b>이번엔 ${man(sz.amt)}어치만 사자.</b> 틀려도 ${won(sz.loss)}(자산의 ${sz.riskPct}%)만 잃어.${sz.capped ? ` <span class="flat small">(${sz.capped} 때문에 줄였어)</span>` : ''}` : journal.data ? '<br><span class="flat small">자산 계획을 세우면 얼마치 살지도 계산해 줄게.</span>' : ''}</p>
      <div class="pick-btns">
        <button type="button" class="ghostbtn" data-coach="chart" data-m="${m}">차트 보기</button>
        <button type="button" class="ghostbtn strong" data-coach="buy" data-m="${m}">샀어 · 기록</button>
      </div>
    </div>`;
  }).join('') + lateHtml;
}

// ---------- 내 포지션 ----------
function posStatus(x) {
  const cur = price(x.market);
  if (cur == null) return { k: 'wait', icon: '…', t: '시세 받는 중', d: '' };
  const r = cur / x.buyPrice - 1;
  const days = Math.floor((Date.now() - new Date(x.buyAt).getTime()) / 86400000);
  if (x.stop && cur <= x.stop) return { k: 'stop', icon: '🛑', t: '손절선 이탈', d: '약속한 자리야. 정리하고 다음 기회 보자. 작게 지는 게 이기는 법이야.' };
  if (x.target && cur >= x.target) return { k: 'goal', icon: '🎯', t: '목표 도착', d: '잘했어! 절반 익절 + 나머지는 손절선을 매수가로 올려서 공짜로 태우자.' };
  if (x.stop && x.buyPrice > x.stop && (cur - x.stop) / (x.buyPrice - x.stop) < 0.35) return { k: 'warn', icon: '⚠️', t: '손절선 가까움', d: `손절가(${C.fmtPrice(x.stop)})까지 ${C.pctPlain(x.stop / cur - 1)}. 닿으면 미련 없이.` };
  if (r >= 0.1 && x.stop && x.stop < x.buyPrice) return { k: 'up', icon: '📈', t: '수익 중', d: '손절선을 매수가로 올려두자. 이제 이 판은 잃을 수 없는 판이 돼.' };
  if (days >= 7 && Math.abs(r) < 0.03) return { k: 'idle', icon: '⏳', t: '제자리', d: `${days}일째 제자리야. 이 돈이 다른 데서 더 일할 수 있는지 같이 보자.` };
  if (!x.stop) return { k: 'warn', icon: '⚠️', t: '손절가 없음', d: '손절가 정해두자. 그래야 내가 대신 지켜봐 줄 수 있어.' };
  return { k: 'ok', icon: '🙂', t: '순항', d: '계획대로 두자. 자꾸 들여다보면 손이 먼저 나가.' };
}

function renderPositions() {
  const box = $('#positions');
  if (!journal.data) { box.innerHTML = '<p class="note">아래에서 일지 코드를 만들면 같이 포지션을 지켜볼 수 있어.</p>'; return; }
  const open = journal.data.trades.filter((x) => x.status === 'open');
  if (!open.length) { box.innerHTML = '<p class="note">열린 포지션 없음.</p>'; return; }
  box.innerHTML = open.map((x) => {
    const cur = price(x.market);
    const r = cur != null ? cur / x.buyPrice - 1 : null;
    const st = posStatus(x);
    const pnl = x.amount && r != null ? x.amount * r : null;
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
        <div><b>${C.sym(x.market)}</b> <small>${esc(C.state.names[x.market] || '')}</small><div class="flat small">${toKST(x.buyAt)} · ${esc(x.reason || '')}${x.amount ? ` · ${man(x.amount)}` : ''}</div></div>
        <div class="pos-r">${C.pct(r)}${pnl != null ? `<small>${wonS(pnl)}</small>` : ''}</div>
      </div>
      <div class="pos-st"><b>${st.icon} ${st.t}</b> ${st.d}</div>
      ${bar}
      <div class="pos-f"><span>매수 ${C.fmtPrice(x.buyPrice)} → 지금 ${C.fmtPrice(cur)}</span>
        <span><button type="button" class="ghostbtn" data-coach="chart" data-m="${x.market}">차트</button>
        <button type="button" class="ghostbtn strong" data-coach="sell" data-id="${x.id}">팔았어</button></span></div>
    </div>`;
  }).join('');
}

// ---------- 매매 일지 ----------
function renderHistory() {
  const tiles = $('#jStats'), table = $('#jHistory');
  if (!journal.data) { tiles.innerHTML = ''; table.innerHTML = ''; return; }
  const closed = journal.data.trades.filter((x) => x.status === 'closed').sort((a, b) => (a.sellAt < b.sellAt ? 1 : -1));
  if (!closed.length) { tiles.innerHTML = ''; table.innerHTML = '<tbody><tr><td class="flat">아직 정리한 매매가 없어. 팔면 여기에 우리 성적이 쌓여.</td></tr></tbody>'; return; }
  const rets = closed.map((x) => x.sellPrice / x.buyPrice - 1);
  const wins = rets.filter((r) => r > 0), losses = rets.filter((r) => r <= 0);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const kept = closed.filter((x) => planKept(x).ok).length;
  const realized = closed.reduce((s, x) => s + (x.amount ? x.amount * (x.sellPrice / x.buyPrice - 1) : 0), 0);
  const tile = (k, v, s = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  tiles.innerHTML = [
    tile('매매 수', closed.length, `이김 ${wins.length} · 짐 ${losses.length}`),
    tile('승률', Math.round((wins.length / closed.length) * 100) + '%'),
    tile('평균 수익률', C.pct(avg(rets)), `이길 때 ${C.pctPlain(avg(wins))} · 질 때 ${C.pctPlain(avg(losses))}`),
    tile('약속 지킨 비율', Math.round((kept / closed.length) * 100) + '%', '손절가 정하고 지켰는지'),
    tile('실현 손익', realized ? wonS(realized) : '-', '금액 넣은 매매만'),
  ].join('');
  table.innerHTML = `<thead><tr><th>매도일</th><th>코인</th><th>근거</th><th class="num">매수가</th><th class="num">매도가</th><th class="num">수익률</th><th class="num">손익</th><th class="num">보유</th><th>약속</th><th></th></tr></thead><tbody>${
    closed.map((x) => {
      const pk = planKept(x);
      const days = Math.max(0, Math.round((new Date(x.sellAt) - new Date(x.buyAt)) / 86400000));
      return `<tr><td>${toKST(x.sellAt)}</td><td class="coin"><b>${C.sym(x.market)}</b></td><td>${esc(x.reason || '')}${x.sellReason ? ` → ${esc(x.sellReason)}` : ''}</td>
        <td class="num">${C.fmtPrice(x.buyPrice)}</td><td class="num">${C.fmtPrice(x.sellPrice)}</td><td class="num">${C.pct(x.sellPrice / x.buyPrice - 1)}</td>
        <td class="num">${x.amount ? wonS(x.amount * (x.sellPrice / x.buyPrice - 1)) : '-'}</td>
        <td class="num">${days}일</td><td>${pk.ok ? '✅' : '⚠️'} <span class="flat small">${pk.t}</span></td>
        <td><button type="button" class="linkbtn" data-coach="del" data-id="${x.id}">삭제</button></td></tr>`;
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
    box.innerHTML = `<div><b>📒 우리 매매 일지 시작하기</b><p class="note small">나만 아는 <b>일지 코드</b>(6자 이상)를 정해줘. 폰·PC에서 같은 코드를 넣으면 같은 일지가 열려. 잊으면 못 찾으니까 꼭 메모해 둬.</p></div>
      <div class="jc-row"><input id="jCode" type="password" placeholder="일지 코드 (6자 이상)" autocomplete="off" /><button type="button" class="primary" data-coach="connect">시작</button></div>`;
  }
}

async function connect() {
  const v = $('#jCode').value.trim();
  if (v.length < 6) { alert('일지 코드는 6자 이상으로 정해줘.'); return; }
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
  const ps = C.state.proSetup?.(m);
  if (ps && ps.kind && !ps.late) {
    f.stop.value = +ps.stop.toPrecision(6);
    f.target.value = +ps.target.toPrecision(6);
    f.reason.value = '프로 점수';
  } else {
    const pl = C.cache[m]?.plan;
    if (pl && !pl.none) {
      f.stop.value = +pl.stop.toPrecision(6);
      if (pl.target) f.target.value = +pl.target.toPrecision(6);
      const map = { breakout: '돌파', pullback: '눌림목', pullwait: '눌림목', near: '돌파', neutral: '지지 반등', hot: '급등 추격' };
      f.reason.value = map[C.cache[m].state] || '기타';
    }
  }
  const sz = sizing(+f.price.value, +f.stop.value);
  if (sz) f.amount.value = sz.amt;
  updateBuyPreview();
}

function updateBuyPreview() {
  const f = $('#buyForm');
  const p = +f.price.value, s = +f.stop.value, t = +f.target.value, amt = +f.amount.value;
  const out = [];
  const w = journal.data ? wallet() : null;
  if (p && s) {
    if (s >= p) out.push('⚠️ 손절가가 매수가보다 높아.');
    else {
      const loss = amt ? amt * (1 - s / p) : null;
      out.push(`손절까지 <b class="down">${C.pctPlain(s / p - 1)}</b>${loss ? ` → 틀리면 <b>${won(loss)}</b> 잃어${w && w.s.seed ? ` (자산의 ${((loss / w.equity) * 100).toFixed(1)}%)` : ''}` : ''}`);
      const sz = sizing(p, s);
      if (sz && amt && amt > sz.amt * 1.2) out.push(`⚠️ 우리 규칙상 적정은 <b>${man(sz.amt)}</b>이야. 조금 많아.`);
    }
  } else if (p) out.push('⚠️ <b>손절가부터 정하자.</b> 들어가기 전에 나올 곳부터.');
  if (p && t && s && t > p && s < p) {
    const rr = (t - p) / (p - s);
    out.push(`손익비 <b>1:${rr.toFixed(1)}</b> ${rr < 1.5 ? '— 좀 불리해' : rr >= 2 ? '— 좋아' : ''}`);
  }
  if (journal.data && journal.data.trades.filter((x) => x.status === 'open').length >= RULES.maxOpen) out.push('⚠️ 이미 포지션이 꽉 찼어.');
  if (f.reason.value === '급등 추격') out.push('⚠️ 급등 추격이면 손절은 더 짧게, 금액은 더 작게.');
  $('#buyPreview').innerHTML = out.map((x) => `<div>${x}</div>`).join('');
}

async function onBuy(e) {
  e.preventDefault();
  const f = e.target;
  const m = findMarket(f.coin.value);
  if (!m) { alert('코인을 목록에서 골라줘. (예: BTC, ETH)'); return; }
  const trade = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    market: m, status: 'open', buyAt: new Date().toISOString(),
    buyPrice: +f.price.value, amount: +f.amount.value || null,
    stop: +f.stop.value || null, target: +f.target.value || null,
    reason: f.reason.value, memo: f.memo.value.trim(),
  };
  if (!trade.buyPrice) { alert('매수가를 넣어줘.'); return; }
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
  if (!confirm('이 기록 지울까?')) return;
  journal.data.trades = journal.data.trades.filter((t) => t.id !== id);
  renderCoach();
  await saveJournal();
}

function toKST(iso) { return new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10); }
