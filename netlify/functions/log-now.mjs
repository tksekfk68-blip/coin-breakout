// 수동 실행용: /api/log-now 를 열면 오늘 기록을 바로 저장 (배포 직후 첫 기록용)
import { runDailyLog } from '../lib/log.mjs';

export default async () => {
  const r = await runDailyLog();
  return new Response(JSON.stringify({ ok: true, today: r.today, picks: r.picks }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/log-now' };
