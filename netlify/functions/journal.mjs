// 매매 일지 저장소: /api/journal
//  - 헤더 x-journal-code 에 사용자가 정한 "일지 코드"를 보냄
//  - 서버는 코드를 해시해서 저장 키로만 씀 (코드 자체는 저장하지 않음)
//  GET  → 일지 JSON (없으면 빈 일지)
//  PUT  → 일지 JSON 통째로 저장
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const MAX_BYTES = 300_000;
const res = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default async (req) => {
  const code = (req.headers.get('x-journal-code') || '').trim();
  if (code.length < 6 || code.length > 100) return res({ error: '일지 코드는 6자 이상이어야 해요' }, 400);
  const key = createHash('sha256').update('coin-radar:' + code).digest('hex');
  const store = getStore('journal');

  if (req.method === 'GET') {
    const data = await store.get(key, { type: 'json' });
    return res(data || { v: 1, trades: [], createdAt: new Date().toISOString() });
  }
  if (req.method === 'PUT') {
    const text = await req.text();
    if (text.length > MAX_BYTES) return res({ error: '일지가 너무 커요' }, 413);
    let data;
    try { data = JSON.parse(text); } catch { return res({ error: '잘못된 형식' }, 400); }
    if (!data || !Array.isArray(data.trades)) return res({ error: '잘못된 형식' }, 400);
    data.savedAt = new Date().toISOString();
    await store.setJSON(key, data);
    return res({ ok: true, savedAt: data.savedAt });
  }
  return res({ error: 'method' }, 405);
};

export const config = { path: '/api/journal' };
