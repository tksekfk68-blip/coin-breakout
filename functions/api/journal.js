// 매매 일지 저장소 (Cloudflare KV, 바인딩 이름: JOURNAL)
// 헤더 x-journal-code 의 해시를 키로 사용 (코드 자체는 저장 안 함)
// 처음 열 때 KV에 없으면 예전 넷리파이 사이트에서 같은 코드로 불러와 옮겨옴
const OLD = 'https://dulcet-sawine-e21b80.netlify.app/api/journal';
const MAX = 300000;
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function keyOf(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('coin-radar:' + code));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest({ request, env }) {
  if (!env.JOURNAL) return json({ error: '서버 설정 필요: KV 바인딩 JOURNAL 이 없어요' }, 500);
  const code = (request.headers.get('x-journal-code') || '').trim();
  if (code.length < 6 || code.length > 100) return json({ error: '일지 코드는 6자 이상이어야 해요' }, 400);
  const key = await keyOf(code);

  if (request.method === 'GET') {
    const got = await env.JOURNAL.get(key, 'json');
    if (got) return json(got);
    // 예전 넷리파이 일지 옮겨오기
    try {
      const r = await fetch(OLD, { headers: { 'x-journal-code': code } });
      if (r.ok) {
        const old = await r.json();
        if (old && Array.isArray(old.trades) && (old.trades.length || old.settings)) {
          old.migratedAt = new Date().toISOString();
          await env.JOURNAL.put(key, JSON.stringify(old));
          return json(old);
        }
      }
    } catch {}
    return json({ v: 1, trades: [], createdAt: new Date().toISOString() });
  }
  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX) return json({ error: '일지가 너무 커요' }, 413);
    let data;
    try { data = JSON.parse(text); } catch { return json({ error: '잘못된 형식' }, 400); }
    if (!data || !Array.isArray(data.trades)) return json({ error: '잘못된 형식' }, 400);
    data.savedAt = new Date().toISOString();
    await env.JOURNAL.put(key, JSON.stringify(data));
    return json({ ok: true, savedAt: data.savedAt });
  }
  return json({ error: 'method' }, 405);
}
