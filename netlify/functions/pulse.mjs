// 실시간 시황 숫자 + 헤드라인: /api/pulse
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

const FEEDS = [
  { key: 'coinKo', url: 'https://news.google.com/rss/search?q=%EB%B9%84%ED%8A%B8%EC%BD%94%EC%9D%B8+OR+%EA%B0%80%EC%83%81%EC%9E%90%EC%82%B0+when:1d&hl=ko&gl=KR&ceid=KR:ko', source: '구글 뉴스' },
  { key: 'macroKo', url: 'https://news.google.com/rss/search?q=%ED%99%98%EC%9C%A8+OR+%EC%97%B0%EC%A4%80+OR+%EC%BD%94%EC%8A%A4%ED%94%BC+when:1d&hl=ko&gl=KR&ceid=KR:ko', source: '구글 뉴스' },
  { key: 'coinEn', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
];

export default async () => {
  const out = { at: new Date().toISOString() };
  const tasks = [
    j('https://api.alternative.me/fng/?limit=8').then((d) => {
      out.fng = d.data.map((x) => ({ v: +x.value, label: x.value_classification, t: +x.timestamp }));
    }),
    j('https://api.coingecko.com/api/v3/global').then((d) => {
      out.global = { mcapUsd: d.data.total_market_cap.usd, mcapChg24h: d.data.market_cap_change_percentage_24h_usd / 100, btcDom: d.data.market_cap_percentage.btc / 100, ethDom: d.data.market_cap_percentage.eth / 100 };
    }),
    j('https://open.er-api.com/v6/latest/USD').then((d) => { out.usdkrw = d.rates.KRW; }),
    j('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT').then((d) => { out.btcUsd = +d.lastPrice; out.btcUsdChg = +d.priceChangePercent / 100; })
      .catch(() => j('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true').then((d) => { out.btcUsd = d.bitcoin.usd; out.btcUsdChg = d.bitcoin.usd_24h_change / 100; })),
    j('https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-USDT').then((d) => {
      for (const t of d) { if (t.market === 'KRW-BTC') out.btcKrw = t.trade_price; if (t.market === 'KRW-USDT') out.usdtKrw = t.trade_price; }
    }),
    ...FEEDS.map((f) => txt(f.url).then((x) => { (out.news ||= {})[f.key] = parseRss(x, f.source); })),
  ];
  const res = await Promise.allSettled(tasks);
  out.errors = res.filter((r) => r.status === 'rejected').length;
  if (out.btcKrw && out.btcUsd && out.usdkrw) out.kimchi = out.btcKrw / (out.btcUsd * out.usdkrw) - 1;
  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=120',
      'netlify-cdn-cache-control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
};

export const config = { path: '/api/pulse' };
