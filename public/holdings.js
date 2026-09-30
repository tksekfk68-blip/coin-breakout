// 📌 내 보유 코인: 하루 4번 차트 분석(analyze.json) + 실시간 가격으로 상태·알림
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RAW = 'https://raw.githubusercontent.com/tksekfk68-blip/coin-breakout/main';

let C = null;
let A = null;          // analyze.json
const zones = {};      // market -> 마지막으로 본 구간 (알림용)

export function initHoldings(ctx) {
  C = ctx;
  loadAnalysis();
  setInterval(loadAnalysis, 20 * 60 * 1000);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hold]');
    if (!b) return;
    if (b.dataset.hold === 'edit') openEdit(b.dataset.m);
    if (b.dataset.hold === 'notify') askNotify();
  });
  $('#holdForm').addEventListener('submit', onSave);
}

async function loadAnalysis() {
  try {
    const r = await fetch(`${RAW}/public/research/analyze.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) A = await r.json();
  } catch {}
  renderHoldings();
}

// 실시간 가격으로 지금 구간 판단
function zoneOf(x, p) {
  if (p > x.upKey) return { k: 'up', icon: '🚀', t: '반등 강해짐', d: `위 기준선 ${C.fmtPrice(x.upKey)}원을 넘었어. 거래량이 같이 붙는지 보자.`, tone: 'good' };
  if (p < x.downKey) return { k: 'down', icon: '🛑', t: '반등 끝 경고', d: `아래 기준선 ${C.fmtPrice(x.downKey)}원이 깨졌어. 이번 반등은 끝났다고 보는 자리야.`, tone: 'bad' };
  if (p >= x.nextR * 0.995) return { k: 'wall', icon: '🧱', t: '첫 벽 도착', d: `${C.fmtPrice(x.nextR)}원 벽에 닿았어. 여기서 자주 밀려. 나눠 팔 생각이 있었다면 이런 자리야.`, tone: 'mid' };
  if (p <= x.nextS * 1.005) return { k: 'floor', icon: '🪨', t: '첫 받침 도착', d: `${C.fmtPrice(x.nextS)}원 받침에 닿았어. 여기서 버티는지 보자.`, tone: 'mid' };
  return { k: 'mid', icon: x.tone === 'good' ? '🙂' : x.tone === 'bad' ? '🧊' : '🤔', t: x.status, d: '기준선 사이에서 움직이는 중이야.', tone: x.tone };
}

function holdOf(m) { return C.getJournal()?.holdings?.[m] || null; }

export function renderHoldings() {
  const box = $('#holdings');
  if (!box || !C) return;
  if (!A) { box.innerHTML = '<p class="note">보유 코인 분석 불러오는 중…</p>'; return; }
  const cards = Object.entries(A.coins).map(([m, x]) => {
    const p = C.state.tickers[m]?.trade_price ?? x.price;
    const z = zoneOf(x, p);
    // 구간이 바뀌면 알림
    if (zones[m] && zones[m] !== z.k && ['up', 'down', 'wall', 'floor'].includes(z.k)) notify(`${C.sym(m)} ${z.icon} ${z.t}`, `${C.fmtPrice(p)}원 · ${z.d}`);
    zones[m] = z.k;

    const h = holdOf(m);
    const pnl = h?.avg ? p / h.avg - 1 : null;
    const won = h?.avg && h?.qty ? (p - h.avg) * h.qty : null;
    const toEven = h?.avg ? h.avg / p - 1 : null;
    // 아래 기준선 ~ 위 기준선 막대
    const lo = x.downKey * 0.97, hi = x.upKey * 1.03;
    const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const hist = (x.history || []).slice(-7).map((d) => `<span class="hdot ${d.tone}" title="${d.date} ${esc(d.status)} ${C.fmtPrice(d.price)}"></span>`).join('');
    const chg = (v) => (v == null ? '-' : C.pct(v));
    return `<div class="hold t-${z.tone}">
      <div class="hold-h">
        <div><b>${C.sym(m)}</b> <small>${esc(x.name)}</small>
          <div class="hold-p">${C.fmtPrice(p)}원 <span class="small">오늘 ${C.pct(C.state.tickers[m]?.signed_change_rate ?? x.chg.d1)}</span></div></div>
        <div class="hold-z"><span class="zpill ${z.tone}">${z.icon} ${esc(z.t)}</span>
          ${pnl != null ? `<div class="hold-pnl">${C.pct(pnl)}${won != null ? `<small>${won >= 0 ? '+' : ''}${Math.round(won).toLocaleString('ko-KR')}원</small>` : ''}</div>` : ''}</div>
      </div>
      <p class="hold-d">${esc(z.d)}</p>
      <div class="gauge"><div class="g-track"></div>
        <i class="g-mark down" style="left:${pos(x.downKey)}%"></i><i class="g-mark s" style="left:${pos(x.nextS)}%"></i>
        <i class="g-mark r" style="left:${pos(x.nextR)}%"></i><i class="g-mark up" style="left:${pos(x.upKey)}%"></i>
        <i class="g-now" style="left:${pos(p)}%"></i>
      </div>
      <div class="g-lbl"><span class="gl-bad">깨지면 끝<br><b>${C.fmtPrice(x.downKey)}</b></span><span>받침<br><b>${C.fmtPrice(x.nextS)}</b></span><span>벽<br><b>${C.fmtPrice(x.nextR)}</b></span><span class="gl-good">넘으면 강세<br><b>${C.fmtPrice(x.upKey)}</b></span></div>
      <div class="hold-chg"><span>7일 ${chg(x.chg.d7)}</span><span>30일 ${chg(x.chg.d30)}</span><span>RSI ${x.rsi.toFixed(0)}</span>${toEven != null ? `<span>본전까지 <b>${C.pctPlain(toEven)}</b></span>` : ''}<span class="hist">최근 ${hist}</span></div>
      <details class="checkbox-detail" data-k="${m}"><summary>오늘의 차트 분석</summary>
        <ul class="hold-c">${x.comments.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <p class="small flat">최고가 ${C.fmtPrice(x.hiAll)}원(${x.hiAllDate}) · 최저가 ${C.fmtPrice(x.loAll)}원(${x.loAllDate})</p>
        <p class="small flat">비슷하게 움직인 코인: ${x.similar.map((s) => `${C.sym(s.m)}(${esc(s.name)})`).join(', ')} — 같이 움직였을 뿐 앞으로도 같다는 보장은 없어.</p>
      </details>
      <div class="pick-btns">
        <button type="button" class="ghostbtn" data-coach="chart" data-m="${m}">차트</button>
        <button type="button" class="ghostbtn" data-hold="edit" data-m="${m}">${h ? '평단 수정' : '평단 입력'}</button>
      </div>
    </div>`;
  }).join('');
  const t = new Date(A.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const canNotify = 'Notification' in window;
  const notifOn = canNotify && Notification.permission === 'granted';
  const opened = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.k));
  box.innerHTML = `<div class="sec-h" style="margin-top:0"><h3>📌 내 보유 코인</h3><span class="note small">차트 분석 ${t} · 하루 4번 갱신 · 가격은 실시간
    ${canNotify ? (notifOn ? ' · 🔔 알림 켜짐' : ` · <button type="button" class="linkbtn" data-hold="notify">🔔 기준선 알림 켜기</button>`) : ''}</span></div>
    <div class="holds">${cards}</div>`;
  box.querySelectorAll('details[data-k]').forEach((d) => { if (opened.has(d.dataset.k)) d.open = true; });
}

// ---------- 알림 ----------
async function askNotify() {
  if (!('Notification' in window)) return;
  const r = await Notification.requestPermission();
  if (r === 'granted') notify('알림 켜짐', '기준선에 닿으면 알려줄게. 이 페이지가 열려 있을 때만 동작해.');
  renderHoldings();
}
function notify(title, body) {
  toast(`${title} — ${body}`);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      if (navigator.serviceWorker?.ready) navigator.serviceWorker.ready.then((sw) => sw.showNotification(title, { body })).catch(() => new Notification(title, { body }));
      else new Notification(title, { body });
    }
  } catch {}
}
function toast(text) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.className = 'show';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 8000);
}

// ---------- 평단/수량 (비공개 일지에 저장) ----------
function openEdit(m) {
  if (!C.getJournal()) { alert('아래에서 일지 코드를 먼저 연결해줘. 평단은 내 일지에만 비공개로 저장돼.'); $('#jConnect')?.scrollIntoView({ behavior: 'smooth' }); return; }
  const f = $('#holdForm'), h = holdOf(m) || {};
  f.m.value = m; f.avg.value = h.avg || ''; f.qty.value = h.qty || '';
  $('#holdTitle').textContent = `${C.sym(m)} 평단·수량`;
  $('#holdDlg').showModal();
}
async function onSave(e) {
  e.preventDefault();
  const f = e.target, j = C.getJournal();
  j.holdings ||= {};
  const avg = +f.avg.value, qty = +f.qty.value;
  if (avg > 0) j.holdings[f.m.value] = { avg, qty: qty > 0 ? qty : null };
  else delete j.holdings[f.m.value];
  $('#holdDlg').close();
  renderHoldings();
  await C.saveJournal();
}
