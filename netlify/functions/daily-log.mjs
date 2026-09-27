// 매일 오전 9시 5분(KST)에 자동 실행: 어제 마감 캔들 기준 신호를 저장
import { runDailyLog } from '../lib/log.mjs';

export default async () => {
  const r = await runDailyLog();
  console.log('daily-log', r.today, r.picks.length, 'picks');
};

export const config = { schedule: '5 0 * * *' }; // UTC 00:05 = KST 09:05
