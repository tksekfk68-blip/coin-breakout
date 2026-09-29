// 실시간 시황 숫자 + 헤드라인: /api/pulse (Cloudflare Pages Functions, 5분 캐시)
// 공포·탐욕 지수, 전체 시총/도미넌스, 환율, 김치 프리미엄, 뉴스 헤드라인(RSS)
const j = async (url, ms = 6000) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'coin-radar/1.0' } });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
};
const txt = async (url, ms = 6000) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 coin-radar' } });
    if (!r.ok) throw new Error(r.status);
    return await r.text();
  } finally { clearTimeout(t); }
};

const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
function parseRss(xml, source, n = 8) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = decode((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const link = decode((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const date = decode((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    const src = decode((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '') || source;
    if (title && link) items.push({ title, link, date: date ? new Date(date).toISOString() : null, source: src });
    if (items.length >= n) break;
  }
  return items;
}

// 카테고리별로 여러 출처를 순서대로 시도 (서버 위치에 따라 막히는 곳이 있어서)
const FEEDS = [
  { key: 'coinKo', urls: [
    ['https://www.blockmedia.co.kr/feed', '블록미디어'],
    ['https://www.tokenpost.kr/rss', '토큰포스트'],
    ['https://news.google.com/rss/search?q=%EB%B9%84%ED%8A%B8%EC%BD%94%EC%9D%B8+when:1d&hl=ko&gl=KR&ceid=KR:ko', '구글 뉴스'],
  ] },
  { key: 'macroKo', urls: [
    ['https://www.yna.co.kr/rss/economy.xml', '연합뉴스'],
    ['https://www.hankyung.com/feed/economy', '한국경제'],
    ['https://news.google.com/rss/search?q=%ED%99%98%EC%9C%A8+OR+%EC%97%B0%EC%A4%80+when:1d&hl=ko&gl=KR&ceid=KR:ko', '구글 뉴스'],
  ] },
  { key: 'coinEn', urls: [['https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk']] },
];
async function firstFeed(f) {
  for (const [url, source] of f.urls) {
    try { const items = parseRss(await txt(url), source); if (items.length) return items; } catch {}
  }
  throw new Error('no feed ' + f.key);
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const ck = new Request(new URL('/api/pulse', request.url).toString());
  const hit = await cache.match(ck);
  if (hit) return hit;
  const out = { at: new Date().toISOString() };
  const tasks = [
    j('https://api.alternative.me/fng/?limit=8').then((d) => {
      out.fng = d.data.map((x) => ({ v: +x.value, label: x.value_classification, t: +x.timestamp }));
    }),
    j('https://api.coingecko.com/api/v3/global').then((d) => {
      out.global = { mcapUsd: d.data.total_market_cap.usd, mcapChg24h: d.data.market_cap_change_percentage_24h_usd / 100, btcDom: d.data.market_cap_percentage.btc / 100, ethDom: d.data.market_cap_percentage.eth / 100 };
    }).catch(() => j('https://api.coinpaprika.com/v1/global').then((d) => {
      out.global = { mcapUsd: d.market_cap_usd, mcapChg24h: d.market_cap_change_24h / 100, btcDom: d.bitcoin_dominance_percentage / 100 };
    })),
    j('https://open.er-api.com/v6/latest/USD').then((d) => { out.usdkrw = d.rates.KRW; }),
    j('https://api.coinbase.com/v2/prices/BTC-USD/spot').then((d) => { out.btcUsd = +d.data.amount; })
      .catch(() => j('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then((d) => { out.btcUsd = +Object.values(d.result)[0].c[0]; }))
      .catch(() => j('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then((d) => { out.btcUsd = +d.price; })),
    j('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then((d) => { const t = Object.values(d.result)[0]; out.btcUsdChg = +t.c[0] / +t.o - 1; }).catch(() => {}),
    j('https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-USDT').then((d) => {
      for (const t of d) { if (t.market === 'KRW-BTC') out.btcKrw = t.trade_price; if (t.market === 'KRW-USDT') out.usdtKrw = t.trade_price; }
    }),
    ...FEEDS.map((f) => firstFeed(f).then((items) => { (out.news ||= {})[f.key] = items; })),
  ];
  const settled = await Promise.allSettled(tasks);
  out.errors = settled.filter((r) => r.status === "rejected").length;
  if (out.btcKrw && out.btcUsd && out.usdkrw) out.kimchi = out.btcKrw / (out.btcUsd * out.usdkrw) - 1;
  const res = new Response(JSON.stringify(out), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
  waitUntil(cache.put(ck, res.clone()));
  return res;
}
