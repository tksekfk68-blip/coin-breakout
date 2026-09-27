// 수동 실행용: /api/log-now?part=0~3 을 열면 해당 묶음의 오늘 기록을 바로 저장
import { runDailyLog } from '../lib/log.mjs';

export default async (req) => {
  const part = Math.min(3, Math.max(0, parseInt(new URL(req.url).searchParams.get('part') || '0', 10) || 0));
  const r = await runDailyLog(part);
  return new Response(JSON.stringify({ ok: true, today: r.today, part, universe: r.universe, picks: r.picks }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/log-now' };
