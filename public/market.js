// 📰 시황: 오늘의 브리핑(매일 아침 작성) + 실시간 지표 + 헤드라인
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const market = { briefing: null, pulse: null };
// 브리핑은 매일 GitHub에 올라감 → 넷리파이 재배포 없이 바로 반영
const RAW = 'https://raw.githubusercontent.com/tksekfk68-blip/coin-breakout/main';

export async function loadMarket() {
  const [b, p] = await Promise.allSettled([
    fetch(`${RAW}/public/briefing/latest.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .catch(() => fetch('/briefing/latest.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))),
    fetch('/api/pulse').then((r) => (r.ok ? r.json() : null)),
  ]);
  market.briefing = b.status === 'fulfilled' ? b.value : null;
  market.pulse = p.status === 'fulfilled' ? p.value : null;
  renderMarket();
  return market;
}

const pctS = (x, d = 1) => (x == null ? '-' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
};
const FNG_KO = { 'Extreme Fear': '극단적 공포', Fear: '공포', Neutral: '중립', Greed: '탐욕', 'Extreme Greed': '극단적 탐욕' };

export function renderMarket() {
  const box = $('#newsBody');
  if (!box) return;
  const B = market.briefing, P = market.pulse;

  const brief = !B ? '<p class="note">오늘 브리핑이 아직 없어요.</p>' : `
    <div class="brief">
      <div class="brief-h"><span class="pill ${B.mood === '좋음' ? 't-pullback' : B.mood === '위험' ? 't-hot' : 't-near'}">${esc(B.mood)}</span>
        <span class="flat small">${new Date(B.writtenAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })} 작성 · 매일 아침 갱신</span></div>
      <h2 class="brief-title">${esc(B.title)}</h2>
      <p class="brief-mood">${esc(B.moodNote || '')}</p>
      <div class="brief-cols">
        <div><h4>🪙 코인</h4><ul>${B.coin.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><h4>🌍 경제·금리·환율</h4><ul>${B.macro.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
      <h4>📅 이번 주 챙길 일정 (한국 시간)</h4>
      <div class="tablewrap"><table class="grid"><tbody>${B.events.map((e) => `<tr><td class="nowrap"><b>${esc(e.when)}</b></td><td>${esc(e.what)}<div class="flat small">${esc(e.why)}</div></td></tr>`).join('')}</tbody></table></div>
      <h4>🤝 우리 전략엔 이렇게</h4>
      <ul class="brief-strat">${B.strategy.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <details class="checkbox-detail"><summary>출처 ${B.sources.length}개</summary><ul class="small">${B.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul></details>
    </div>`;

  const tile = (k, v, s = '', c = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
  let tiles = '';
  if (P) {
    const f = P.fng?.[0];
    const fPrev = P.fng?.[1];
    tiles = [
      f ? tile('공포·탐욕 지수', `${f.v}`, `${FNG_KO[f.label] || f.label}${fPrev ? ` · 어제 ${fPrev.v}` : ''}`, f.v <= 25 ? 'down' : f.v >= 75 ? 'up' : '') : '',
      P.btcUsd ? tile('비트코인 (달러)', `$${Math.round(P.btcUsd).toLocaleString('en-US')}`, `24시간 <span class="${cls(P.btcUsdChg)}">${pctS(P.btcUsdChg)}</span>`) : '',
      P.global ? tile('BTC 도미넌스', `${(P.global.btcDom * 100).toFixed(1)}%`, `전체 시총 24시간 <span class="${cls(P.global.mcapChg24h)}">${pctS(P.global.mcapChg24h)}</span>`) : '',
      P.usdkrw ? tile('원/달러 환율', `${P.usdkrw.toFixed(1)}원`, P.usdtKrw ? `업비트 USDT ${Math.round(P.usdtKrw).toLocaleString('ko-KR')}원` : '') : '',
      P.kimchi != null ? tile('김치 프리미엄', pctS(P.kimchi), P.kimchi > 0.03 ? '국내가 비쌈 · 과열 신호' : P.kimchi < -0.01 ? '국내가 쌈 · 역프' : '보통 수준', P.kimchi > 0.03 ? 'up' : '') : '',
    ].join('');
  }

  const newsList = (arr, title) => !arr || !arr.length ? '' : `<div class="news-col"><h4>${title}</h4><ul class="news">${arr.slice(0, 7).map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><span class="flat small">${esc(n.source)} · ${ago(n.date)}</span></li>`).join('')}</ul></div>`;
  const news = P?.news ? `<div class="news-cols">${newsList(P.news.coinKo, '🪙 코인 뉴스')}${newsList(P.news.macroKo, '🌍 경제 뉴스')}${newsList(P.news.coinEn, '🌐 CoinDesk')}</div>` : '';

  box.innerHTML = `${brief}
    <div class="sec-h"><h3>📡 실시간 지표</h3><span class="note small">${P ? `${ago(P.at)} 갱신 · 5분마다` : '불러오는 중…'}</span></div>
    <div class="tiles">${tiles || '<p class="note">지표를 불러오지 못했어요.</p>'}</div>
    <div class="sec-h"><h3>📰 최신 헤드라인</h3><span class="note small">자동 수집 · 제목만 보고 판단하지 말고 원문 확인</span></div>
    ${news || '<p class="note">헤드라인을 불러오지 못했어요.</p>'}`;
}

setInterval(() => { fetch('/api/pulse').then((r) => r.json()).then((p) => { market.pulse = p; renderMarket(); }).catch(() => {}); }, 5 * 60 * 1000);
