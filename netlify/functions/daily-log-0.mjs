// 매일 오전 9시 05분(KST) 자동 실행: 거래대금 상위 코인 중 0번째 묶음 기록
import { runDailyLog } from '../lib/log.mjs';

export default async () => {
  const r = await runDailyLog(0);
  console.log('daily-log part 0', r.today, r.picks.length, 'picks');
};

export const config = { schedule: '05 0 * * *' }; // UTC 00:05 = KST 09:05
